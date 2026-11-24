import type { Request } from 'express';
import { config } from '../../config.js';
import { systemDb, withSystem, type Db } from '../../db/pool.js';
import { AppError, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { paymentProvider, testProvider, type PaymentProvider } from '../../integrations/payments.js';
import { invalidateEntitlements } from './entitlements.js';
import { logger } from '../../logger.js';
import { enqueue } from '../../jobs/queue.js';

/**
 * NEXUS SaaS billing: what a TENANT pays NEXUS. Entirely separate from the money a tenant collects
 * from its own customers (payments module). Uses platform-level gateway credentials from env.
 */
export function billingProvider(): PaymentProvider | null {
  switch (config.BILLING_PROVIDER) {
    case 'test': return testProvider;
    case 'stripe': return paymentProvider({ kind: 'payment', provider: 'stripe', mode: 'live', enabled: true, config: { publishableKey: config.BILLING_KEY_ID },
      secrets: { secretKey: config.BILLING_SECRET_KEY ?? '', webhookSecret: config.BILLING_WEBHOOK_SECRET ?? '' } });
    case 'razorpay': return paymentProvider({ kind: 'payment', provider: 'razorpay', mode: 'live', enabled: true, config: { keyId: config.BILLING_KEY_ID },
      secrets: { keySecret: config.BILLING_SECRET_KEY ?? '', webhookSecret: config.BILLING_WEBHOOK_SECRET ?? '' } });
    default: return null; // manual: invoices are settled by NEXUS staff (bank transfer)
  }
}

async function event(db: Db, sub: any, type: string, extra: { fromPlan?: string | null; toPlan?: string | null; amount?: number | null; details?: object; actorId?: string | null } = {}) {
  await db.query(`INSERT INTO subscription_events (tenant_id, subscription_id, event_type, from_plan_id, to_plan_id, amount, currency, details, actor_id)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [sub.tenant_id, sub.id, type, extra.fromPlan ?? null, extra.toPlan ?? null, extra.amount ?? null, sub.currency,
      JSON.stringify(extra.details ?? {}), extra.actorId ?? null]);
}

const addPeriod = (from: Date, cycle: string) => { const d = new Date(from); if (cycle === 'annual') d.setFullYear(d.getFullYear() + 1); else d.setMonth(d.getMonth() + 1); return d; };

/** Opens a subscription invoice for the next period and returns a checkout URL (if a gateway is configured). */
export async function openSubscriptionInvoice(db: Db, tenantId: string, opts: { planId?: string; cycle?: 'monthly' | 'annual' } = {}) {
  const sub = await db.one(`SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
  const plan = await db.one(`SELECT * FROM subscription_plans WHERE id = $1`, [opts.planId ?? sub.pending_plan_id ?? sub.plan_id]);
  const cycle = opts.cycle ?? sub.billing_cycle;
  const amount = Number(cycle === 'annual' ? plan.annual_price : plan.monthly_price);
  if (plan.code === 'enterprise' && amount === 0) throw new AppError(422, 'CONTACT_SALES', 'Enterprise plans are priced individually. Contact NEXUS sales.');
  const existing = await db.maybeOne(`SELECT * FROM subscription_invoices WHERE subscription_id = $1 AND status = 'open' AND plan_id = $2 ORDER BY created_at DESC LIMIT 1`, [sub.id, plan.id]);
  const start = sub.status === 'active' && new Date(sub.current_period_end) > new Date() ? new Date(sub.current_period_end) : new Date();
  const inv = existing ?? await db.one(`INSERT INTO subscription_invoices (tenant_id, subscription_id, number, plan_id, period_start, period_end, amount, currency, status)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open') RETURNING *`,
    [tenantId, sub.id, `NX-${Date.now().toString(36).toUpperCase()}`, plan.id, start, addPeriod(start, cycle), amount, plan.currency]);
  if (cycle !== sub.billing_cycle) await db.query(`UPDATE subscriptions SET billing_cycle = $2 WHERE id = $1`, [sub.id, cycle]);
  if (amount === 0) { await markSubscriptionInvoicePaid(db, inv.id, 'free'); return { invoice: { ...inv, status: 'paid' }, checkoutUrl: null }; }
  const provider = billingProvider();
  let checkoutUrl: string | null = null;
  if (provider) {
    const t = await db.one(`SELECT email FROM tenants WHERE id = $1`, [tenantId]);
    const c = await provider.createCheckout({ intentId: inv.id, amount, currency: plan.currency, description: `NEXUS ServiceFlow ${plan.name} (${cycle})`,
      customerEmail: t.email, returnUrl: `${config.APP_URL}/app/subscription?checkout=return` });
    checkoutUrl = provider.name === 'test' ? `${config.APP_URL}/pay/test/billing/${inv.id}` : c.checkoutUrl;
    await db.query(`UPDATE subscription_invoices SET provider_invoice_id = $2 WHERE id = $1`, [inv.id, c.providerOrderId]);
  }
  return { invoice: inv, checkoutUrl };
}

/** Activates/renews the paid period. Idempotent: an already-paid invoice is a no-op. */
export async function markSubscriptionInvoicePaid(db: Db, invoiceId: string, reference: string, actorId: string | null = null) {
  const inv = await db.maybeOne(`SELECT * FROM subscription_invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  if (!inv) throw notFound('Subscription invoice');
  if (inv.status === 'paid') return inv;
  await db.query(`UPDATE subscription_invoices SET status = 'paid', paid_at = now(), provider_invoice_id = COALESCE(provider_invoice_id, $2) WHERE id = $1`, [inv.id, reference]);
  const sub = await db.one(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [inv.subscription_id]);
  const plan = await db.one(`SELECT * FROM subscription_plans WHERE id = $1`, [inv.plan_id]);
  const wasActive = sub.status === 'active';
  await db.query(`UPDATE subscriptions SET status = 'active', plan_id = $2, price = $3, currency = $4, current_period_start = $5, current_period_end = $6,
      trial_ends_at = CASE WHEN status = 'trialing' THEN LEAST(trial_ends_at, now()) ELSE trial_ends_at END, grace_period_ends_at = NULL, pending_plan_id = NULL,
      cancel_at_period_end = false WHERE id = $1`, [sub.id, plan.id, inv.amount, inv.currency, inv.period_start, inv.period_end]);
  await db.query(`UPDATE tenants SET status = 'active' WHERE id = $1 AND status = 'suspended' AND suspended_reason = 'subscription'`, [sub.tenant_id]);
  await event(db, sub, wasActive ? (plan.id === sub.plan_id ? 'renewed' : 'plan_changed') : 'activated', { fromPlan: sub.plan_id, toPlan: plan.id, amount: Number(inv.amount), actorId,
    details: { invoice: inv.number, reference } });
  invalidateEntitlements(sub.tenant_id);
  return inv;
}

export async function markSubscriptionInvoiceFailed(db: Db, invoiceId: string, reason: string) {
  const inv = await db.maybeOne(`SELECT * FROM subscription_invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  if (!inv || inv.status !== 'open') return;
  await db.query(`UPDATE subscription_invoices SET attempt_count = attempt_count + 1, failure_reason = $2 WHERE id = $1`, [inv.id, reason]);
  const sub = await db.one(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [inv.subscription_id]);
  if (sub.status === 'active') {
    await db.query(`UPDATE subscriptions SET status = 'past_due' WHERE id = $1`, [sub.id]);
    await event(db, sub, 'payment_failed', { amount: Number(inv.amount), details: { reason, invoice: inv.number } });
    invalidateEntitlements(sub.tenant_id);
  }
}

export async function changePlan(db: Db, req: Request, tenantId: string, planCode: string, cycle: 'monthly' | 'annual') {
  const sub = await db.one(`SELECT s.*, p.code, p.monthly_price, p.sort_order FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = $1 FOR UPDATE OF s`, [tenantId]);
  const plan = await db.maybeOne(`SELECT * FROM subscription_plans WHERE code = $1 AND is_active`, [planCode]);
  if (!plan) throw notFound('Plan');
  if (!plan.is_public && plan.code !== sub.code) throw new AppError(422, 'CONTACT_SALES', 'Contact NEXUS to move to this plan');
  // Downgrades must fit the new plan's limits
  const usage = await db.one(`SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND user_type = 'staff' AND is_active)::int AS users,
      (SELECT count(*) FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.tenant_id = $1 AND u.is_active AND tp.employment_status <> 'terminated')::int AS technicians,
      (SELECT count(*) FROM branches WHERE tenant_id = $1 AND is_active)::int AS branches`, [tenantId]);
  const over: string[] = [];
  if (plan.max_users != null && usage.users > plan.max_users) over.push(`${usage.users} active users (limit ${plan.max_users})`);
  if (plan.max_technicians != null && usage.technicians > plan.max_technicians) over.push(`${usage.technicians} technicians (limit ${plan.max_technicians})`);
  if (usage.branches > plan.max_branches) over.push(`${usage.branches} branches (limit ${plan.max_branches})`);
  if (over.length) throw new AppError(422, 'PLAN_LIMIT', `Reduce usage before switching to ${plan.name}: ${over.join(', ')}`, { over });
  const isDowngrade = plan.sort_order < sub.sort_order;
  if (sub.status === 'trialing') {
    await db.query(`UPDATE subscriptions SET plan_id = $2, billing_cycle = $3, price = $4 WHERE id = $1`, [sub.id, plan.id, cycle, cycle === 'annual' ? plan.annual_price : plan.monthly_price]);
    await event(db, sub, 'trial_plan_changed', { fromPlan: sub.plan_id, toPlan: plan.id, actorId: req.auth!.userId });
    invalidateEntitlements(tenantId);
    await audit(db, req, { action: 'subscription.plan_changed', entityType: 'subscription', entityId: sub.id, before: { plan: sub.code }, after: { plan: plan.code, cycle } }, { tenantId });
    return { scheduled: false, checkoutUrl: null };
  }
  if (isDowngrade && sub.status === 'active') {
    await db.query(`UPDATE subscriptions SET pending_plan_id = $2 WHERE id = $1`, [sub.id, plan.id]);
    await event(db, sub, 'downgrade_scheduled', { fromPlan: sub.plan_id, toPlan: plan.id, actorId: req.auth!.userId, details: { effective: sub.current_period_end } });
    await audit(db, req, { action: 'subscription.downgrade_scheduled', entityType: 'subscription', entityId: sub.id, after: { plan: plan.code, effective: sub.current_period_end } }, { tenantId });
    return { scheduled: true, effective: sub.current_period_end, checkoutUrl: null };
  }
  const { checkoutUrl, invoice } = await openSubscriptionInvoice(db, tenantId, { planId: plan.id, cycle });
  await audit(db, req, { action: 'subscription.upgrade_requested', entityType: 'subscription', entityId: sub.id, after: { plan: plan.code, cycle, invoice: invoice.number } }, { tenantId });
  return { scheduled: false, checkoutUrl, invoiceId: invoice.id };
}

export async function cancelSubscription(db: Db, req: Request, tenantId: string, reason: string) {
  const sub = await db.one(`SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, [tenantId]);
  if (['cancelled', 'expired'].includes(sub.status)) throw conflict('The subscription is already cancelled');
  if (sub.status === 'trialing') {
    await db.query(`UPDATE subscriptions SET status = 'cancelled', cancelled_at = now() WHERE id = $1`, [sub.id]);
  } else {
    await db.query(`UPDATE subscriptions SET cancel_at_period_end = true, cancelled_at = now() WHERE id = $1`, [sub.id]);
  }
  await event(db, sub, 'cancellation_requested', { actorId: req.auth!.userId, details: { reason, effective: sub.status === 'trialing' ? 'now' : sub.current_period_end } });
  await audit(db, req, { action: 'subscription.cancelled', entityType: 'subscription', entityId: sub.id, after: { reason } }, { tenantId });
  invalidateEntitlements(tenantId);
}

/** Daily lifecycle: trial expiry, renewals, downgrades at period end, grace period and suspension. */
export async function runSubscriptionLifecycle() {
  const due = await systemDb.many(`SELECT * FROM subscriptions WHERE
      (status = 'trialing' AND trial_ends_at < now()) OR (status = 'active' AND current_period_end < now())
      OR (status = 'past_due') OR (status = 'grace_period' AND grace_period_ends_at < now())`);
  for (const s of due) {
    try {
      await withSystem(async (db) => {
        const sub = await db.one(`SELECT * FROM subscriptions WHERE id = $1 FOR UPDATE`, [s.id]);
        if (sub.status === 'trialing' && new Date(sub.trial_ends_at) < new Date()) {
          await db.query(`UPDATE subscriptions SET status = 'expired' WHERE id = $1`, [sub.id]);
          await event(db, sub, 'trial_expired');
        } else if (sub.status === 'active' && new Date(sub.current_period_end) < new Date()) {
          if (sub.cancel_at_period_end) {
            await db.query(`UPDATE subscriptions SET status = 'cancelled' WHERE id = $1`, [sub.id]);
            await event(db, sub, 'cancelled');
          } else {
            const plan = sub.pending_plan_id ?? sub.plan_id;
            const r = await openSubscriptionInvoice(db, sub.tenant_id, { planId: plan }).catch(() => null);
            if (r?.invoice?.status !== 'paid') {
              await db.query(`UPDATE subscriptions SET status = 'grace_period', grace_period_ends_at = now() + ($2 || ' days')::interval WHERE id = $1`, [sub.id, String(config.BILLING_GRACE_DAYS)]);
              await event(db, sub, 'grace_started', { details: { days: config.BILLING_GRACE_DAYS } });
              const owner = await db.maybeOne(`SELECT u.email FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.tenant_id = $1 AND r.key = 'owner' LIMIT 1`, [sub.tenant_id]);
              if (owner) await enqueue(db, 'send_system_email', { to: owner.email, subject: 'Action required: renew your NEXUS ServiceFlow subscription',
                text: `Your subscription period has ended. Please renew within ${config.BILLING_GRACE_DAYS} days to avoid interruption: ${config.APP_URL}/app/subscription` });
            }
          }
        } else if (sub.status === 'past_due') {
          await db.query(`UPDATE subscriptions SET status = 'grace_period', grace_period_ends_at = now() + ($2 || ' days')::interval WHERE id = $1`, [sub.id, String(config.BILLING_GRACE_DAYS)]);
          await event(db, sub, 'grace_started');
        } else if (sub.status === 'grace_period') {
          await db.query(`UPDATE subscriptions SET status = 'suspended' WHERE id = $1`, [sub.id]);
          await event(db, sub, 'suspended', { details: { reason: 'non-payment' } });
        }
        invalidateEntitlements(sub.tenant_id);
      });
    } catch (err) { logger.error({ err, sub: s.id }, 'subscription lifecycle failed'); }
  }
}

export async function handleBillingWebhook(providerName: string, raw: Buffer, headers: Record<string, string | undefined>) {
  const provider = billingProvider();
  if (!provider || provider.name !== providerName) return { status: 404, body: { error: 'Billing provider not configured' } };
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  if (!provider.verifyWebhook(raw, lower)) return { status: 401, body: { error: 'Invalid signature' } };
  const e = provider.parseWebhook(raw, lower);
  const fresh = await systemDb.maybeOne(`INSERT INTO webhook_events (provider, event_id, event_type, payload, signature_valid) VALUES ($1,$2,$3,$4,true)
    ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [`billing:${provider.name}`, e.eventId, e.type, raw.toString('utf8')]);
  if (!fresh) return { status: 200, body: { duplicate: true } };
  const invoiceId = e.intentId ?? (await systemDb.maybeOne(`SELECT id FROM subscription_invoices WHERE provider_invoice_id = $1`, [e.providerOrderId ?? '']))?.id;
  if (invoiceId) {
    await withSystem(async (db) => {
      if (e.type === 'payment.succeeded') await markSubscriptionInvoicePaid(db, invoiceId, e.providerPaymentId ?? e.eventId);
      if (e.type === 'payment.failed') await markSubscriptionInvoiceFailed(db, invoiceId, e.failureReason ?? 'Payment failed');
    });
  }
  await systemDb.query(`UPDATE webhook_events SET processed_at = now() WHERE provider = $1 AND event_id = $2`, [`billing:${provider.name}`, e.eventId]);
  return { status: 200, body: { received: true } };
}
export { unprocessable };

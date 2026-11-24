import type { Request } from 'express';
import type { Db } from '../../db/pool.js';
import { AppError, badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { recomputeInvoice } from '../invoices/service.js';
import { notify } from '../notifications/service.js';
import { getIntegration } from '../../integrations/registry.js';
import { paymentProvider, type WebhookEvent } from '../../integrations/payments.js';
import { fmtMoney, tenantSettings } from '../common.js';
import { config } from '../../config.js';
import { round2 } from '../../lib/money.js';

const PAYABLE = ['issued', 'partially_paid', 'overdue', 'partially_refunded'];

export interface ManualPayment {
  invoiceId: string; amount: number; method: 'cash' | 'bank_transfer' | 'card' | 'upi' | 'cheque' | 'other';
  reference?: string | null; receivedAt?: string | null; notes?: string | null; status?: 'succeeded' | 'pending'; idempotencyKey?: string | null;
}

/** Records an offline payment. Overpayment and duplicate submissions (same idempotency key) are rejected. */
export async function recordPayment(db: Db, req: Request | null, p: ManualPayment) {
  if (p.idempotencyKey) {
    const existing = await db.maybeOne(`SELECT * FROM payments WHERE idempotency_key = $1`, [p.idempotencyKey]);
    if (existing) {
      if (existing.invoice_id !== p.invoiceId || Number(existing.amount) !== round2(p.amount)) throw conflict('This idempotency key was already used for a different payment');
      return { payment: existing, duplicate: true };
    }
  }
  const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [p.invoiceId]);
  if (!inv) throw notFound('Invoice');
  if (!PAYABLE.includes(inv.status)) throw unprocessable(`Payments cannot be recorded against a ${inv.status.replace('_', ' ')} invoice`);
  const pendingSum = Number((await db.one(`SELECT COALESCE(sum(amount),0) s FROM payments WHERE invoice_id = $1 AND status = 'pending'`, [inv.id])).s);
  if (round2(p.amount) > round2(Number(inv.balance_due) - pendingSum) + 0.001) {
    throw unprocessable(`Amount exceeds the outstanding balance of ${fmtMoney(Number(inv.balance_due) - pendingSum, inv.currency)}`);
  }
  const status = p.status ?? 'succeeded';
  const payment = await db.one(
    `INSERT INTO payments (tenant_id, invoice_id, customer_id, receipt_number, amount, currency, method, status, reference, received_at, notes, recorded_by, idempotency_key, provider)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,COALESCE($10::timestamptz, now()),$11,$12,$13,'manual') RETURNING *`,
    [db.tenantId, inv.id, inv.customer_id, status === 'succeeded' ? await nextNumber(db, 'receipt') : null, round2(p.amount), inv.currency, p.method, status,
      p.reference ?? null, p.receivedAt ?? null, p.notes ?? null, req?.auth?.userId ?? null, p.idempotencyKey ?? null]);
  await recomputeInvoice(db, req, inv.id);
  await audit(db, req, { action: 'payment.recorded', entityType: 'payment', entityId: payment.id, after: { invoice: inv.number, amount: payment.amount, method: p.method, status } });
  if (status === 'succeeded') await paymentReceivedNotice(db, payment, inv);
  return { payment, duplicate: false };
}

async function paymentReceivedNotice(db: Db, payment: any, inv: any) {
  const s = await tenantSettings(db);
  await notify(db, { event: 'payment.received', customerId: inv.customer_id, entityType: 'payment', entityId: payment.id, dedupeKey: `paid:${payment.id}`,
    vars: { payment: { amount: fmtMoney(payment.amount, payment.currency, s.locale), receipt_number: payment.receipt_number }, invoice: { number: inv.number } } });
}

/** Confirms or fails a pending (e.g. cheque) payment. */
export async function settlePending(db: Db, req: Request, paymentId: string, outcome: 'succeeded' | 'failed', reason?: string | null) {
  const p = await db.maybeOne(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  if (!p) throw notFound('Payment');
  if (p.status !== 'pending') throw unprocessable('Only pending payments can be confirmed or failed');
  const updated = await db.one(`UPDATE payments SET status = $2, failure_reason = $3, receipt_number = CASE WHEN $2 = 'succeeded' THEN $4 ELSE NULL END WHERE id = $1 RETURNING *`,
    [p.id, outcome, reason ?? null, outcome === 'succeeded' ? await nextNumber(db, 'receipt') : null]);
  const inv = await recomputeInvoice(db, req, p.invoice_id);
  await audit(db, req, { action: `payment.${outcome}`, entityType: 'payment', entityId: p.id, before: { status: 'pending' }, after: { status: outcome, reason } });
  if (outcome === 'succeeded') await paymentReceivedNotice(db, updated, inv);
  return updated;
}

/** Creates (or reuses) a hosted checkout with the tenant's configured gateway. */
export async function createPaymentLink(db: Db, invoiceId: string) {
  const inv = await db.maybeOne(`SELECT i.*, c.email FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.id = $1`, [invoiceId]);
  if (!inv) throw notFound('Invoice');
  if (!PAYABLE.includes(inv.status) || Number(inv.balance_due) <= 0) throw unprocessable('This invoice has no outstanding balance');
  const integ = await getIntegration(db.tenantId!, 'payment');
  const provider = paymentProvider(integ);
  if (!provider) throw new AppError(422, 'PAYMENTS_NOT_CONFIGURED', 'Online payments are not configured for this business');
  const amount = Number(inv.balance_due);
  const reusable = await db.maybeOne(`SELECT * FROM payment_intents WHERE invoice_id = $1 AND status = 'created' AND amount = $2 AND provider = $3
    AND created_at > now() - interval '12 hours' ORDER BY created_at DESC LIMIT 1`, [inv.id, amount, provider.name]);
  if (reusable?.checkout_url) return { intentId: reusable.id, checkoutUrl: reusable.checkout_url, provider: provider.name, mode: integ!.mode };
  const intent = await db.one(`INSERT INTO payment_intents (tenant_id, invoice_id, provider, provider_order_id, amount, currency) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [db.tenantId, inv.id, provider.name, `pending_${crypto.randomUUID()}`, amount, inv.currency]);
  const s = await tenantSettings(db);
  const checkout = await provider.createCheckout({ intentId: intent.id, amount, currency: inv.currency, description: `${s.business_name} — Invoice ${inv.number}`,
    customerEmail: inv.email, returnUrl: `${config.APP_URL}/i/${inv.public_token}?payment=return` });
  await db.query(`UPDATE payment_intents SET provider_order_id = $2, checkout_url = $3 WHERE id = $1`, [intent.id, checkout.providerOrderId, checkout.checkoutUrl]);
  return { intentId: intent.id, checkoutUrl: checkout.checkoutUrl, provider: provider.name, mode: integ!.mode };
}

/**
 * Applies a VERIFIED gateway event. Idempotent at three levels: webhook_events(provider,event_id),
 * payments(provider, provider_payment_id) and the intent status. Never trusts browser redirects.
 */
export async function applyGatewayEvent(db: Db, provider: string, e: WebhookEvent) {
  if (e.type === 'payment.succeeded' || e.type === 'payment.failed') {
    const intent = await db.maybeOne(`SELECT * FROM payment_intents WHERE provider = $1 AND (id::text = $2 OR provider_order_id = $3) FOR UPDATE`,
      [provider, e.intentId ?? '', e.providerOrderId ?? '']);
    if (!intent) return { applied: false, reason: 'intent not found' };
    if (e.type === 'payment.failed') {
      if (intent.status !== 'created') return { applied: false, reason: 'intent already settled' };
      await db.query(`UPDATE payment_intents SET status = 'failed' WHERE id = $1`, [intent.id]);
      const inv = await db.one(`SELECT * FROM invoices WHERE id = $1`, [intent.invoice_id]);
      await db.query(`INSERT INTO payments (tenant_id, invoice_id, customer_id, amount, currency, method, status, provider, provider_payment_id, payment_intent_id, failure_reason)
        VALUES ($1,$2,$3,$4,$5,'gateway','failed',$6,$7,$8,$9) ON CONFLICT DO NOTHING`,
        [db.tenantId, inv.id, inv.customer_id, intent.amount, intent.currency, provider, e.providerPaymentId ? `${e.providerPaymentId}:failed` : null, intent.id, e.failureReason ?? 'Payment failed']);
      await audit(db, null, { action: 'payment.failed', entityType: 'invoice', entityId: inv.id, after: { provider, reason: e.failureReason } });
      await notify(db, { event: 'payment.failed', customerId: inv.customer_id, entityType: 'invoice', entityId: inv.id, dedupeKey: `payfail:${intent.id}`,
        vars: { invoice: { number: inv.number }, links: { invoice: `${config.APP_URL}/i/${inv.public_token}` } } });
      return { applied: true };
    }
    if (!e.providerPaymentId) throw badRequest('Missing provider payment id');
    const existing = await db.maybeOne(`SELECT id FROM payments WHERE provider = $1 AND provider_payment_id = $2`, [provider, e.providerPaymentId]);
    if (existing) return { applied: false, reason: 'duplicate payment' };
    if (e.currency && e.currency !== intent.currency) throw badRequest('Currency mismatch');
    const inv = await db.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [intent.invoice_id]);
    const amount = round2(e.amount ?? Number(intent.amount));
    const payment = await db.one(`INSERT INTO payments (tenant_id, invoice_id, customer_id, receipt_number, amount, currency, method, status, provider, provider_payment_id, payment_intent_id, notes)
      VALUES ($1,$2,$3,$4,$5,$6,'gateway','succeeded',$7,$8,$9,$10) RETURNING *`,
      [db.tenantId, inv.id, inv.customer_id, await nextNumber(db, 'receipt'), amount, intent.currency, provider, e.providerPaymentId, intent.id,
        inv.status === 'cancelled' || amount > Number(inv.balance_due) ? 'Received against a settled/cancelled invoice — review for refund' : null]);
    await db.query(`UPDATE payment_intents SET status = 'succeeded' WHERE id = $1`, [intent.id]);
    await recomputeInvoice(db, null, inv.id);
    await audit(db, null, { action: 'payment.received_online', entityType: 'payment', entityId: payment.id, after: { provider, amount, invoice: inv.number } });
    await paymentReceivedNotice(db, payment, inv);
    return { applied: true, paymentId: payment.id };
  }
  if (e.type === 'refund.succeeded' || e.type === 'refund.failed') {
    const r = await db.maybeOne(`SELECT * FROM refunds WHERE provider_refund_id = $1 FOR UPDATE`, [e.providerRefundId ?? '']);
    if (!r || r.status !== 'pending') return { applied: false, reason: 'no pending refund' };
    await db.query(`UPDATE refunds SET status = $2 WHERE id = $1`, [r.id, e.type === 'refund.succeeded' ? 'succeeded' : 'failed']);
    await recomputeInvoice(db, null, r.invoice_id);
    await audit(db, null, { action: e.type === 'refund.succeeded' ? 'refund.succeeded' : 'refund.failed', entityType: 'refund', entityId: r.id });
    return { applied: true };
  }
  return { applied: false, reason: 'ignored' };
}

/**
 * Idempotent refund: the (tenant, idempotency_key) unique constraint guarantees a refund is created
 * once; amounts are validated against what remains refundable on that specific payment.
 */
export async function refundPayment(db: Db, req: Request, paymentId: string, amount: number, reason: string, idempotencyKey: string) {
  const prior = await db.maybeOne(`SELECT * FROM refunds WHERE idempotency_key = $1`, [idempotencyKey]);
  if (prior) {
    if (prior.payment_id !== paymentId || Number(prior.amount) !== round2(amount)) throw conflict('This idempotency key was already used for a different refund');
    return { refund: prior, duplicate: true };
  }
  const p = await db.maybeOne(`SELECT * FROM payments WHERE id = $1 FOR UPDATE`, [paymentId]);
  if (!p) throw notFound('Payment');
  if (p.status !== 'succeeded') throw unprocessable('Only successful payments can be refunded');
  const done = Number((await db.one(`SELECT COALESCE(sum(amount),0) s FROM refunds WHERE payment_id = $1 AND status IN ('succeeded','pending')`, [p.id])).s);
  const refundable = round2(Number(p.amount) - done);
  if (round2(amount) > refundable + 0.001) throw unprocessable(`Maximum refundable amount is ${fmtMoney(refundable, p.currency)}`);
  let status: 'succeeded' | 'pending' | 'failed' = 'succeeded';
  let providerRefundId: string | null = null;
  let failure: string | null = null;
  if (p.method === 'gateway' && p.provider && p.provider !== 'manual') {
    const provider = paymentProvider(await getIntegration(db.tenantId!, 'payment'));
    if (!provider || provider.name !== p.provider) throw unprocessable('The payment gateway used for this payment is no longer configured');
    try {
      const r = await provider.refund({ providerPaymentId: p.provider_payment_id, amount: round2(amount), currency: p.currency, idempotencyKey });
      providerRefundId = r.providerRefundId; status = r.status;
    } catch (e) { status = 'failed'; failure = (e as Error).message.slice(0, 500); }
  }
  const refund = await db.one(`INSERT INTO refunds (tenant_id, payment_id, invoice_id, amount, status, reason, provider_refund_id, idempotency_key, failure_reason, requested_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
    [db.tenantId, p.id, p.invoice_id, round2(amount), status, reason, providerRefundId, idempotencyKey, failure, req.auth!.userId]);
  await recomputeInvoice(db, req, p.invoice_id);
  await audit(db, req, { action: `refund.${status === 'failed' ? 'failed' : 'created'}`, entityType: 'refund', entityId: refund.id, after: { payment: p.id, amount, status, reason } });
  return { refund, duplicate: false };
}

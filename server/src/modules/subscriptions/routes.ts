import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { systemDb, withSystem } from '../../db/pool.js';
import { getEntitlements } from './entitlements.js';
import { cancelSubscription, changePlan, openSubscriptionInvoice } from './billing.js';
import { FEATURE_KEYS } from './plans.js';
import { audit } from '../../lib/audit.js';

export const subscriptionRouter = Router();

subscriptionRouter.get('/', ah(async (req, res) => {
  const t = req.auth!.tenantId!;
  const [sub, plans, events, invoices, usage] = await Promise.all([
    systemDb.one(`SELECT s.*, p.code AS plan_code, p.name AS plan_name, pp.name AS pending_plan_name FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id
      LEFT JOIN subscription_plans pp ON pp.id = s.pending_plan_id WHERE s.tenant_id = $1`, [t]),
    systemDb.many(`SELECT id, code, name, description, currency, monthly_price, annual_price, trial_days, max_users, max_technicians, max_storage_mb, max_branches,
      ai_requests_per_month, features, sort_order FROM subscription_plans WHERE is_active AND (is_public OR id = (SELECT plan_id FROM subscriptions WHERE tenant_id = $1)) ORDER BY sort_order`, [t]),
    systemDb.many(`SELECT e.event_type, e.amount, e.currency, e.details, e.created_at, fp.name AS from_plan, tp.name AS to_plan FROM subscription_events e
      LEFT JOIN subscription_plans fp ON fp.id = e.from_plan_id LEFT JOIN subscription_plans tp ON tp.id = e.to_plan_id WHERE e.tenant_id = $1 ORDER BY e.created_at DESC LIMIT 50`, [t]),
    systemDb.many(`SELECT i.id, i.number, i.amount, i.currency, i.status, i.period_start, i.period_end, i.paid_at, p.name AS plan_name FROM subscription_invoices i
      JOIN subscription_plans p ON p.id = i.plan_id WHERE i.tenant_id = $1 ORDER BY i.created_at DESC LIMIT 24`, [t]),
    systemDb.one(`SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND user_type = 'staff' AND is_active)::int AS users,
      (SELECT count(*) FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.tenant_id = $1 AND u.is_active AND tp.employment_status <> 'terminated')::int AS technicians,
      (SELECT count(*) FROM branches WHERE tenant_id = $1 AND is_active)::int AS branches,
      (SELECT COALESCE(sum(size_bytes),0) FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL)::bigint AS storage_bytes,
      (SELECT count(*) FROM ai_usage_logs WHERE tenant_id = $1 AND status = 'success' AND created_at >= date_trunc('month', now()))::int AS ai_requests`, [t]),
  ]);
  res.json({ data: { subscription: sub, entitlements: await getEntitlements(t), plans, events, invoices, usage, featureLabels: FEATURE_KEYS } });
}));

subscriptionRouter.post('/change-plan', requirePermission('subscription.manage'), ah(async (req, res) => {
  const b = parse(z.object({ planCode: z.string().max(40), billingCycle: z.enum(['monthly', 'annual']).default('monthly') }), req.body);
  res.json({ data: await withSystem((db) => changePlan(db, req, req.auth!.tenantId!, b.planCode, b.billingCycle)) });
}));

subscriptionRouter.post('/checkout', requirePermission('subscription.manage'), ah(async (req, res) => {
  const b = parse(z.object({ billingCycle: z.enum(['monthly', 'annual']).optional() }), req.body ?? {});
  const out = await withSystem((db) => openSubscriptionInvoice(db, req.auth!.tenantId!, { cycle: b.billingCycle }));
  res.json({ data: { checkoutUrl: out.checkoutUrl, invoice: out.invoice, manual: !out.checkoutUrl && out.invoice.status === 'open' } });
}));

subscriptionRouter.post('/cancel', requirePermission('subscription.manage'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
  await withSystem((db) => cancelSubscription(db, req, req.auth!.tenantId!, b.reason));
  res.json({ data: { ok: true } });
}));

subscriptionRouter.post('/resume', requirePermission('subscription.manage'), ah(async (req, res) => {
  await withSystem(async (db) => {
    await db.query(`UPDATE subscriptions SET cancel_at_period_end = false, cancelled_at = NULL WHERE tenant_id = $1 AND status = 'active'`, [req.auth!.tenantId]);
    await audit(db, req, { action: 'subscription.resumed', entityType: 'subscription' }, { tenantId: req.auth!.tenantId });
  });
  res.json({ data: { ok: true } });
}));

/** Tenant -> NEXUS support tickets */
subscriptionRouter.get('/support-tickets', ah(async (req, res) => {
  res.json({ data: await systemDb.many(`SELECT t.*, (SELECT json_agg(m ORDER BY m.created_at) FROM platform_ticket_messages m WHERE m.ticket_id = t.id) AS messages
    FROM platform_tickets t WHERE t.tenant_id = $1 ORDER BY t.created_at DESC LIMIT 50`, [req.auth!.tenantId]) });
}));
subscriptionRouter.post('/support-tickets', ah(async (req, res) => {
  const b = parse(z.object({ subject: z.string().trim().min(3).max(200), body: z.string().trim().min(5).max(10000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }), req.body);
  const t = await systemDb.one(`INSERT INTO platform_tickets (tenant_id, subject, body, priority, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
    [req.auth!.tenantId, b.subject, b.body, b.priority, req.auth!.userId]);
  res.status(201).json({ data: t });
}));
subscriptionRouter.post('/support-tickets/:id/messages', ah(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(10000) }), req.body);
  const t = await systemDb.maybeOne(`SELECT id FROM platform_tickets WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
  if (!t) return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Ticket not found' } });
  await systemDb.query(`INSERT INTO platform_ticket_messages (ticket_id, author_id, author_side, body) VALUES ($1,$2,'tenant',$3)`, [t.id, req.auth!.userId, b.body]);
  await systemDb.query(`UPDATE platform_tickets SET status = 'open', updated_at = now() WHERE id = $1 AND status = 'waiting_for_customer'`, [t.id]);
  res.status(201).json({ data: { ok: true } });
}));

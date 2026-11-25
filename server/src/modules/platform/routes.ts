import { Router } from 'express';
import { z } from 'zod';
import { requirePermission, requirePlatform } from '../../auth/middleware.js';
import { ah, listQuery, paged, parse, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { systemDb, withSystem } from '../../db/pool.js';
import { invalidateEntitlements } from '../subscriptions/entitlements.js';
import { invalidateAuthCache } from '../../auth/context.js';
import { markSubscriptionInvoicePaid } from '../subscriptions/billing.js';
import { FEATURE_KEYS } from '../subscriptions/plans.js';
import { createSession } from '../auth/routes.js';
import { pool } from '../../db/pool.js';

export const platformRouter = Router();
platformRouter.use(requirePlatform);

platformRouter.get('/overview', requirePermission('platform.tenants', 'platform.billing'), ah(async (_req, res) => {
  const [totals, mrr, growth, plans, failed, usage] = await Promise.all([
    systemDb.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE t.status = 'active')::int AS active_tenants, count(*) FILTER (WHERE s.status = 'trialing')::int AS trials,
      count(*) FILTER (WHERE s.status = 'active')::int AS paying, count(*) FILTER (WHERE s.status IN ('cancelled','expired'))::int AS cancelled,
      count(*) FILTER (WHERE t.status = 'suspended' OR s.status = 'suspended')::int AS suspended, count(*) FILTER (WHERE s.status IN ('past_due','grace_period'))::int AS at_risk,
      count(*) FILTER (WHERE t.is_demo)::int AS demo FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id`),
    systemDb.many(`SELECT s.currency, sum(CASE WHEN s.billing_cycle = 'annual' THEN s.price / 12 ELSE s.price END) AS mrr FROM subscriptions s JOIN tenants t ON t.id = s.tenant_id
      WHERE s.status IN ('active','past_due','grace_period') AND NOT t.is_demo GROUP BY s.currency`),
    systemDb.many(`SELECT to_char(m, 'YYYY-MM') AS month, (SELECT count(*) FROM tenants t WHERE date_trunc('month', t.created_at) = m)::int AS new_tenants,
      (SELECT count(*) FROM subscription_events e WHERE e.event_type IN ('cancelled','trial_expired') AND date_trunc('month', e.created_at) = m)::int AS churned,
      (SELECT COALESCE(sum(amount),0) FROM subscription_invoices i WHERE i.status = 'paid' AND date_trunc('month', i.paid_at) = m) AS revenue
      FROM generate_series(date_trunc('month', now()) - interval '11 months', date_trunc('month', now()), interval '1 month') m`),
    systemDb.many(`SELECT p.name, count(s.id)::int AS tenants FROM subscription_plans p LEFT JOIN subscriptions s ON s.plan_id = p.id GROUP BY p.name, p.sort_order ORDER BY p.sort_order`),
    systemDb.one(`SELECT count(*)::int AS failed_invoices, COALESCE(sum(amount),0) AS failed_amount FROM subscription_invoices WHERE status = 'open' AND attempt_count > 0`),
    systemDb.one(`SELECT (SELECT count(*) FROM work_orders WHERE created_at > now() - interval '30 days')::int AS jobs_30d,
      (SELECT count(*) FROM users WHERE user_type = 'staff' AND is_active)::int AS staff_users, (SELECT count(*) FROM users WHERE user_type = 'customer')::int AS portal_users,
      (SELECT count(*) FROM ai_usage_logs WHERE created_at > now() - interval '30 days')::int AS ai_requests_30d,
      (SELECT COALESCE(sum(size_bytes),0) FROM documents WHERE deleted_at IS NULL)::bigint AS storage_bytes`),
  ]);
  res.json({ data: { totals, mrr, growth, plans, failed, usage } });
}));

// ---------------------------------------------------------------- tenants
platformRouter.get('/tenants', requirePermission('platform.tenants'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), plan: z.string().optional() }), req.query);
  const w = new Where();
  if (q.status) w.add('(t.status = ? OR s.status = ?)', q.status, q.status);
  w.addIf(q.plan, 'p.code = ?', q.plan);
  if (q.q) w.add('(t.name ILIKE ? OR t.slug ILIKE ? OR t.email ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const rows = await systemDb.many(`SELECT t.id, t.name, t.slug, t.email, t.country, t.status, t.is_demo, t.created_at, s.status AS subscription_status, s.billing_cycle, s.price, s.currency,
      s.trial_ends_at, s.current_period_end, p.name AS plan_name, p.code AS plan_code,
      (SELECT count(*) FROM users u WHERE u.tenant_id = t.id AND u.user_type = 'staff' AND u.is_active)::int AS users,
      (SELECT max(last_login_at) FROM users u WHERE u.tenant_id = t.id) AS last_activity, count(*) OVER() AS _total
    FROM tenants t LEFT JOIN subscriptions s ON s.tenant_id = t.id LEFT JOIN subscription_plans p ON p.id = s.plan_id ${w.sql}
    ORDER BY t.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params);
  res.json(paged(rows, q));
}));

/** Tenant account metadata only: no customers, jobs or invoices are exposed here. */
platformRouter.get('/tenants/:id', requirePermission('platform.tenants'), ah(async (req, res) => {
  const t = await systemDb.maybeOne(`SELECT * FROM tenants WHERE id = $1`, [req.params.id]);
  if (!t) throw notFound('Tenant');
  const [subscription, events, invoices, usage, owners, grants] = await Promise.all([
    systemDb.maybeOne(`SELECT s.*, p.name AS plan_name, p.code AS plan_code FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [t.id]),
    systemDb.many(`SELECT e.*, fp.name AS from_plan, tp.name AS to_plan FROM subscription_events e LEFT JOIN subscription_plans fp ON fp.id = e.from_plan_id LEFT JOIN subscription_plans tp ON tp.id = e.to_plan_id WHERE e.tenant_id = $1 ORDER BY e.created_at DESC LIMIT 100`, [t.id]),
    systemDb.many(`SELECT i.*, p.name AS plan_name FROM subscription_invoices i JOIN subscription_plans p ON p.id = i.plan_id WHERE i.tenant_id = $1 ORDER BY i.created_at DESC`, [t.id]),
    systemDb.one(`SELECT (SELECT count(*) FROM users WHERE tenant_id = $1 AND user_type = 'staff' AND is_active)::int AS users,
      (SELECT count(*) FROM technician_profiles WHERE tenant_id = $1)::int AS technicians, (SELECT count(*) FROM customers WHERE tenant_id = $1)::int AS customers,
      (SELECT count(*) FROM work_orders WHERE tenant_id = $1)::int AS work_orders, (SELECT count(*) FROM work_orders WHERE tenant_id = $1 AND created_at > now() - interval '30 days')::int AS work_orders_30d,
      (SELECT COALESCE(sum(size_bytes),0) FROM documents WHERE tenant_id = $1 AND deleted_at IS NULL)::bigint AS storage_bytes,
      (SELECT count(*) FROM ai_usage_logs WHERE tenant_id = $1 AND created_at >= date_trunc('month', now()))::int AS ai_requests_month,
      (SELECT count(*) FROM notification_logs WHERE tenant_id = $1 AND status = 'failed' AND created_at > now() - interval '7 days')::int AS failed_notifications_7d`, [t.id]),
    systemDb.many(`SELECT u.full_name, u.email, u.last_login_at, u.mfa_enabled FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN roles r ON r.id = ur.role_id WHERE u.tenant_id = $1 AND r.key = 'owner'`, [t.id]),
    systemDb.many(`SELECT id, reason, expires_at, revoked_at, created_at FROM support_access_grants WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 10`, [t.id]),
  ]);
  const integrations = await systemDb.many(`SELECT kind, provider, mode, status, is_enabled, last_error, last_checked_at FROM integrations WHERE tenant_id = $1`, [t.id]);
  res.json({ data: { ...t, subscription, events, invoices, usage, owners, grants, integrations } });
}));

platformRouter.post('/tenants/:id/suspend', requirePermission('platform.tenants'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  await withSystem(async (db) => {
    const t = await db.maybeOne(`UPDATE tenants SET status = 'suspended', suspended_reason = $2 WHERE id = $1 RETURNING id`, [req.params.id, b.reason]);
    if (!t) throw notFound('Tenant');
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE tenant_id = $1 AND revoked_at IS NULL`, [t.id]);
    await audit(db, req, { action: 'platform.tenant_suspended', entityType: 'tenant', entityId: t.id, after: { reason: b.reason } }, { tenantId: t.id });
  });
  invalidateAuthCache(); invalidateEntitlements(req.params.id);
  res.json({ data: { ok: true } });
}));
platformRouter.post('/tenants/:id/reactivate', requirePermission('platform.tenants'), ah(async (req, res) => {
  await withSystem(async (db) => {
    const t = await db.maybeOne(`UPDATE tenants SET status = 'active', suspended_reason = NULL WHERE id = $1 RETURNING id`, [req.params.id]);
    if (!t) throw notFound('Tenant');
    await audit(db, req, { action: 'platform.tenant_reactivated', entityType: 'tenant', entityId: t.id }, { tenantId: t.id });
  });
  invalidateAuthCache(); invalidateEntitlements(req.params.id);
  res.json({ data: { ok: true } });
}));

platformRouter.patch('/tenants/:id/subscription', requirePermission('platform.billing'), ah(async (req, res) => {
  const b = parse(z.object({ planCode: z.string().optional(), status: z.enum(['trialing', 'active', 'past_due', 'grace_period', 'cancelled', 'expired', 'suspended']).optional(),
    trialEndsAt: z.string().datetime({ offset: true }).optional(), currentPeriodEnd: z.string().datetime({ offset: true }).optional(), price: z.number().min(0).optional(),
    customLimits: z.object({ max_users: z.number().int().nullable().optional(), max_technicians: z.number().int().nullable().optional(), max_storage_mb: z.number().int().nullable().optional(),
      max_branches: z.number().int().optional(), ai_requests_per_month: z.number().int().optional(), features: z.record(z.string(), z.boolean()).optional() }).optional(),
    reason: z.string().trim().min(3).max(500) }), req.body);
  await withSystem(async (db) => {
    const s = await db.maybeOne(`SELECT * FROM subscriptions WHERE tenant_id = $1 FOR UPDATE`, [req.params.id]);
    if (!s) throw notFound('Subscription');
    const plan = b.planCode ? await db.maybeOne(`SELECT id FROM subscription_plans WHERE code = $1`, [b.planCode]) : null;
    if (b.planCode && !plan) throw badRequest('Unknown plan');
    await db.query(`UPDATE subscriptions SET plan_id = COALESCE($2, plan_id), status = COALESCE($3, status), trial_ends_at = COALESCE($4, trial_ends_at),
      current_period_end = COALESCE($5, current_period_end), price = COALESCE($6, price), custom_limits = COALESCE($7, custom_limits) WHERE id = $1`,
      [s.id, plan?.id ?? null, b.status ?? null, b.trialEndsAt ?? null, b.currentPeriodEnd ?? null, b.price ?? null, b.customLimits ? JSON.stringify(b.customLimits) : null]);
    await db.query(`INSERT INTO subscription_events (tenant_id, subscription_id, event_type, from_plan_id, to_plan_id, details, actor_id) VALUES ($1,$2,'admin_override',$3,$4,$5,$6)`,
      [s.tenant_id, s.id, s.plan_id, plan?.id ?? s.plan_id, JSON.stringify(b), req.auth!.userId]);
    await audit(db, req, { action: 'platform.subscription_overridden', entityType: 'subscription', entityId: s.id, before: { plan: s.plan_id, status: s.status }, after: b }, { tenantId: s.tenant_id });
  });
  invalidateEntitlements(req.params.id);
  res.json({ data: { ok: true } });
}));

/** Read-only support session. Only possible while the TENANT has an active, unrevoked access grant. */
platformRouter.post('/tenants/:id/support-session', requirePermission('platform.support'), ah(async (req, res) => {
  const grant = await systemDb.maybeOne(`SELECT * FROM support_access_grants WHERE tenant_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY expires_at DESC LIMIT 1`, [req.params.id]);
  if (!grant) throw conflict('This business has not granted support access. Ask the owner to grant access from Settings → Support access.');
  const s = await withSystem(async (db) => {
    const user = await db.one(`SELECT * FROM users WHERE id = $1`, [req.auth!.userId]);
    const s = await createSession(db, req, user, { supportGrantId: grant.id, tenantId: req.params.id });
    await audit(db, req, { action: 'platform.support_session_started', entityType: 'tenant', entityId: req.params.id, after: { grant: grant.id, staff: user.email } }, { tenantId: req.params.id });
    return s;
  });
  res.json({ data: { accessToken: s.accessToken, expiresAt: grant.expires_at, readOnly: true } });
}));

// ---------------------------------------------------------------- plans & pricing (no prices in code paths)
const planSchema = z.object({ code: z.string().regex(/^[a-z0-9_-]{2,30}$/), name: z.string().min(2).max(60), description: z.string().max(500).nullish(), currency: z.string().length(3).toUpperCase(),
  monthlyPrice: z.number().min(0), annualPrice: z.number().min(0), trialDays: z.number().int().min(0).max(365), maxUsers: z.number().int().min(1).nullable(),
  maxTechnicians: z.number().int().min(0).nullable(), maxStorageMb: z.number().int().min(1).nullable(), maxBranches: z.number().int().min(1), aiRequestsPerMonth: z.number().int().min(0),
  features: z.record(z.string(), z.boolean()), isPublic: z.boolean().default(true), isActive: z.boolean().default(true), sortOrder: z.number().int().default(10) });
const planCols: Record<string, string> = { code: 'code', name: 'name', description: 'description', currency: 'currency', monthlyPrice: 'monthly_price', annualPrice: 'annual_price',
  trialDays: 'trial_days', maxUsers: 'max_users', maxTechnicians: 'max_technicians', maxStorageMb: 'max_storage_mb', maxBranches: 'max_branches', aiRequestsPerMonth: 'ai_requests_per_month',
  features: 'features', isPublic: 'is_public', isActive: 'is_active', sortOrder: 'sort_order' };

platformRouter.get('/plans', requirePermission('platform.plans', 'platform.billing'), ah(async (_req, res) => {
  res.json({ data: await systemDb.many(`SELECT p.*, (SELECT count(*) FROM subscriptions s WHERE s.plan_id = p.id)::int AS subscribers FROM subscription_plans p ORDER BY sort_order`), meta: { features: FEATURE_KEYS } });
}));
platformRouter.post('/plans', requirePermission('platform.plans'), ah(async (req, res) => {
  const b = parse(planSchema, req.body);
  const keys = Object.keys(planCols).filter((k) => (b as any)[k] !== undefined);
  const p = await withSystem(async (db) => {
    const p = await db.one(`INSERT INTO subscription_plans (${keys.map((k) => planCols[k]).join(',')}) VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING *`,
      keys.map((k) => (k === 'features' ? JSON.stringify((b as any)[k]) : (b as any)[k])));
    await audit(db, req, { action: 'platform.plan_created', entityType: 'subscription_plan', entityId: p.id, after: b }, { tenantId: null });
    return p;
  });
  res.status(201).json({ data: p });
}));
platformRouter.patch('/plans/:id', requirePermission('platform.plans'), ah(async (req, res) => {
  const b = parse(planSchema.partial().omit({ code: true }), req.body);
  const keys = Object.keys(planCols).filter((k) => (b as any)[k] !== undefined);
  if (!keys.length) throw badRequest('Nothing to update');
  const p = await withSystem(async (db) => {
    const before = await db.maybeOne(`SELECT * FROM subscription_plans WHERE id = $1`, [req.params.id]);
    if (!before) throw notFound('Plan');
    const p = await db.one(`UPDATE subscription_plans SET ${keys.map((k, i) => `${planCols[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...keys.map((k) => (k === 'features' ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
    await audit(db, req, { action: 'platform.plan_updated', entityType: 'subscription_plan', entityId: p.id, before, after: p }, { tenantId: null });
    return p;
  });
  invalidateEntitlements();
  res.json({ data: p });
}));

// ---------------------------------------------------------------- SaaS billing
platformRouter.get('/billing/invoices', requirePermission('platform.billing'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional() }), req.query);
  const w = new Where(); w.addIf(q.status, 'i.status = ?', q.status);
  const rows = await systemDb.many(`SELECT i.*, t.name AS tenant_name, p.name AS plan_name, count(*) OVER() AS _total FROM subscription_invoices i JOIN tenants t ON t.id = i.tenant_id
    JOIN subscription_plans p ON p.id = i.plan_id ${w.sql} ORDER BY i.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params);
  res.json(paged(rows, q));
}));
platformRouter.post('/billing/invoices/:id/mark-paid', requirePermission('platform.billing'), ah(async (req, res) => {
  const b = parse(z.object({ reference: z.string().trim().min(2).max(120) }), req.body);
  await withSystem(async (db) => {
    const inv = await markSubscriptionInvoicePaid(db, req.params.id, b.reference, req.auth!.userId);
    await audit(db, req, { action: 'platform.subscription_invoice_paid', entityType: 'subscription_invoice', entityId: inv.id, after: { reference: b.reference } }, { tenantId: inv.tenant_id });
  });
  res.json({ data: { ok: true } });
}));
platformRouter.post('/billing/invoices/:id/void', requirePermission('platform.billing'), ah(async (req, res) => {
  await withSystem(async (db) => {
    const inv = await db.maybeOne(`UPDATE subscription_invoices SET status = 'void' WHERE id = $1 AND status = 'open' RETURNING *`, [req.params.id]);
    if (!inv) throw conflict('Only open invoices can be voided');
    await audit(db, req, { action: 'platform.subscription_invoice_voided', entityType: 'subscription_invoice', entityId: inv.id }, { tenantId: inv.tenant_id });
  });
  res.json({ data: { ok: true } });
}));
platformRouter.get('/billing/events', requirePermission('platform.billing'), ah(async (_req, res) => {
  res.json({ data: await systemDb.many(`SELECT e.*, t.name AS tenant_name, tp.name AS to_plan FROM subscription_events e JOIN tenants t ON t.id = e.tenant_id
    LEFT JOIN subscription_plans tp ON tp.id = e.to_plan_id ORDER BY e.created_at DESC LIMIT 200`) });
}));

// ---------------------------------------------------------------- support tickets from tenants
platformRouter.get('/tickets', requirePermission('platform.support'), ah(async (req, res) => {
  const q = parse(z.object({ status: z.string().optional() }), req.query);
  res.json({ data: await systemDb.many(`SELECT pt.*, t.name AS tenant_name, u.full_name AS created_by_name,
    (SELECT json_agg(m ORDER BY m.created_at) FROM platform_ticket_messages m WHERE m.ticket_id = pt.id) AS messages
    FROM platform_tickets pt JOIN tenants t ON t.id = pt.tenant_id LEFT JOIN users u ON u.id = pt.created_by WHERE ($1::text IS NULL OR pt.status = $1) ORDER BY pt.updated_at DESC LIMIT 200`, [q.status ?? null]) });
}));
platformRouter.post('/tickets/:id/messages', requirePermission('platform.support'), ah(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(10000), status: z.enum(['open', 'in_progress', 'waiting_for_customer', 'resolved', 'closed']).optional() }), req.body);
  await withSystem(async (db) => {
    const t = await db.maybeOne(`SELECT * FROM platform_tickets WHERE id = $1`, [req.params.id]);
    if (!t) throw notFound('Ticket');
    await db.query(`INSERT INTO platform_ticket_messages (ticket_id, author_id, author_side, body) VALUES ($1,$2,'platform',$3)`, [t.id, req.auth!.userId, b.body]);
    await db.query(`UPDATE platform_tickets SET status = COALESCE($2, 'waiting_for_customer'), assigned_to = COALESCE(assigned_to, $3), updated_at = now() WHERE id = $1`, [t.id, b.status ?? null, req.auth!.userId]);
  });
  res.status(201).json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- announcements & configuration
platformRouter.get('/announcements', requirePermission('platform.config'), ah(async (_req, res) => {
  res.json({ data: await systemDb.many(`SELECT * FROM announcements ORDER BY created_at DESC LIMIT 100`) });
}));
platformRouter.post('/announcements', requirePermission('platform.config'), ah(async (req, res) => {
  const b = parse(z.object({ title: z.string().min(3).max(150), body: z.string().min(3).max(2000), severity: z.enum(['info', 'warning', 'critical']).default('info'),
    startsAt: z.string().datetime({ offset: true }).optional(), endsAt: z.string().datetime({ offset: true }).nullish() }), req.body);
  const a = await withSystem(async (db) => {
    const a = await db.one(`INSERT INTO announcements (title, body, severity, starts_at, ends_at, created_by) VALUES ($1,$2,$3,COALESCE($4::timestamptz, now()),$5,$6) RETURNING *`,
      [b.title, b.body, b.severity, b.startsAt ?? null, b.endsAt ?? null, req.auth!.userId]);
    await audit(db, req, { action: 'platform.announcement_created', entityType: 'announcement', entityId: a.id, after: b }, { tenantId: null });
    return a;
  });
  res.status(201).json({ data: a });
}));
platformRouter.patch('/announcements/:id', requirePermission('platform.config'), ah(async (req, res) => {
  const b = parse(z.object({ isActive: z.boolean() }), req.body);
  await systemDb.query(`UPDATE announcements SET is_active = $2 WHERE id = $1`, [req.params.id, b.isActive]);
  res.json({ data: { ok: true } });
}));

platformRouter.get('/settings', requirePermission('platform.config'), ah(async (_req, res) => {
  res.json({ data: await systemDb.many(`SELECT * FROM platform_settings ORDER BY key`) });
}));
platformRouter.put('/settings/:key', requirePermission('platform.config'), ah(async (req, res) => {
  if (!/^[a-z0-9_.]{2,60}$/.test(req.params.key)) throw badRequest('Invalid key');
  const b = parse(z.object({ value: z.unknown() }), req.body);
  await withSystem(async (db) => {
    const before = await db.maybeOne(`SELECT value FROM platform_settings WHERE key = $1`, [req.params.key]);
    await db.query(`INSERT INTO platform_settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`, [req.params.key, JSON.stringify(b.value)]);
    await audit(db, req, { action: 'platform.setting_changed', entityType: 'platform_setting', entityId: req.params.key, before, after: { value: b.value } }, { tenantId: null });
  });
  res.json({ data: { ok: true } });
}));

platformRouter.get('/audit-logs', requirePermission('platform.audit'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ tenantId: z.string().uuid().optional(), action: z.string().optional() }), req.query);
  const w = new Where();
  w.add(`(a.tenant_id IS NULL OR a.action LIKE 'platform.%' OR a.action LIKE 'tenant.%' OR a.action LIKE 'subscription.%' OR a.action LIKE 'support_access.%')`);
  w.addIf(q.tenantId, 'a.tenant_id = ?', q.tenantId);
  if (q.action) w.add('a.action ILIKE ?', `${q.action}%`);
  const rows = await systemDb.many(`SELECT a.*, t.name AS tenant_name, count(*) OVER() AS _total FROM audit_logs a LEFT JOIN tenants t ON t.id = a.tenant_id ${w.sql}
    ORDER BY a.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params);
  res.json(paged(rows, q));
}));

/** Service & integration health across the platform. */
platformRouter.get('/health', requirePermission('platform.config', 'platform.tenants'), ah(async (_req, res) => {
  const started = Date.now();
  await systemDb.query('SELECT 1');
  const dbLatency = Date.now() - started;
  const [queue, integrations, webhooks, notifications, db] = await Promise.all([
    systemDb.many(`SELECT job_type, status, count(*)::int AS n FROM background_jobs WHERE created_at > now() - interval '24 hours' GROUP BY 1,2 ORDER BY 1`),
    systemDb.many(`SELECT kind, provider, status, count(*)::int AS tenants FROM integrations WHERE is_enabled GROUP BY 1,2,3 ORDER BY 1`),
    systemDb.one(`SELECT count(*)::int AS total, count(*) FILTER (WHERE NOT signature_valid)::int AS invalid_signatures, count(*) FILTER (WHERE processing_error IS NOT NULL AND processed_at IS NULL)::int AS failed FROM webhook_events WHERE received_at > now() - interval '24 hours'`),
    systemDb.many(`SELECT channel, status, count(*)::int AS n FROM notification_logs WHERE created_at > now() - interval '24 hours' GROUP BY 1,2`),
    systemDb.one(`SELECT pg_database_size(current_database())::bigint AS size_bytes, (SELECT count(*) FROM pg_stat_activity)::int AS connections`),
  ]);
  const dead = await systemDb.many(`SELECT id, job_type, tenant_id, attempts, last_error, created_at FROM background_jobs WHERE status = 'dead' ORDER BY created_at DESC LIMIT 20`);
  res.json({ data: { database: { latencyMs: dbLatency, ...db, pool: { total: pool.totalCount, idle: pool.idleCount, waiting: pool.waitingCount } }, queue, deadJobs: dead, integrations, webhooks, notifications,
    uptimeSec: Math.round(process.uptime()), memoryMb: Math.round(process.memoryUsage().rss / 1048576) } });
}));
platformRouter.post('/jobs/:id/retry', requirePermission('platform.config'), ah(async (req, res) => {
  await systemDb.query(`UPDATE background_jobs SET status = 'pending', attempts = 0, run_at = now(), last_error = NULL WHERE id = $1 AND status = 'dead'`, [req.params.id]);
  res.json({ data: { ok: true } });
}));

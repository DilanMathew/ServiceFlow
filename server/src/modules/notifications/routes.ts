import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, listQuery, paged, parse, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { tx } from '../common.js';
import { enqueue } from '../../jobs/queue.js';
import { NOTIFICATION_EVENTS, renderTemplate } from './templates.js';
import { notifyStaff } from './service.js';
import { systemDb } from '../../db/pool.js';
import { ensureVapidKeys, isAllowedPushEndpoint } from '../../integrations/push.js';

export const notificationsRouter = Router();

// In-app inbox for the current user
notificationsRouter.get('/inbox', ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`, [req.auth!.userId]));
  res.json({ data: rows, meta: { unread: rows.filter((r) => !r.read_at).length } });
}));
notificationsRouter.post('/inbox/read', ah(async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string().uuid()).max(200).optional() }), req.body ?? {});
  await tx(req, (db) => db.query(`UPDATE notifications SET read_at = now() WHERE user_id = $1 AND read_at IS NULL AND ($2::uuid[] IS NULL OR id = ANY($2))`, [req.auth!.userId, b.ids ?? null]));
  res.json({ data: { ok: true } });
}));

// Delivery logs
// ── Web push devices for the current user ─────────────────────────────
const pushSubSchema = z.object({
  endpoint: z.string().url().max(1000),
  keys: z.object({ p256dh: z.string().min(20).max(200), auth: z.string().min(8).max(100) }),
});

notificationsRouter.get('/push', ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT id, user_agent, created_at, last_success_at FROM push_subscriptions WHERE user_id = $1 ORDER BY created_at DESC`, [req.auth!.userId]));
  res.json({ data: { publicKey: (await ensureVapidKeys()).publicKey, devices: rows } });
}));

notificationsRouter.post('/push/subscribe', ah(async (req, res) => {
  const b = parse(pushSubSchema, req.body);
  if (!isAllowedPushEndpoint(b.endpoint)) throw badRequest('Unsupported push endpoint');
  // An endpoint belongs to one browser profile: if it was registered by another account (possibly in
  // another business), move it here. Done as system because RLS hides other tenants' rows.
  await systemDb.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND NOT (tenant_id = $2 AND user_id = $3)`, [b.endpoint, req.auth!.tenantId, req.auth!.userId]);
  const row = await tx(req, async (db) => {
    const count = await db.one(`SELECT count(*)::int n FROM push_subscriptions WHERE user_id = $1`, [req.auth!.userId]);
    if (count.n >= 10) await db.query(`DELETE FROM push_subscriptions WHERE id = (SELECT id FROM push_subscriptions WHERE user_id = $1 ORDER BY COALESCE(last_success_at, created_at) LIMIT 1)`, [req.auth!.userId]);
    return db.one(`INSERT INTO push_subscriptions (tenant_id, user_id, endpoint, p256dh, auth, user_agent) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT (endpoint) DO UPDATE SET p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, user_agent = EXCLUDED.user_agent, failure_count = 0
      RETURNING id`, [db.tenantId, req.auth!.userId, b.endpoint, b.keys.p256dh, b.keys.auth, String(req.headers['user-agent'] ?? '').slice(0, 200)]);
  });
  res.status(201).json({ data: { id: row.id } });
}));

notificationsRouter.post('/push/unsubscribe', ah(async (req, res) => {
  const b = parse(z.object({ endpoint: z.string().max(1000) }), req.body);
  await tx(req, (db) => db.query(`DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2`, [b.endpoint, req.auth!.userId]));
  res.json({ data: { ok: true } });
}));

notificationsRouter.post('/push/test', ah(async (req, res) => {
  await tx(req, (db) => notifyStaff(db, req.auth!.userId, 'push.test', { title: 'Notifications are on', body: 'You will be alerted here when jobs are assigned or changed.', link: null }));
  res.json({ data: { ok: true } });
}));

notificationsRouter.get('/logs', requirePermission('communications.read'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), channel: z.string().optional(), event: z.string().optional() }), req.query);
  const w = new Where();
  w.addIf(q.status, 'l.status = ?', q.status); w.addIf(q.channel, 'l.channel = ?', q.channel); w.addIf(q.event, 'l.event = ?', q.event);
  if (q.q) w.add('(l.recipient ILIKE ? OR l.subject ILIKE ?)', `%${q.q}%`, `%${q.q}%`);
  const rows = await tx(req, (db) => db.many(`SELECT l.id, l.event, l.channel, l.recipient, l.subject, l.status, l.attempts, l.last_error, l.provider, l.sent_at, l.created_at,
      l.customer_id, c.full_name AS customer_name, count(*) OVER() AS _total FROM notification_logs l LEFT JOIN customers c ON c.id = l.customer_id
    ${w.sql} ORDER BY l.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  const stats = await tx(req, (db) => db.many(`SELECT channel, status, count(*)::int AS n FROM notification_logs WHERE created_at > now() - interval '30 days' GROUP BY 1,2`));
  res.json({ ...paged(rows, q), stats });
}));

notificationsRouter.get('/logs/:id', requirePermission('communications.read'), ah(async (req, res) => {
  const r = await tx(req, (db) => db.maybeOne(`SELECT * FROM notification_logs WHERE id = $1`, [req.params.id]));
  if (!r) throw notFound('Notification');
  res.json({ data: r });
}));

notificationsRouter.post('/logs/:id/retry', requirePermission('communications.manage'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const l = await db.maybeOne(`SELECT * FROM notification_logs WHERE id = $1`, [req.params.id]);
    if (!l) throw notFound('Notification');
    if (!['failed', 'skipped'].includes(l.status)) throw unprocessable('Only failed or skipped notifications can be retried');
    await db.query(`UPDATE notification_logs SET status = 'queued', last_error = NULL WHERE id = $1`, [l.id]);
    const tpl = await db.maybeOne(`SELECT whatsapp_template_name FROM notification_templates WHERE event = $1 AND channel = $2 AND (tenant_id = $3 OR tenant_id IS NULL) ORDER BY tenant_id NULLS LAST LIMIT 1`, [l.event, l.channel, db.tenantId]);
    await enqueue(db, 'deliver_notification', { logId: l.id, whatsappTemplate: tpl?.whatsapp_template_name ?? null });
    await audit(db, req, { action: 'notification.retried', entityType: 'notification_log', entityId: l.id });
  });
  res.json({ data: { ok: true } });
}));

// Templates (tenant overrides of platform defaults)
notificationsRouter.get('/templates', requirePermission('communications.read'), ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT DISTINCT ON (event, channel) id, tenant_id, event, channel, subject, body, whatsapp_template_name, is_active, (tenant_id IS NOT NULL) AS customised
    FROM notification_templates ORDER BY event, channel, tenant_id NULLS LAST`));
  res.json({ data: rows, meta: { events: NOTIFICATION_EVENTS, variables: ['customer.name', 'business.name', 'business.phone', 'job.number', 'job.scheduled', 'technician.name',
    'request.number', 'quotation.number', 'quotation.total', 'invoice.number', 'invoice.total', 'invoice.due_date', 'payment.amount', 'payment.receipt_number', 'amc.number',
    'amc.end_date', 'visit.due_date', 'links.invoice', 'links.quotation', 'links.feedback'] } });
}));

notificationsRouter.put('/templates', requirePermission('communications.manage'), ah(async (req, res) => {
  const b = parse(z.object({ event: z.enum(NOTIFICATION_EVENTS), channel: z.enum(['email', 'whatsapp', 'sms']), subject: z.string().max(200).nullish(),
    body: z.string().trim().min(5).max(5000), whatsappTemplateName: z.string().max(100).nullish(), isActive: z.boolean().default(true) }), req.body);
  const r = await tx(req, async (db) => {
    const r = await db.one(`INSERT INTO notification_templates (tenant_id, event, channel, subject, body, whatsapp_template_name, is_active) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), event, channel) DO UPDATE SET subject = EXCLUDED.subject, body = EXCLUDED.body,
      whatsapp_template_name = EXCLUDED.whatsapp_template_name, is_active = EXCLUDED.is_active RETURNING *`,
      [db.tenantId, b.event, b.channel, b.subject ?? null, b.body, b.whatsappTemplateName ?? null, b.isActive]);
    await audit(db, req, { action: 'notification_template.updated', entityType: 'notification_template', entityId: r.id, after: b });
    return r;
  });
  res.json({ data: r });
}));

notificationsRouter.delete('/templates/:event/:channel', requirePermission('communications.manage'), ah(async (req, res) => {
  await tx(req, (db) => db.query(`DELETE FROM notification_templates WHERE tenant_id = $1 AND event = $2 AND channel = $3`, [db.tenantId, req.params.event, req.params.channel]));
  res.json({ data: { ok: true } });
}));

notificationsRouter.post('/templates/preview', requirePermission('communications.read'), ah(async (req, res) => {
  const b = parse(z.object({ subject: z.string().max(200).nullish(), body: z.string().max(5000) }), req.body);
  const sample = { customer: { name: 'Priya Sharma' }, business: { name: 'Your Business', phone: '+91 98765 43210' }, job: { number: 'JOB-000123', scheduled: '12 Mar 2026, 10:30' },
    technician: { name: 'Ravi Kumar' }, request: { number: 'SR-000045' }, quotation: { number: 'QUO-000012', total: '₹4,720.00' },
    invoice: { number: 'INV-00031', total: '₹4,720.00', due_date: '2026-03-27' }, payment: { amount: '₹4,720.00', receipt_number: 'RCPT-000088' },
    amc: { number: 'AMC-000007', end_date: '2026-12-31' }, visit: { due_date: '2026-04-15' }, links: { invoice: 'https://…/i/…', quotation: 'https://…/q/…', feedback: 'https://…/portal' } };
  res.json({ data: { subject: b.subject ? renderTemplate(b.subject, sample) : null, body: renderTemplate(b.body, sample) } });
}));

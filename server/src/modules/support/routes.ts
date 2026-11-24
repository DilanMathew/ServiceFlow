import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx } from '../common.js';
import type { Db } from '../../db/pool.js';

export const supportRouter = Router();
const read = requirePermission('support.read');
const manage = requirePermission('support.manage');

export const ticketSchema = z.object({ customerId: z.string().uuid().nullish(), workOrderId: z.string().uuid().nullish(), subject: z.string().trim().min(3).max(200),
  category: z.enum(['general', 'complaint', 'billing', 'service_quality', 'technician', 'scheduling', 'other']).default('general'),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'), message: z.string().trim().min(2).max(10000), feedbackId: z.string().uuid().nullish() });

export async function createTicket(db: Db, b: z.infer<typeof ticketSchema>, author: { id: string | null; type: 'staff' | 'customer' | 'system' }) {
  const t = await db.one(`INSERT INTO support_tickets (tenant_id, number, customer_id, work_order_id, feedback_id, subject, category, priority, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [db.tenantId, await nextNumber(db, 'ticket'), b.customerId ?? null, b.workOrderId ?? null, b.feedbackId ?? null,
      b.subject, b.category, b.priority, author.id]);
  await db.query(`INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, author_type, body) VALUES ($1,$2,$3,$4,$5)`, [db.tenantId, t.id, author.id, author.type, b.message]);
  return t;
}

supportRouter.get('/tickets', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), priority: z.string().optional(), category: z.string().optional(), assignedTo: z.string().optional() }), req.query);
  const w = new Where();
  if (q.status) w.add('t.status = ANY(?)', q.status.split(','));
  w.addIf(q.priority, 't.priority = ?', q.priority); w.addIf(q.category, 't.category = ?', q.category);
  if (q.assignedTo === 'me') w.add('t.assigned_to = ?', req.auth!.userId); else w.addIf(q.assignedTo, 't.assigned_to = ?', q.assignedTo);
  if (q.q) w.add('(t.number ILIKE ? OR t.subject ILIKE ? OR c.full_name ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const order = orderBy(q, { created: 't.created_at', updated: 't.updated_at', priority: `array_position(ARRAY['urgent','high','normal','low'], t.priority)` }, 't.updated_at');
  const rows = await tx(req, (db) => db.many(`SELECT t.*, c.full_name AS customer_name, u.full_name AS assignee_name, w.number AS work_order_number, count(*) OVER() AS _total
    FROM support_tickets t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN work_orders w ON w.id = t.work_order_id
    ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

supportRouter.post('/tickets', manage, ah(async (req, res) => {
  const b = parse(ticketSchema, req.body);
  const t = await tx(req, async (db) => {
    const t = await createTicket(db, b, { id: req.auth!.userId, type: 'staff' });
    await audit(db, req, { action: 'ticket.created', entityType: 'support_ticket', entityId: t.id, after: { number: t.number } });
    return t;
  });
  res.status(201).json({ data: t });
}));

supportRouter.get('/tickets/:id', read, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const t = await db.maybeOne(`SELECT t.*, c.full_name AS customer_name, c.email AS customer_email, c.phone AS customer_phone, u.full_name AS assignee_name, w.number AS work_order_number
      FROM support_tickets t LEFT JOIN customers c ON c.id = t.customer_id LEFT JOIN users u ON u.id = t.assigned_to LEFT JOIN work_orders w ON w.id = t.work_order_id WHERE t.id = $1`, [req.params.id]);
    if (!t) throw notFound('Ticket');
    const messages = await db.many(`SELECT m.*, u.full_name AS author_name FROM ticket_messages m LEFT JOIN users u ON u.id = m.author_id WHERE m.ticket_id = $1 ORDER BY m.created_at`, [t.id]);
    return { ...t, messages };
  });
  res.json({ data });
}));

supportRouter.patch('/tickets/:id', manage, ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['open', 'in_progress', 'waiting_for_customer', 'resolved', 'closed']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
    assignedTo: z.string().uuid().nullish(), resolution: z.string().max(5000).nullish(), category: z.string().optional() }), req.body);
  const out = await tx(req, async (db) => {
    const t = await db.maybeOne(`SELECT * FROM support_tickets WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!t) throw notFound('Ticket');
    if (b.status === 'resolved' && !b.resolution && !t.resolution) throw unprocessable('Add a resolution before resolving the ticket');
    const after = await db.one(`UPDATE support_tickets SET status = COALESCE($2, status), priority = COALESCE($3, priority),
      assigned_to = CASE WHEN $4 THEN $5::uuid ELSE assigned_to END, resolution = COALESCE($6, resolution), category = COALESCE($7, category),
      resolved_at = CASE WHEN $2 IN ('resolved','closed') THEN COALESCE(resolved_at, now()) WHEN $2 IS NOT NULL THEN NULL ELSE resolved_at END WHERE id = $1 RETURNING *`,
      [t.id, b.status ?? null, b.priority ?? null, b.assignedTo !== undefined, b.assignedTo ?? null, b.resolution ?? null, b.category ?? null]);
    if (b.status && b.status !== t.status) await db.query(`INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, author_type, is_internal, body) VALUES ($1,$2,$3,'system',true,$4)`,
      [db.tenantId, t.id, req.auth!.userId, `Status changed from ${t.status} to ${b.status}`]);
    await audit(db, req, { action: 'ticket.updated', entityType: 'support_ticket', entityId: t.id, before: { status: t.status, assigned_to: t.assigned_to }, after: b });
    return after;
  });
  res.json({ data: out });
}));

supportRouter.post('/tickets/:id/messages', manage, ah(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(10000), internal: z.boolean().default(false) }), req.body);
  const m = await tx(req, async (db) => {
    const t = await db.maybeOne(`SELECT * FROM support_tickets WHERE id = $1`, [req.params.id]);
    if (!t) throw notFound('Ticket');
    const m = await db.one(`INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, author_type, is_internal, body) VALUES ($1,$2,$3,'staff',$4,$5) RETURNING *`,
      [db.tenantId, t.id, req.auth!.userId, b.internal, b.body]);
    if (!b.internal && t.status === 'open') await db.query(`UPDATE support_tickets SET status = 'in_progress' WHERE id = $1`, [t.id]);
    else await db.query(`UPDATE support_tickets SET updated_at = now() WHERE id = $1`, [t.id]);
    return m;
  });
  res.status(201).json({ data: m });
}));

// Feedback review
supportRouter.get('/feedback', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), maxRating: z.coerce.number().int().optional(), complaints: z.coerce.boolean().optional() }), req.query);
  const w = new Where();
  w.addIf(q.status, 'f.review_status = ?', q.status);
  w.addIf(q.maxRating, 'f.rating <= ?', q.maxRating);
  if (q.complaints) w.add('f.is_complaint');
  const rows = await tx(req, (db) => db.many(`SELECT f.*, c.full_name AS customer_name, w.number AS work_order_number, u.full_name AS technician_name, count(*) OVER() AS _total
    FROM customer_feedback f JOIN customers c ON c.id = f.customer_id LEFT JOIN work_orders w ON w.id = f.work_order_id LEFT JOIN technician_profiles tp ON tp.id = f.technician_id
    LEFT JOIN users u ON u.id = tp.user_id ${w.sql} ORDER BY f.created_at DESC LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  const summary = await tx(req, (db) => db.one(`SELECT round(avg(rating),2) AS avg_rating, count(*)::int AS total, count(*) FILTER (WHERE rating <= 2)::int AS negative,
    round(100.0 * count(*) FILTER (WHERE rating >= 4) / NULLIF(count(*),0)) AS satisfaction_pct FROM customer_feedback WHERE created_at > now() - interval '90 days'`));
  res.json({ ...paged(rows, q), summary });
}));

supportRouter.post('/feedback/:id/review', manage, ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['reviewed', 'action_taken', 'dismissed']), correctiveAction: z.string().max(5000).nullish(), createTicket: z.boolean().default(false) }), req.body);
  const out = await tx(req, async (db) => {
    const f = await db.maybeOne(`SELECT * FROM customer_feedback WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!f) throw notFound('Feedback');
    if (b.status === 'action_taken' && !b.correctiveAction) throw unprocessable('Describe the corrective action taken');
    const after = await db.one(`UPDATE customer_feedback SET review_status = $2, corrective_action = $3, reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *`,
      [f.id, b.status, b.correctiveAction ?? null, req.auth!.userId]);
    let ticketId: string | null = null;
    if (b.createTicket) ticketId = (await createTicket(db, { customerId: f.customer_id, workOrderId: f.work_order_id, feedbackId: f.id, subject: `Follow-up on ${f.rating}★ feedback`,
      category: f.is_complaint ? 'complaint' : 'service_quality', priority: f.rating <= 2 ? 'high' : 'normal', message: f.comment ?? 'Customer left a low rating.' }, { id: req.auth!.userId, type: 'staff' })).id;
    await audit(db, req, { action: 'feedback.reviewed', entityType: 'customer_feedback', entityId: f.id, after: { status: b.status, ticketId } });
    return { ...after, ticketId };
  });
  res.json({ data: out });
}));

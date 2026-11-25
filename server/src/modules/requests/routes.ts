import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, branchScope } from '../common.js';
import { notify, staffWithPermission } from '../notifications/service.js';
import { createWorkOrder, assign } from '../workorders/service.js';
import { createCustomer } from '../customers/routes.js';
import type { Db } from '../../db/pool.js';

export const requestsRouter = Router();

export const requestSchema = z.object({
  customerId: z.string().uuid().nullish(), addressId: z.string().uuid().nullish(), assetId: z.string().uuid().nullish(),
  serviceCategoryId: z.string().uuid().nullish(), contactName: z.string().trim().min(2).max(120).optional(), contactPhone: z.string().trim().max(30).nullish(),
  contactEmail: z.string().trim().toLowerCase().email().nullish(), addressText: z.string().max(500).nullish(),
  description: z.string().trim().min(5).max(5000), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  preferredDate: dateStr.nullish(), preferredTimeSlot: z.enum(['morning', 'afternoon', 'evening', 'any']).nullish(),
  source: z.enum(['admin', 'phone', 'email', 'whatsapp', 'portal', 'public_form', 'ai_assistant']).default('admin'),
  aiAnalysis: z.record(z.string(), z.unknown()).nullish(),
});
export type RequestInput = z.infer<typeof requestSchema>;

/** Shared by staff, customer portal, public form and WhatsApp intake. */
export async function createServiceRequest(db: Db, req: Request | null, b: RequestInput) {
  let contactName = b.contactName, contactPhone = b.contactPhone, contactEmail = b.contactEmail, branchId: string | null = null;
  if (b.customerId) {
    const c = await db.maybeOne(`SELECT * FROM customers WHERE id = $1 AND archived_at IS NULL`, [b.customerId]);
    if (!c) throw badRequest('Customer not found');
    contactName ??= c.full_name; contactPhone ??= c.phone; contactEmail ??= c.email; branchId = c.branch_id;
    if (b.addressId && !(await db.maybeOne(`SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [b.addressId, c.id]))) throw badRequest('Invalid address');
    if (b.assetId && !(await db.maybeOne(`SELECT 1 FROM assets WHERE id = $1 AND customer_id = $2`, [b.assetId, c.id]))) throw badRequest('Invalid equipment');
  } else if (b.addressId || b.assetId) throw badRequest('Address and equipment require a customer');
  if (!contactName) throw badRequest('Contact name is required');
  if (!b.customerId && !contactPhone && !contactEmail) throw badRequest('A phone number or email is required');
  const r = await db.one(
    `INSERT INTO service_requests (tenant_id, branch_id, number, customer_id, address_id, asset_id, service_category_id, contact_name, contact_phone, contact_email,
       address_text, description, priority, preferred_date, preferred_time_slot, source, ai_analysis, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
    [db.tenantId, branchId, await nextNumber(db, 'request'), b.customerId ?? null, b.addressId ?? null, b.assetId ?? null, b.serviceCategoryId ?? null,
      contactName, contactPhone ?? null, contactEmail ?? null, b.addressText ?? null, b.description, b.priority, b.preferredDate ?? null,
      b.preferredTimeSlot ?? null, b.source, b.aiAnalysis ? JSON.stringify(b.aiAnalysis) : null, req?.auth?.userId ?? null]);
  await audit(db, req, { action: 'service_request.created', entityType: 'service_request', entityId: r.id, after: { number: r.number, source: r.source } });
  await notify(db, { event: 'request.created', customerId: r.customer_id, recipient: r.customer_id ? undefined : { email: contactEmail, phone: contactPhone, name: contactName },
    entityType: 'service_request', entityId: r.id, vars: { request: { number: r.number } },
    staffUserIds: await staffWithPermission(db, 'requests.review'), inApp: { title: `New service request ${r.number}`, body: b.description.slice(0, 140), link: `/app/requests/${r.id}` } });
  return r;
}

requestsRouter.get('/', requirePermission('requests.read'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), source: z.string().optional(), priority: z.string().optional(), customerId: z.string().uuid().optional() }), req.query);
  const w = new Where();
  if (q.status) w.add('r.status = ANY(?)', q.status.split(','));
  w.addIf(q.source, 'r.source = ?', q.source);
  w.addIf(q.priority, 'r.priority = ?', q.priority);
  w.addIf(q.customerId, 'r.customer_id = ?', q.customerId);
  const b = branchScope(req); if (b) w.add('(r.branch_id = ? OR r.branch_id IS NULL)', b);
  if (q.q) w.add('(r.number ILIKE ? OR r.contact_name ILIKE ? OR r.description ILIKE ? OR r.contact_phone ILIKE ?)', ...Array(4).fill(`%${q.q}%`));
  const order = orderBy(q, { created: 'r.created_at', number: 'r.number', priority: `array_position(ARRAY['urgent','high','normal','low'], r.priority)`, preferred: 'r.preferred_date' }, 'r.created_at');
  const rows = await tx(req, (db) => db.many(
    `SELECT r.id, r.number, r.status, r.priority, r.source, r.contact_name, r.contact_phone, r.description, r.preferred_date, r.preferred_time_slot, r.created_at,
            r.customer_id, sc.name AS category_name, r.work_order_id, w.number AS work_order_number, count(*) OVER() AS _total
       FROM service_requests r LEFT JOIN service_categories sc ON sc.id = r.service_category_id LEFT JOIN work_orders w ON w.id = r.work_order_id
       ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

requestsRouter.post('/', requirePermission('requests.create'), ah(async (req, res) => {
  const b = parse(requestSchema, req.body);
  res.status(201).json({ data: await tx(req, (db) => createServiceRequest(db, req, b)) });
}));

requestsRouter.get('/:id', requirePermission('requests.read'), ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const r = await db.maybeOne(`SELECT r.*, sc.name AS category_name, c.full_name AS customer_name, c.number AS customer_number, to_jsonb(a.*) AS address,
        ast.name AS asset_name, w.number AS work_order_number, rv.full_name AS reviewed_by_name
      FROM service_requests r LEFT JOIN service_categories sc ON sc.id = r.service_category_id LEFT JOIN customers c ON c.id = r.customer_id
      LEFT JOIN customer_addresses a ON a.id = r.address_id LEFT JOIN assets ast ON ast.id = r.asset_id LEFT JOIN work_orders w ON w.id = r.work_order_id
      LEFT JOIN users rv ON rv.id = r.reviewed_by WHERE r.id = $1`, [req.params.id]);
    if (!r) throw notFound('Service request');
    const [documents, history] = await Promise.all([
      db.many(`SELECT id, file_name, mime_type, size_bytes, category, created_at FROM documents WHERE entity_type = 'service_request' AND entity_id = $1 AND deleted_at IS NULL`, [r.id]),
      db.many(`SELECT a.action, a.created_at, a.user_email, a.after_data FROM audit_logs a WHERE a.entity_type = 'service_request' AND a.entity_id = $1 ORDER BY a.created_at`, [r.id]),
    ]);
    return { ...r, documents, history };
  });
  res.json({ data });
}));

requestsRouter.patch('/:id', requirePermission('requests.review'), ah(async (req, res) => {
  const b = parse(requestSchema.omit({ source: true }).partial(), req.body);
  const out = await tx(req, async (db) => {
    const before = await db.maybeOne(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before) throw notFound('Service request');
    if (['converted', 'cancelled', 'rejected'].includes(before.status)) throw unprocessable(`A ${before.status} request cannot be edited`);
    const custId = b.customerId !== undefined ? b.customerId : before.customer_id;
    if (b.addressId && !(await db.maybeOne(`SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [b.addressId, custId]))) throw badRequest('Invalid address');
    if (b.assetId && !(await db.maybeOne(`SELECT 1 FROM assets WHERE id = $1 AND customer_id = $2`, [b.assetId, custId]))) throw badRequest('Invalid equipment');
    const m: Record<string, string> = { customerId: 'customer_id', addressId: 'address_id', assetId: 'asset_id', serviceCategoryId: 'service_category_id', contactName: 'contact_name',
      contactPhone: 'contact_phone', contactEmail: 'contact_email', addressText: 'address_text', description: 'description', priority: 'priority',
      preferredDate: 'preferred_date', preferredTimeSlot: 'preferred_time_slot', aiAnalysis: 'ai_analysis' };
    const keys = Object.keys(m).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await db.one(`UPDATE service_requests SET ${keys.map((k, i) => `${m[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [before.id, ...keys.map((k) => (k === 'aiAnalysis' ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
    await audit(db, req, { action: 'service_request.updated', entityType: 'service_request', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

const REVIEW: Record<string, string[]> = { new: ['under_review', 'approved', 'rejected', 'cancelled'], under_review: ['approved', 'rejected', 'cancelled'], approved: ['cancelled', 'rejected'] };

requestsRouter.post('/:id/status', requirePermission('requests.review'), ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(['under_review', 'approved', 'rejected', 'cancelled']), reason: z.string().max(1000).nullish() }), req.body);
  const out = await tx(req, async (db) => {
    const r = await db.maybeOne(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r) throw notFound('Service request');
    if (!(REVIEW[r.status] ?? []).includes(b.status)) throw unprocessable(`Cannot change a ${r.status.replace('_', ' ')} request to ${b.status.replace('_', ' ')}`);
    if (b.status === 'rejected' && !b.reason) throw badRequest('A rejection reason is required');
    const after = await db.one(`UPDATE service_requests SET status = $2, rejection_reason = CASE WHEN $2 IN ('rejected','cancelled') THEN $3 ELSE rejection_reason END,
        reviewed_by = $4, reviewed_at = now() WHERE id = $1 RETURNING *`, [r.id, b.status, b.reason ?? null, req.auth!.userId]);
    await audit(db, req, { action: `service_request.${b.status}`, entityType: 'service_request', entityId: r.id, before: { status: r.status }, after: { status: b.status, reason: b.reason } });
    if (b.status === 'approved') await notify(db, { event: 'request.approved', customerId: r.customer_id,
      recipient: r.customer_id ? undefined : { email: r.contact_email, phone: r.contact_phone, name: r.contact_name }, entityType: 'service_request', entityId: r.id, vars: { request: { number: r.number } } });
    return after;
  });
  res.json({ data: out });
}));

/** Converts an approved request into a work order, creating the customer from the contact details if needed. Idempotent via unique index. */
requestsRouter.post('/:id/convert', requirePermission('requests.review'), requirePermission('work_orders.create'), ah(async (req, res) => {
  const b = parse(z.object({ title: z.string().trim().min(3).max(200).optional(), scheduledStart: z.string().datetime({ offset: true }).nullish(),
    expectedDurationMinutes: z.number().int().min(5).max(10080).nullish(), technicianId: z.string().uuid().nullish(), force: z.boolean().optional(),
    estimatedCost: z.number().min(0).nullish(), internalNotes: z.string().max(5000).nullish(),
    newCustomerAddress: z.object({ line1: z.string().min(2).max(200), city: z.string().max(100).nullish(), postalCode: z.string().max(20).nullish() }).optional() }), req.body ?? {});
  const out = await tx(req, async (db) => {
    const r = await db.maybeOne(`SELECT * FROM service_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r) throw notFound('Service request');
    if (r.status === 'converted') throw unprocessable('This request has already been converted');
    if (!['approved', 'under_review', 'new'].includes(r.status)) throw unprocessable(`A ${r.status} request cannot be converted`);
    let customerId = r.customer_id, addressId = r.address_id;
    if (!customerId) {
      const c = await createCustomer(db, { customerType: 'individual', fullName: r.contact_name, email: r.contact_email, phone: r.contact_phone, status: 'active',
        source: r.source, marketingOptIn: false, notificationOptOut: {}, force: true,
        addresses: b.newCustomerAddress ? [{ label: 'Primary', ...b.newCustomerAddress, isDefault: true }] : r.address_text ? [{ label: 'Primary', line1: r.address_text, isDefault: true }] : undefined } as any,
        req.auth!.userId).catch(async (e) => {
          // Exact duplicate by email/phone -> link to the existing customer instead of failing
          if (e.status === 409 && e.details?.duplicates?.[0]) return { id: e.details.duplicates[0].id };
          throw e;
        });
      customerId = c.id;
      await db.query(`UPDATE service_requests SET customer_id = $2 WHERE id = $1`, [r.id, customerId]);
    }
    const sc = r.service_category_id ? await db.maybeOne(`SELECT name FROM service_categories WHERE id = $1`, [r.service_category_id]) : null;
    const wo = await createWorkOrder(db, req, { customerId, addressId, assetId: r.asset_id, serviceCategoryId: r.service_category_id, serviceRequestId: r.id,
      title: b.title ?? `${sc?.name ?? 'Service'} — ${r.description.slice(0, 60)}`, description: r.description, priority: r.priority,
      scheduledStart: b.scheduledStart, expectedDurationMinutes: b.expectedDurationMinutes, estimatedCost: b.estimatedCost, internalNotes: b.internalNotes,
      branchId: r.branch_id, status: 'approved' });
    await db.query(`UPDATE service_requests SET status = 'converted', work_order_id = $2, reviewed_by = COALESCE(reviewed_by, $3), reviewed_at = COALESCE(reviewed_at, now()) WHERE id = $1`,
      [r.id, wo.id, req.auth!.userId]);
    await audit(db, req, { action: 'service_request.converted', entityType: 'service_request', entityId: r.id, after: { work_order_id: wo.id, number: wo.number } });
    if (b.technicianId && b.scheduledStart) return (await assign(db, req, wo.id, { technicianId: b.technicianId, force: b.force })).workOrder;
    return wo;
  });
  res.status(201).json({ data: out });
}));

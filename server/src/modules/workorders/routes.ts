import { Router, type Request } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { tx, branchScope, tenantSettings } from '../common.js';
import { assign, assertOwnJob, createWorkOrder, OPEN_STATUSES, reschedule, transition, TRANSITIONS, unassign, type WoStatus } from './service.js';
import { defaultLocation, moveStock } from '../inventory/service.js';
import { renderSheetPdf, pdfMoney } from '../../lib/pdf.js';
import { mapsLink } from '../../integrations/maps.js';
import { storage } from '../../integrations/storage.js';
import { sha256 } from '../../lib/crypto.js';
import type { Db } from '../../db/pool.js';

export const workOrdersRouter = Router();
const readAny = requirePermission('work_orders.read', 'work_orders.read_own');
const STATUSES = Object.keys(TRANSITIONS) as WoStatus[];

const woSchema = z.object({
  customerId: z.string().uuid(), addressId: z.string().uuid().nullish(), assetId: z.string().uuid().nullish(), serviceCategoryId: z.string().uuid().nullish(),
  title: z.string().trim().min(3).max(200), description: z.string().max(5000).nullish(), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  scheduledStart: z.string().datetime({ offset: true }).nullish(), expectedDurationMinutes: z.number().int().min(5).max(7 * 24 * 60).nullish(),
  internalNotes: z.string().max(5000).nullish(), customerNotes: z.string().max(5000).nullish(), estimatedCost: z.number().min(0).max(1e10).nullish(),
  branchId: z.string().uuid().nullish(), technicianId: z.string().uuid().nullish(), force: z.boolean().optional(),
});

async function techSeesPrices(db: Db, req: Request) {
  if (req.auth!.permissions.has('work_orders.read')) return true;
  return (await db.one(`SELECT technician_can_see_prices v FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId])).v as boolean;
}

function scopeWhere(req: Request, w: Where) {
  if (!req.auth!.permissions.has('work_orders.read')) w.add('w.assigned_technician_id = ?', req.auth!.technicianId ?? '00000000-0000-0000-0000-000000000000');
  const b = branchScope(req);
  if (b) w.add('w.branch_id = ?', b);
}

const listFilters = listQuery.extend({
  status: z.string().optional(), // comma separated
  priority: z.string().optional(), technicianId: z.string().uuid().optional(), customerId: z.string().uuid().optional(), assetId: z.string().uuid().optional(),
  categoryId: z.string().uuid().optional(), from: z.string().optional(), to: z.string().optional(), unassigned: z.coerce.boolean().optional(),
  overdue: z.coerce.boolean().optional(), open: z.coerce.boolean().optional(), branchId: z.string().uuid().optional(),
});

workOrdersRouter.get('/', readAny, ah(async (req, res) => {
  const q = parse(listFilters, req.query);
  const w = new Where();
  scopeWhere(req, w);
  if (q.status) w.add('w.status = ANY(?)', q.status.split(',').filter((s) => STATUSES.includes(s as WoStatus)));
  if (q.priority) w.add('w.priority = ANY(?)', q.priority.split(','));
  w.addIf(q.technicianId, 'w.assigned_technician_id = ?', q.technicianId);
  w.addIf(q.customerId, 'w.customer_id = ?', q.customerId);
  w.addIf(q.assetId, 'w.asset_id = ?', q.assetId);
  w.addIf(q.categoryId, 'w.service_category_id = ?', q.categoryId);
  w.addIf(q.branchId, 'w.branch_id = ?', q.branchId);
  w.addIf(q.from, 'w.scheduled_start >= ?', q.from);
  w.addIf(q.to, 'w.scheduled_start < ?', q.to);
  if (q.unassigned) w.add(`w.assigned_technician_id IS NULL AND w.status IN ('new','approved','scheduled','on_hold')`);
  if (q.open) w.add('w.status = ANY(?)', OPEN_STATUSES);
  if (q.overdue) w.add(`w.scheduled_start < now() AND w.status IN ('scheduled','assigned','en_route','new','approved')`);
  if (q.q) w.add('(w.number ILIKE ? OR w.title ILIKE ? OR c.full_name ILIKE ? OR c.phone ILIKE ?)', ...Array(4).fill(`%${q.q}%`));
  const order = orderBy(q, { number: 'w.number', scheduled: 'w.scheduled_start', priority: `array_position(ARRAY['urgent','high','normal','low'], w.priority)`,
    status: 'w.status', created: 'w.created_at', customer: 'c.full_name' }, 'w.created_at');
  const rows = await tx(req, async (db) => {
    const prices = await techSeesPrices(db, req);
    return db.many(
      `SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.expected_duration_minutes, w.created_at, w.reschedule_count,
              ${prices ? 'w.estimated_cost, w.actual_cost,' : ''} w.customer_id, c.full_name AS customer_name, c.phone AS customer_phone,
              w.assigned_technician_id, u.full_name AS technician_name, sc.name AS category_name, sc.color AS category_color,
              a.city, a.line1, a.postal_code, ast.name AS asset_name, count(*) OVER() AS _total
         FROM work_orders w JOIN customers c ON c.id = w.customer_id
         LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
         LEFT JOIN service_categories sc ON sc.id = w.service_category_id LEFT JOIN customer_addresses a ON a.id = w.address_id
         LEFT JOIN assets ast ON ast.id = w.asset_id
         ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params);
  });
  res.json(paged(rows, q));
}));

/** Kanban board: open jobs grouped by status (plus the last 30 days of completed). */
workOrdersRouter.get('/board', requirePermission('work_orders.read'), ah(async (req, res) => {
  const w = new Where();
  scopeWhere(req, w);
  w.add(`(w.status = ANY(?) OR (w.status IN ('completed','invoiced') AND w.updated_at > now() - interval '30 days'))`, OPEN_STATUSES);
  const rows = await tx(req, (db) => db.many(
    `SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.version, c.full_name AS customer_name, u.full_name AS technician_name, sc.name AS category_name, a.city
       FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id
       LEFT JOIN users u ON u.id = tp.user_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id LEFT JOIN customer_addresses a ON a.id = w.address_id
       ${w.sql} ORDER BY array_position(ARRAY['urgent','high','normal','low'], w.priority), w.scheduled_start NULLS LAST LIMIT 500`, w.params));
  const columns = ['new', 'approved', 'scheduled', 'assigned', 'en_route', 'in_progress', 'on_hold', 'completed'].map((s) => ({ status: s, items: rows.filter((r) => r.status === s || (s === 'completed' && r.status === 'invoiced')) }));
  res.json({ data: { columns, transitions: TRANSITIONS } });
}));

workOrdersRouter.post('/', requirePermission('work_orders.create'), ah(async (req, res) => {
  const b = parse(woSchema, req.body);
  const out = await tx(req, async (db) => {
    const wo = await createWorkOrder(db, req, { ...b, branchId: b.branchId ?? branchScope(req) });
    if (b.technicianId) {
      if (!req.auth!.permissions.has('work_orders.assign')) throw forbidden('You cannot assign technicians');
      if (!b.scheduledStart) throw badRequest('A scheduled start is required when assigning a technician');
      return (await assign(db, req, wo.id, { technicianId: b.technicianId, force: b.force })).workOrder;
    }
    return wo;
  });
  res.status(201).json({ data: out });
}));

workOrdersRouter.get('/:id', readAny, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const wo = await db.maybeOne(`SELECT w.*, c.full_name AS customer_name, c.phone AS customer_phone, c.alt_phone AS customer_alt_phone, c.email AS customer_email,
        c.company_name, sc.name AS category_name, u.full_name AS technician_name, u.phone AS technician_phone, tp.user_id AS technician_user_id,
        to_jsonb(a.*) AS address, to_jsonb(ast.*) AS asset, sr.number AS request_number, b.name AS branch_name
      FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
      LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
      LEFT JOIN customer_addresses a ON a.id = w.address_id LEFT JOIN assets ast ON ast.id = w.asset_id
      LEFT JOIN service_requests sr ON sr.id = w.service_request_id LEFT JOIN branches b ON b.id = w.branch_id WHERE w.id = $1`, [req.params.id]);
    if (!wo) throw notFound('Work order');
    assertOwnJob(req, wo);
    const prices = await techSeesPrices(db, req);
    const isStaff = req.auth!.permissions.has('work_orders.read');
    const [history, assignments, notes, parts, labour, report, documents, quotations, invoices, feedback] = await Promise.all([
      db.many(`SELECT h.*, u.full_name AS changed_by_name FROM work_order_status_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.work_order_id = $1 ORDER BY h.changed_at`, [wo.id]),
      db.many(`SELECT ja.id, ja.technician_id, lower(ja.time_window) AS starts_at, upper(ja.time_window) AS ends_at, ja.is_current, ja.assigned_at, ja.ended_at, ja.end_reason,
                 ja.assignment_source, u.full_name AS technician_name, ab.full_name AS assigned_by_name
               FROM job_assignments ja JOIN technician_profiles tp ON tp.id = ja.technician_id JOIN users u ON u.id = tp.user_id LEFT JOIN users ab ON ab.id = ja.assigned_by
               WHERE ja.work_order_id = $1 ORDER BY ja.assigned_at DESC`, [wo.id]),
      db.many(`SELECT n.*, u.full_name AS author_name FROM work_order_notes n JOIN users u ON u.id = n.author_id WHERE n.work_order_id = $1 ${isStaff ? '' : `AND (n.visibility = 'customer' OR n.author_id = $2)`} ORDER BY n.created_at`,
        isStaff ? [wo.id] : [wo.id, req.auth!.userId]),
      db.many(`SELECT p.id, p.item_id, p.description, p.quantity, ${prices ? 'p.unit_price,' : ''} p.created_at, i.sku, i.unit FROM work_order_parts p LEFT JOIN inventory_items i ON i.id = p.item_id WHERE p.work_order_id = $1 ORDER BY p.created_at`, [wo.id]),
      db.many(`SELECT l.id, l.description, l.hours, ${prices ? 'l.rate,' : ''} l.created_at, u.full_name AS technician_name FROM work_order_labour l LEFT JOIN technician_profiles tp ON tp.id = l.technician_id LEFT JOIN users u ON u.id = tp.user_id WHERE l.work_order_id = $1 ORDER BY l.created_at`, [wo.id]),
      db.maybeOne(`SELECT * FROM service_reports WHERE work_order_id = $1`, [wo.id]),
      db.many(`SELECT id, file_name, mime_type, size_bytes, category, created_at, visibility, entity_type FROM documents WHERE deleted_at IS NULL
                 AND ((entity_type = 'work_order' AND entity_id = $1) OR (entity_type = 'service_request' AND entity_id = $2)) ORDER BY created_at`, [wo.id, wo.service_request_id]),
      req.auth!.permissions.has('quotations.read') ? db.many(`SELECT id, number, revision, status, total, currency FROM quotations WHERE work_order_id = $1 ORDER BY created_at DESC`, [wo.id]) : [],
      req.auth!.permissions.has('invoices.read') ? db.many(`SELECT id, number, status, total, balance_due, currency FROM invoices WHERE work_order_id = $1 ORDER BY created_at DESC`, [wo.id]) : [],
      db.maybeOne(`SELECT rating, technician_rating, comment, created_at FROM customer_feedback WHERE work_order_id = $1`, [wo.id]),
    ]);
    const out: any = { ...wo, history, assignments, notes, parts, labour, report, documents, quotations, invoices, feedback,
      mapUrl: wo.address ? mapsLink(wo.address) : null, allowedTransitions: TRANSITIONS[wo.status as WoStatus] };
    if (!prices) { delete out.estimated_cost; delete out.actual_cost; }
    if (!isStaff) delete out.internal_notes;
    return out;
  });
  res.json({ data });
}));

workOrdersRouter.patch('/:id', requirePermission('work_orders.update'), ah(async (req, res) => {
  const b = parse(woSchema.omit({ customerId: true, technicianId: true, scheduledStart: true, force: true }).partial().extend({ version: z.number().int().optional() }), req.body);
  const out = await tx(req, async (db) => {
    const before = await db.maybeOne(`SELECT * FROM work_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before) throw notFound('Work order');
    if (b.version !== undefined && b.version !== before.version) throw conflict('This job was changed by someone else. Refresh and try again.');
    if (['invoiced', 'paid', 'cancelled', 'rejected'].includes(before.status)) throw unprocessable(`A ${before.status} job cannot be edited`);
    if (b.addressId && !(await db.maybeOne(`SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [b.addressId, before.customer_id]))) throw badRequest('Invalid address');
    if (b.assetId && !(await db.maybeOne(`SELECT 1 FROM assets WHERE id = $1 AND customer_id = $2`, [b.assetId, before.customer_id]))) throw badRequest('Invalid equipment');
    const m: Record<string, string> = { addressId: 'address_id', assetId: 'asset_id', serviceCategoryId: 'service_category_id', title: 'title', description: 'description',
      priority: 'priority', expectedDurationMinutes: 'expected_duration_minutes', internalNotes: 'internal_notes', customerNotes: 'customer_notes',
      estimatedCost: 'estimated_cost', branchId: 'branch_id' };
    const keys = Object.keys(m).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    if (b.expectedDurationMinutes && before.assigned_technician_id && before.scheduled_start) {
      await db.query(`UPDATE job_assignments SET time_window = tstzrange(lower(time_window), lower(time_window) + ($2 || ' minutes')::interval) WHERE work_order_id = $1 AND is_current`,
        [before.id, String(b.expectedDurationMinutes)]);
    }
    const after = await db.one(`UPDATE work_orders SET ${keys.map((k, i) => `${m[k]} = $${i + 2}`).join(', ')}, version = version + 1 WHERE id = $1 RETURNING *`,
      [before.id, ...keys.map((k) => (b as any)[k])]);
    await audit(db, req, { action: 'work_order.updated', entityType: 'work_order', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

workOrdersRouter.post('/:id/status', requirePermission('work_orders.status', 'work_orders.execute', 'work_orders.cancel'), ah(async (req, res) => {
  const b = parse(z.object({ status: z.enum(STATUSES as [WoStatus, ...WoStatus[]]), note: z.string().max(2000).nullish(), reason: z.string().max(2000).nullish(),
    version: z.number().int().optional(), occurredAt: z.string().datetime({ offset: true }).nullish() }), req.body);
  const out = await tx(req, (db) => transition(db, req, req.params.id, b.status,
    { note: b.note, holdReason: b.reason, cancellationReason: b.reason, expectedVersion: b.version, occurredAt: b.occurredAt }));
  res.json({ data: out });
}));

workOrdersRouter.post('/:id/assign', requirePermission('work_orders.assign'), ah(async (req, res) => {
  const b = parse(z.object({ technicianId: z.string().uuid(), scheduledStart: z.string().datetime({ offset: true }).nullish(),
    durationMinutes: z.number().int().min(5).max(10080).nullish(), force: z.boolean().optional(), source: z.enum(['manual', 'suggestion', 'ai_suggestion']).optional() }), req.body);
  const out = await tx(req, (db) => assign(db, req, req.params.id, b));
  res.json({ data: out });
}));

workOrdersRouter.post('/:id/unassign', requirePermission('work_orders.assign'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().max(500).nullish() }), req.body ?? {});
  res.json({ data: await tx(req, (db) => unassign(db, req, req.params.id, b.reason)) });
}));

workOrdersRouter.post('/:id/reschedule', requirePermission('work_orders.update', 'work_orders.assign'), ah(async (req, res) => {
  const b = parse(z.object({ scheduledStart: z.string().datetime({ offset: true }), durationMinutes: z.number().int().min(5).max(10080).nullish(),
    reason: z.string().max(500).nullish(), force: z.boolean().optional() }), req.body);
  res.json({ data: await tx(req, (db) => reschedule(db, req, req.params.id, b.scheduledStart, b.durationMinutes, b.reason, b.force)) });
}));

/** Technician acknowledges the assignment. */
workOrdersRouter.post('/:id/accept', requirePermission('work_orders.execute'), ah(async (req, res) => {
  const out = await tx(req, async (db) => {
    const wo = await db.maybeOne(`SELECT * FROM work_orders WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!wo || wo.assigned_technician_id !== req.auth!.technicianId) throw notFound('Work order');
    if (wo.accepted_at) return wo;
    const r = await db.one(`UPDATE work_orders SET accepted_at = now() WHERE id = $1 RETURNING *`, [wo.id]);
    await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by) VALUES ($1,$2,$3,$3,'Accepted by technician',$4)`,
      [db.tenantId, wo.id, wo.status, req.auth!.userId]);
    await audit(db, req, { action: 'work_order.accepted', entityType: 'work_order', entityId: wo.id });
    return r;
  });
  res.json({ data: out });
}));

async function loadForWrite(db: Db, req: Request, id: string) {
  const wo = await db.maybeOne(`SELECT * FROM work_orders WHERE id = $1`, [id]);
  if (!wo) throw notFound('Work order');
  assertOwnJob(req, wo);
  return wo;
}

workOrdersRouter.post('/:id/notes', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000), visibility: z.enum(['internal', 'customer']).default('internal') }), req.body);
  const n = await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    return db.one(`INSERT INTO work_order_notes (tenant_id, work_order_id, author_id, visibility, body) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [db.tenantId, wo.id, req.auth!.userId, b.visibility, b.body]);
  });
  res.status(201).json({ data: n });
}));

// ---------------------------------------------------------------- parts used (inventory-controlled)
workOrdersRouter.post('/:id/parts', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(z.object({ itemId: z.string().uuid().nullish(), description: z.string().trim().max(200).optional(), quantity: z.number().positive().max(100000),
    unitPrice: z.number().min(0).optional(), locationId: z.string().uuid().nullish() }), req.body);
  const part = await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    if (!['assigned', 'en_route', 'in_progress', 'on_hold', 'completed'].includes(wo.status)) throw unprocessable('Parts can be recorded once the job is assigned');
    const s = await tenantSettings(db);
    let description = b.description, unitPrice = b.unitPrice ?? 0, unitCost: number | null = null, txnId: string | null = null, locationId: string | null = null;
    if (b.itemId) {
      const item = await db.maybeOne(`SELECT * FROM inventory_items WHERE id = $1 AND is_active`, [b.itemId]);
      if (!item) throw badRequest('Inventory item not found');
      description = description || item.name;
      // Technicians cannot override catalogue prices
      unitPrice = req.auth!.permissions.has('work_orders.update') && b.unitPrice !== undefined ? b.unitPrice : Number(item.selling_price);
      unitCost = Number(item.purchase_price);
      if (s.inventory_enabled) {
        locationId = b.locationId ?? await defaultLocation(db, wo.branch_id, wo.assigned_technician_id);
        const t = await moveStock(db, { itemId: item.id, locationId, quantityChange: -b.quantity, type: 'job_usage', unitCost,
          referenceType: 'work_order', referenceId: wo.id, reason: `Used on ${wo.number}`, userId: req.auth!.userId });
        txnId = t.id;
      }
    } else if (!description) throw badRequest('Description is required for non-catalogue parts');
    const p = await db.one(`INSERT INTO work_order_parts (tenant_id, work_order_id, item_id, location_id, description, quantity, unit_price, unit_cost, inventory_txn_id, created_by)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [db.tenantId, wo.id, b.itemId ?? null, locationId, description, b.quantity, unitPrice, unitCost, txnId, req.auth!.userId]);
    await audit(db, req, { action: 'work_order.part_added', entityType: 'work_order', entityId: wo.id, after: { description, quantity: b.quantity } });
    return p;
  });
  res.status(201).json({ data: part });
}));

workOrdersRouter.delete('/:id/parts/:partId', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    if (['invoiced', 'paid'].includes(wo.status)) throw unprocessable('Parts on an invoiced job cannot be changed');
    const p = await db.maybeOne(`SELECT * FROM work_order_parts WHERE id = $1 AND work_order_id = $2`, [req.params.partId, wo.id]);
    if (!p) throw notFound('Part');
    if (p.inventory_txn_id && p.item_id && p.location_id) {
      await moveStock(db, { itemId: p.item_id, locationId: p.location_id, quantityChange: Number(p.quantity), type: 'job_return', unitCost: p.unit_cost,
        referenceType: 'work_order', referenceId: wo.id, reason: `Returned from ${wo.number}`, userId: req.auth!.userId });
    }
    await db.query(`DELETE FROM work_order_parts WHERE id = $1`, [p.id]);
    await audit(db, req, { action: 'work_order.part_removed', entityType: 'work_order', entityId: wo.id, before: { description: p.description, quantity: p.quantity } });
  });
  res.json({ data: { ok: true } });
}));

workOrdersRouter.post('/:id/labour', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(z.object({ description: z.string().trim().min(2).max(200), hours: z.number().positive().max(200), rate: z.number().min(0).optional() }), req.body);
  const l = await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    if (['invoiced', 'paid', 'cancelled'].includes(wo.status)) throw unprocessable('Labour cannot be added to this job');
    let rate = b.rate ?? 0;
    if (!req.auth!.permissions.has('work_orders.update') || b.rate === undefined) {
      rate = Number((await db.maybeOne(`SELECT default_price FROM service_categories WHERE id = $1`, [wo.service_category_id]))?.default_price ?? 0);
      if (b.rate !== undefined && req.auth!.permissions.has('work_orders.update')) rate = b.rate;
    }
    return db.one(`INSERT INTO work_order_labour (tenant_id, work_order_id, technician_id, description, hours, rate, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [db.tenantId, wo.id, req.auth!.technicianId ?? wo.assigned_technician_id, b.description, b.hours, rate, req.auth!.userId]);
  });
  res.status(201).json({ data: l });
}));

workOrdersRouter.delete('/:id/labour/:labourId', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    if (['invoiced', 'paid'].includes(wo.status)) throw unprocessable('Labour on an invoiced job cannot be changed');
    await db.query(`DELETE FROM work_order_labour WHERE id = $1 AND work_order_id = $2`, [req.params.labourId, wo.id]);
  });
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- service report & customer sign-off
const reportSchema = z.object({ reportedIssue: z.string().max(5000).nullish(), findings: z.string().max(10000).nullish(), workPerformed: z.string().max(10000).nullish(),
  recommendations: z.string().max(5000).nullish(), followUpRequired: z.boolean().optional(), followUpNotes: z.string().max(2000).nullish(),
  equipmentCondition: z.enum(['good', 'fair', 'poor', 'critical']).nullish(), technicianNotes: z.string().max(10000).nullish(), aiGenerated: z.boolean().optional() });

workOrdersRouter.put('/:id/report', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(reportSchema, req.body);
  const r = await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    if (['invoiced', 'paid', 'cancelled', 'rejected'].includes(wo.status)) throw unprocessable('The service report is locked for this job');
    const existing = await db.maybeOne(`SELECT * FROM service_reports WHERE work_order_id = $1`, [wo.id]);
    if (existing?.customer_approved_at) throw unprocessable('The customer has signed this report; it can no longer be edited');
    const r = await db.one(`INSERT INTO service_reports (tenant_id, work_order_id, reported_issue, findings, work_performed, recommendations, follow_up_required, follow_up_notes,
        equipment_condition, technician_notes, ai_generated, created_by) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7,false),$8,$9,$10,COALESCE($11,false),$12)
      ON CONFLICT (tenant_id, work_order_id) DO UPDATE SET reported_issue = EXCLUDED.reported_issue, findings = EXCLUDED.findings, work_performed = EXCLUDED.work_performed,
        recommendations = EXCLUDED.recommendations, follow_up_required = EXCLUDED.follow_up_required, follow_up_notes = EXCLUDED.follow_up_notes,
        equipment_condition = EXCLUDED.equipment_condition, technician_notes = EXCLUDED.technician_notes, ai_generated = EXCLUDED.ai_generated RETURNING *`,
      [db.tenantId, wo.id, b.reportedIssue ?? wo.description, b.findings ?? null, b.workPerformed ?? null, b.recommendations ?? null, b.followUpRequired ?? null,
        b.followUpNotes ?? null, b.equipmentCondition ?? null, b.technicianNotes ?? null, b.aiGenerated ?? null, req.auth!.userId]);
    if (b.equipmentCondition === 'critical' && wo.asset_id) await db.query(`UPDATE assets SET status = 'under_repair' WHERE id = $1 AND status = 'active'`, [wo.asset_id]);
    return r;
  });
  res.json({ data: r });
}));

/** Customer sign-off captured on the technician's device: PNG signature (data URL) + printed name. */
workOrdersRouter.post('/:id/signature', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(z.object({ signedName: z.string().trim().min(2).max(120), signature: z.string().regex(/^data:image\/png;base64,[A-Za-z0-9+/=]+$/).max(700_000),
    approved: z.literal(true) }), req.body);
  const out = await tx(req, async (db) => {
    const wo = await loadForWrite(db, req, req.params.id);
    const report = await db.maybeOne(`SELECT * FROM service_reports WHERE work_order_id = $1 FOR UPDATE`, [wo.id]);
    if (!report?.work_performed) throw unprocessable('Complete the service report before collecting the customer signature');
    if (report.customer_approved_at) throw conflict('This report has already been signed');
    const png = Buffer.from(b.signature.split(',')[1], 'base64');
    if (png.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw badRequest('Invalid signature image');
    const key = `${db.tenantId}/signatures/${crypto.randomUUID()}.png`;
    await storage.put(key, png, 'image/png');
    const doc = await db.one(`INSERT INTO documents (tenant_id, entity_type, entity_id, category, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by, visibility)
      VALUES ($1,'work_order',$2,'signature',$3,'image/png',$4,$5,$6,$7,'customer') RETURNING id`, [db.tenantId, wo.id, `signature-${wo.number}.png`, png.length, sha256(png), key, req.auth!.userId]);
    const r = await db.one(`UPDATE service_reports SET customer_signed_name = $2, customer_signature_document_id = $3, customer_approved_at = now() WHERE id = $1 RETURNING *`,
      [report.id, b.signedName, doc.id]);
    await audit(db, req, { action: 'work_order.customer_signed', entityType: 'work_order', entityId: wo.id, after: { signed_name: b.signedName } });
    return r;
  });
  res.json({ data: out });
}));

// ---------------------------------------------------------------- printable documents
async function sheetData(db: Db, req: Request, id: string, kind: 'job' | 'report') {
  const wo = await db.maybeOne(`SELECT w.*, c.full_name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, sc.name AS category_name,
      u.full_name AS technician_name, a.line1, a.line2, a.city, a.postal_code, a.access_notes, ast.name AS asset_name, ast.manufacturer, ast.model, ast.serial_number
    FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
    LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
    LEFT JOIN customer_addresses a ON a.id = w.address_id LEFT JOIN assets ast ON ast.id = w.asset_id WHERE w.id = $1`, [id]);
  if (!wo) throw notFound('Work order');
  assertOwnJob(req, wo);
  const s = await tenantSettings(db);
  const prices = await techSeesPrices(db, req);
  const parts = await db.many(`SELECT description, quantity, unit_price FROM work_order_parts WHERE work_order_id = $1`, [id]);
  const labour = await db.many(`SELECT description, hours, rate FROM work_order_labour WHERE work_order_id = $1`, [id]);
  const report = await db.maybeOne(`SELECT * FROM service_reports WHERE work_order_id = $1`, [id]);
  let signature: Buffer | null = null;
  if (report?.customer_signature_document_id) {
    const d = await db.maybeOne(`SELECT storage_key FROM documents WHERE id = $1`, [report.customer_signature_document_id]);
    if (d) { const chunks: Buffer[] = []; for await (const c of await storage.get(d.storage_key)) chunks.push(c as Buffer); signature = Buffer.concat(chunks); }
  }
  const dt = (v: any) => (v ? new Intl.DateTimeFormat(s.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: s.timezone }).format(new Date(v)) : '—');
  const sections = [
    { heading: 'Customer', rows: [['Name', wo.customer_name], ['Phone', wo.customer_phone ?? ''], ['Address', [wo.line1, wo.line2, wo.city, wo.postal_code].filter(Boolean).join(', ')],
      ['Access notes', wo.access_notes ?? '']] as [string, string][] },
    { heading: 'Job', rows: [['Job', `${wo.number} — ${wo.title}`], ['Service', wo.category_name ?? ''], ['Priority', wo.priority], ['Scheduled', dt(wo.scheduled_start)],
      ['Technician', wo.technician_name ?? 'Unassigned'], ['Started', dt(wo.actual_start)], ['Completed', dt(wo.actual_end)]] as [string, string][] },
    ...(wo.asset_name ? [{ heading: 'Equipment', rows: [['Equipment', wo.asset_name], ['Make / model', [wo.manufacturer, wo.model].filter(Boolean).join(' ')], ['Serial no.', wo.serial_number ?? '']] as [string, string][] }] : []),
    { heading: 'Description', text: wo.description ?? '—' },
  ];
  if (kind === 'report' && report) {
    sections.push(
      { heading: 'Reported issue', text: report.reported_issue ?? '—' }, { heading: 'Inspection findings', text: report.findings ?? '—' },
      { heading: 'Work performed', text: report.work_performed ?? '—' }, { heading: 'Recommendations', text: report.recommendations ?? '—' },
      { heading: 'Follow-up', rows: [['Required', report.follow_up_required ? 'Yes' : 'No'], ['Notes', report.follow_up_notes ?? ''], ['Equipment condition', report.equipment_condition ?? '']] as [string, string][] } as any);
  }
  if (parts.length) sections.push({ heading: 'Parts used', table: { head: prices ? ['Part', 'Qty', 'Unit price'] : ['Part', 'Qty'],
    rows: parts.map((p) => (prices ? [p.description, String(Number(p.quantity)), pdfMoney(p.unit_price, s.currency, s.locale)] : [p.description, String(Number(p.quantity))])) } } as any);
  if (labour.length) sections.push({ heading: 'Labour', table: { head: ['Work', 'Hours'], rows: labour.map((l) => [l.description, String(Number(l.hours))]) } } as any);
  if (kind === 'job') sections.push({ heading: 'Technician notes', text: '\n\n\n\n' });
  return {
    title: kind === 'job' ? 'Job Sheet' : 'Service Report', number: wo.number, status: wo.status,
    seller: { name: s.business_name, lines: [s.address_line1, [s.city, s.postal_code].filter(Boolean).join(' '), s.business_phone, s.business_email], taxLabel: s.tax_registration_label, taxId: s.tax_registration_number },
    sections, signature, signedBy: report?.customer_signed_name, signedAt: report?.customer_approved_at ? dt(report.customer_approved_at) : null,
  };
}

for (const [path, kind] of [['job-sheet.pdf', 'job'], ['report.pdf', 'report']] as const) {
  workOrdersRouter.get(`/:id/${path}`, readAny, ah(async (req, res) => {
    const d = await tx(req, (db) => sheetData(db, req, req.params.id, kind));
    const pdf = await renderSheetPdf(d);
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${d.number}-${kind}.pdf"`);
    res.send(pdf);
  }));
}

// ---------------------------------------------------------------- bulk operations (each item validated individually)
workOrdersRouter.post('/bulk', requirePermission('work_orders.update'), ah(async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(100), action: z.enum(['priority', 'cancel', 'approve']),
    priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(), reason: z.string().max(500).optional() }), req.body);
  if (b.action === 'cancel' && !req.auth!.permissions.has('work_orders.cancel')) throw forbidden();
  if (b.action === 'cancel' && !b.reason) throw badRequest('A reason is required to cancel jobs');
  const results: { id: string; ok: boolean; error?: string }[] = [];
  for (const id of b.ids) {
    try {
      await tx(req, async (db) => {
        if (b.action === 'priority') {
          const r = await db.maybeOne(`UPDATE work_orders SET priority = $2, version = version + 1 WHERE id = $1 AND status = ANY($3) RETURNING id`, [id, b.priority ?? 'normal', OPEN_STATUSES]);
          if (!r) throw unprocessable('Job is not open');
          await audit(db, req, { action: 'work_order.priority_changed', entityType: 'work_order', entityId: id, after: { priority: b.priority } });
        } else await transition(db, req, id, b.action === 'cancel' ? 'cancelled' : 'approved', { cancellationReason: b.reason, note: b.reason });
      });
      results.push({ id, ok: true });
    } catch (e: any) { results.push({ id, ok: false, error: e.message }); }
  }
  res.json({ data: { results, succeeded: results.filter((r) => r.ok).length, failed: results.filter((r) => !r.ok).length } });
}));

export { dateStr };

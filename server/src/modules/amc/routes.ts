import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, branchScope, tenantSettings } from '../common.js';
import { createWorkOrder } from '../workorders/service.js';
import { createInvoiceDraft, issueInvoice } from '../invoices/service.js';
import { createQuotation } from '../quotations/routes.js';
import type { Db } from '../../db/pool.js';

export const amcRouter = Router();
const read = requirePermission('amc.read');
const manage = requirePermission('amc.manage');
const MONTHS: Record<string, number> = { monthly: 1, quarterly: 3, half_yearly: 6, annual: 12 };

const amcSchema = z.object({
  customerId: z.string().uuid(), addressId: z.string().uuid().nullish(), serviceCategoryId: z.string().uuid().nullish(), title: z.string().trim().min(3).max(200),
  startDate: dateStr, endDate: dateStr, frequency: z.enum(['monthly', 'quarterly', 'half_yearly', 'annual']), visitsIncluded: z.number().int().min(1).max(366).optional(),
  contractValue: z.number().min(0), coverage: z.string().max(5000).nullish(), exclusions: z.string().max(5000).nullish(), autoRenew: z.boolean().default(false),
  renewalReminderDays: z.number().int().min(1).max(180).default(30), assetIds: z.array(z.string().uuid()).max(100).default([]),
});

/** Visit dates spread across the contract term by frequency. */
export function visitSchedule(start: string, end: string, frequency: string, count?: number) {
  const step = MONTHS[frequency];
  const s = new Date(`${start}T00:00:00Z`), e = new Date(`${end}T00:00:00Z`);
  const dates: string[] = [];
  for (let i = 0; ; i++) {
    const d = new Date(s); d.setUTCMonth(d.getUTCMonth() + i * step);
    if (d > e) break;
    dates.push(d.toISOString().slice(0, 10));
    if (count && dates.length >= count) break;
  }
  return dates;
}

/** Idempotent: UNIQUE (contract_id, visit_number) means re-running never duplicates visits. */
export async function generateVisits(db: Db, contractId: string) {
  const c = await db.one(`SELECT * FROM amc_contracts WHERE id = $1`, [contractId]);
  const dates = visitSchedule(c.start_date, c.end_date, c.frequency, c.visits_included);
  let created = 0;
  for (let i = 0; i < dates.length; i++) {
    const r = await db.query(`INSERT INTO scheduled_visits (tenant_id, contract_id, visit_number, due_date) VALUES ($1,$2,$3,$4) ON CONFLICT (contract_id, visit_number) DO NOTHING`,
      [db.tenantId, c.id, i + 1, dates[i]]);
    created += r.rowCount ?? 0;
  }
  return created;
}

export async function createVisitWorkOrder(db: Db, req: Request | null, visitId: string) {
  const v = await db.maybeOne(`SELECT v.*, c.customer_id, c.address_id, c.service_category_id, c.title, c.number, c.status AS contract_status, c.branch_id
    FROM scheduled_visits v JOIN amc_contracts c ON c.id = v.contract_id WHERE v.id = $1 FOR UPDATE OF v`, [visitId]);
  if (!v) throw notFound('Visit');
  if (v.contract_status !== 'active') throw unprocessable('The contract is not active');
  if (v.work_order_id || v.status !== 'scheduled') return null;
  const asset = await db.maybeOne(`SELECT asset_id FROM amc_contract_assets WHERE contract_id = $1 LIMIT 1`, [v.contract_id]);
  const assetCount = await db.one(`SELECT count(*)::int n FROM amc_contract_assets WHERE contract_id = $1`, [v.contract_id]);
  const wo = await createWorkOrder(db, req, { customerId: v.customer_id, addressId: v.address_id, assetId: assetCount.n === 1 ? asset?.asset_id : null,
    serviceCategoryId: v.service_category_id, amcVisitId: v.id, title: `AMC visit ${v.visit_number} — ${v.title}`, branchId: v.branch_id,
    description: `Scheduled preventive maintenance under contract ${v.number} (visit ${v.visit_number}, due ${v.due_date}).`, priority: 'normal', status: 'approved' });
  await db.query(`UPDATE scheduled_visits SET status = 'work_order_created', work_order_id = $2 WHERE id = $1`, [v.id, wo.id]);
  return wo;
}

amcRouter.get('/', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), customerId: z.string().uuid().optional(), expiringDays: z.coerce.number().int().optional() }), req.query);
  const w = new Where();
  if (q.status) w.add('m.status = ANY(?)', q.status.split(','));
  w.addIf(q.customerId, 'm.customer_id = ?', q.customerId);
  if (q.expiringDays) w.add(`m.status = 'active' AND m.end_date <= current_date + ?::int`, q.expiringDays);
  const b = branchScope(req); if (b) w.add('m.branch_id = ?', b);
  if (q.q) w.add('(m.number ILIKE ? OR m.title ILIKE ? OR c.full_name ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const order = orderBy(q, { number: 'm.number', end: 'm.end_date', start: 'm.start_date', value: 'm.contract_value' }, 'm.created_at');
  const rows = await tx(req, (db) => db.many(`SELECT m.id, m.number, m.title, m.status, m.start_date, m.end_date, m.frequency, m.visits_included, m.contract_value, m.currency,
      m.payment_status, m.auto_renew, c.id AS customer_id, c.full_name AS customer_name,
      (SELECT count(*) FROM scheduled_visits v WHERE v.contract_id = m.id AND v.status = 'completed')::int AS visits_completed,
      (SELECT min(due_date) FROM scheduled_visits v WHERE v.contract_id = m.id AND v.status IN ('scheduled','work_order_created')) AS next_visit, count(*) OVER() AS _total
    FROM amc_contracts m JOIN customers c ON c.id = m.customer_id ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

async function insertContract(db: Db, req: Request, b: z.infer<typeof amcSchema>, renewedFrom?: string) {
  if (b.endDate <= b.startDate) throw badRequest('End date must be after start date');
  const c = await db.maybeOne(`SELECT id, branch_id FROM customers WHERE id = $1 AND archived_at IS NULL`, [b.customerId]);
  if (!c) throw badRequest('Customer not found');
  if (b.assetIds.length) {
    const n = await db.one(`SELECT count(*)::int n FROM assets WHERE id = ANY($1) AND customer_id = $2`, [b.assetIds, b.customerId]);
    if (n.n !== b.assetIds.length) throw badRequest('All equipment must belong to the customer');
  }
  const s = await tenantSettings(db);
  const visits = b.visitsIncluded ?? visitSchedule(b.startDate, b.endDate, b.frequency).length;
  const m = await db.one(`INSERT INTO amc_contracts (tenant_id, branch_id, number, customer_id, address_id, service_category_id, title, start_date, end_date, frequency, visits_included,
      contract_value, currency, coverage, exclusions, auto_renew, renewal_reminder_days, renewed_from_id, created_by)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [db.tenantId, c.branch_id, await nextNumber(db, 'amc'), b.customerId, b.addressId ?? null, b.serviceCategoryId ?? null, b.title, b.startDate, b.endDate, b.frequency,
      visits, b.contractValue, s.currency, b.coverage ?? null, b.exclusions ?? null, b.autoRenew, b.renewalReminderDays, renewedFrom ?? null, req.auth!.userId]);
  for (const a of b.assetIds) await db.query(`INSERT INTO amc_contract_assets (tenant_id, contract_id, asset_id) VALUES ($1,$2,$3)`, [db.tenantId, m.id, a]);
  await audit(db, req, { action: 'amc.created', entityType: 'amc_contract', entityId: m.id, after: { number: m.number, value: m.contract_value } });
  return m;
}

amcRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(amcSchema, req.body);
  res.status(201).json({ data: await tx(req, (db) => insertContract(db, req, b)) });
}));

amcRouter.get('/:id', read, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const m = await db.maybeOne(`SELECT m.*, c.full_name AS customer_name, c.phone AS customer_phone, sc.name AS category_name, to_jsonb(a.*) AS address, r.number AS renewed_from_number,
        (SELECT id FROM amc_contracts x WHERE x.renewed_from_id = m.id LIMIT 1) AS renewal_id
      FROM amc_contracts m JOIN customers c ON c.id = m.customer_id LEFT JOIN service_categories sc ON sc.id = m.service_category_id
      LEFT JOIN customer_addresses a ON a.id = m.address_id LEFT JOIN amc_contracts r ON r.id = m.renewed_from_id WHERE m.id = $1`, [req.params.id]);
    if (!m) throw notFound('Contract');
    const [visits, assets, invoices, documents, quotations] = await Promise.all([
      db.many(`SELECT v.*, w.number AS work_order_number, w.status AS work_order_status, w.scheduled_start FROM scheduled_visits v LEFT JOIN work_orders w ON w.id = v.work_order_id
        WHERE v.contract_id = $1 ORDER BY v.visit_number`, [m.id]),
      db.many(`SELECT a.id, a.number, a.name, a.model, a.serial_number FROM amc_contract_assets x JOIN assets a ON a.id = x.asset_id WHERE x.contract_id = $1`, [m.id]),
      db.many(`SELECT id, number, status, total, balance_due, currency, issue_date FROM invoices WHERE amc_contract_id = $1 ORDER BY created_at`, [m.id]),
      db.many(`SELECT id, file_name, mime_type, size_bytes, category, created_at FROM documents WHERE entity_type = 'amc_contract' AND entity_id = $1 AND deleted_at IS NULL`, [m.id]),
      db.many(`SELECT id, number, revision, status, total FROM quotations WHERE amc_contract_id = $1 ORDER BY created_at DESC`, [m.id]),
    ]);
    const completed = visits.filter((v) => v.status === 'completed').length;
    return { ...m, visits, assets, invoices, documents, quotations, visitsCompleted: completed, visitsRemaining: m.visits_included - completed };
  });
  res.json({ data });
}));

amcRouter.patch('/:id', manage, ah(async (req, res) => {
  const b = parse(amcSchema.partial().omit({ customerId: true }), req.body);
  const out = await tx(req, async (db) => {
    const before = await db.maybeOne(`SELECT * FROM amc_contracts WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!before) throw notFound('Contract');
    const commercial = ['startDate', 'endDate', 'frequency', 'visitsIncluded', 'contractValue'].some((k) => (b as any)[k] !== undefined);
    if (commercial && before.status !== 'draft') throw unprocessable('Dates, frequency and price can only be changed while the contract is a draft. Renew or cancel instead.');
    const m: Record<string, string> = { addressId: 'address_id', serviceCategoryId: 'service_category_id', title: 'title', startDate: 'start_date', endDate: 'end_date', frequency: 'frequency',
      visitsIncluded: 'visits_included', contractValue: 'contract_value', coverage: 'coverage', exclusions: 'exclusions', autoRenew: 'auto_renew', renewalReminderDays: 'renewal_reminder_days' };
    const keys = Object.keys(m).filter((k) => (b as any)[k] !== undefined);
    const after = keys.length ? await db.one(`UPDATE amc_contracts SET ${keys.map((k, i) => `${m[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (b as any)[k])]) : before;
    if (b.assetIds) {
      await db.query(`DELETE FROM amc_contract_assets WHERE contract_id = $1`, [before.id]);
      for (const a of b.assetIds) await db.query(`INSERT INTO amc_contract_assets (tenant_id, contract_id, asset_id) VALUES ($1,$2,$3)`, [db.tenantId, before.id, a]);
    }
    await audit(db, req, { action: 'amc.updated', entityType: 'amc_contract', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

/** Activation generates the visit schedule and (optionally) the contract invoice. */
amcRouter.post('/:id/activate', manage, ah(async (req, res) => {
  const b = parse(z.object({ createInvoice: z.boolean().default(true), issueInvoice: z.boolean().default(false) }), req.body ?? {});
  const out = await tx(req, async (db) => {
    const m = await db.maybeOne(`SELECT * FROM amc_contracts WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!m) throw notFound('Contract');
    if (m.status !== 'draft') throw unprocessable('Only draft contracts can be activated');
    if (m.end_date < new Date().toISOString().slice(0, 10)) throw unprocessable('This contract has already ended');
    await db.query(`UPDATE amc_contracts SET status = 'active' WHERE id = $1`, [m.id]);
    const visits = await generateVisits(db, m.id);
    let invoiceId: string | null = null;
    if (b.createInvoice && Number(m.contract_value) > 0 && req.auth!.permissions.has('invoices.manage')) {
      const tax = await db.maybeOne(`SELECT id FROM tax_rates WHERE is_default AND is_active LIMIT 1`);
      const inv = await createInvoiceDraft(db, req, { customerId: m.customer_id, amcContractId: m.id, items: [{ itemType: 'amc', description: `${m.title} (${m.number}) — ${m.start_date} to ${m.end_date}`,
        quantity: 1, unitPrice: Number(m.contract_value), discountPercent: 0, taxRateId: tax?.id ?? null }] });
      invoiceId = inv.id;
      if (b.issueInvoice) await issueInvoice(db, req, inv.id);
    }
    if (m.renewed_from_id) await db.query(`UPDATE amc_contracts SET status = 'renewed' WHERE id = $1 AND status IN ('active','expired')`, [m.renewed_from_id]);
    await audit(db, req, { action: 'amc.activated', entityType: 'amc_contract', entityId: m.id, after: { visits, invoiceId } });
    return { visitsGenerated: visits, invoiceId };
  });
  res.json({ data: out });
}));

amcRouter.post('/:id/cancel', manage, ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
  await tx(req, async (db) => {
    const m = await db.maybeOne(`SELECT * FROM amc_contracts WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!m) throw notFound('Contract');
    if (['cancelled', 'renewed', 'expired'].includes(m.status)) throw unprocessable(`A ${m.status} contract cannot be cancelled`);
    await db.query(`UPDATE amc_contracts SET status = 'cancelled', cancelled_reason = $2 WHERE id = $1`, [m.id, b.reason]);
    await db.query(`UPDATE scheduled_visits SET status = 'cancelled' WHERE contract_id = $1 AND status = 'scheduled'`, [m.id]);
    await audit(db, req, { action: 'amc.cancelled', entityType: 'amc_contract', entityId: m.id, after: { reason: b.reason } });
  });
  res.json({ data: { ok: true } });
}));

/** Creates the next-term draft contract plus a renewal quotation for the customer. */
amcRouter.post('/:id/renew', manage, ah(async (req, res) => {
  const b = parse(z.object({ contractValue: z.number().min(0).optional(), createQuotation: z.boolean().default(true) }), req.body ?? {});
  const out = await tx(req, async (db) => {
    const m = await db.maybeOne(`SELECT * FROM amc_contracts WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!m) throw notFound('Contract');
    if (!['active', 'expired'].includes(m.status)) throw unprocessable('Only active or expired contracts can be renewed');
    if (await db.maybeOne(`SELECT 1 FROM amc_contracts WHERE renewed_from_id = $1 AND status <> 'cancelled'`, [m.id])) throw unprocessable('A renewal already exists for this contract');
    const start = new Date(`${m.end_date}T00:00:00Z`); start.setUTCDate(start.getUTCDate() + 1);
    const termDays = Math.round((new Date(m.end_date).getTime() - new Date(m.start_date).getTime()) / 86400000);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + termDays);
    const assets = (await db.many(`SELECT asset_id FROM amc_contract_assets WHERE contract_id = $1`, [m.id])).map((a) => a.asset_id);
    const renewal = await insertContract(db, req, { customerId: m.customer_id, addressId: m.address_id, serviceCategoryId: m.service_category_id, title: m.title,
      startDate: start.toISOString().slice(0, 10), endDate: end.toISOString().slice(0, 10), frequency: m.frequency, visitsIncluded: m.visits_included,
      contractValue: b.contractValue ?? Number(m.contract_value), coverage: m.coverage, exclusions: m.exclusions, autoRenew: m.auto_renew, renewalReminderDays: m.renewal_reminder_days, assetIds: assets }, m.id);
    let quotationId: string | null = null;
    if (b.createQuotation && req.auth!.permissions.has('quotations.manage')) {
      const tax = await db.maybeOne(`SELECT id FROM tax_rates WHERE is_default AND is_active LIMIT 1`);
      const q = await createQuotation(db, req, { customerId: m.customer_id, amcContractId: renewal.id, title: `Renewal of ${m.number}`,
        items: [{ itemType: 'charge', description: `${m.title} renewal — ${renewal.start_date} to ${renewal.end_date} (${m.visits_included} visits, ${m.frequency.replace('_', '-')})`,
          quantity: 1, unitPrice: Number(renewal.contract_value), discountPercent: 0, taxRateId: tax?.id ?? null }] });
      quotationId = q.id;
    }
    return { renewal, quotationId };
  });
  res.status(201).json({ data: out });
}));

amcRouter.post('/visits/:visitId/work-order', manage, ah(async (req, res) => {
  const wo = await tx(req, (db) => createVisitWorkOrder(db, req, req.params.visitId));
  if (!wo) throw unprocessable('A work order already exists for this visit');
  res.status(201).json({ data: wo });
}));

amcRouter.get('/visits/upcoming', read, ah(async (req, res) => {
  const q = parse(z.object({ days: z.coerce.number().int().min(1).max(365).default(30) }), req.query);
  res.json({ data: await tx(req, (db) => db.many(`SELECT v.*, m.number AS contract_number, m.title, c.full_name AS customer_name, w.number AS work_order_number
    FROM scheduled_visits v JOIN amc_contracts m ON m.id = v.contract_id JOIN customers c ON c.id = m.customer_id LEFT JOIN work_orders w ON w.id = v.work_order_id
    WHERE m.status = 'active' AND v.status IN ('scheduled','work_order_created') AND v.due_date <= current_date + $1::int ORDER BY v.due_date LIMIT 500`, [q.days])) });
}));

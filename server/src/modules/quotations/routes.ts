import { Router, type Request } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, branchScope, tenantSettings, fmtMoney } from '../common.js';
import { buildLines, insertLines, lineSchema } from '../invoices/service.js';
import { renderFinancialPdf, pdfMoney } from '../../lib/pdf.js';
import { notify } from '../notifications/service.js';
import { config } from '../../config.js';
import type { Db } from '../../db/pool.js';

export const quotationsRouter = Router();
const read = requirePermission('quotations.read');
const manage = requirePermission('quotations.manage');

const quoteSchema = z.object({
  customerId: z.string().uuid(), workOrderId: z.string().uuid().nullish(), amcContractId: z.string().uuid().nullish(), title: z.string().max(200).nullish(),
  validUntil: dateStr.nullish(), notes: z.string().max(5000).nullish(), terms: z.string().max(10000).nullish(), items: z.array(lineSchema).min(1).max(200),
});

export async function createQuotation(db: Db, req: Request | null, b: z.infer<typeof quoteSchema>, chain?: { root: string; previous: string; revision: number; number: string; reason: string }) {
  const c = await db.maybeOne(`SELECT id, branch_id FROM customers WHERE id = $1 AND archived_at IS NULL`, [b.customerId]);
  if (!c) throw badRequest('Customer not found');
  if (b.workOrderId && !(await db.maybeOne(`SELECT 1 FROM work_orders WHERE id = $1 AND customer_id = $2`, [b.workOrderId, b.customerId]))) throw badRequest('Work order does not belong to this customer');
  const s = await tenantSettings(db);
  const { lines, totals } = await buildLines(db, b.items);
  const q = await db.one(
    `INSERT INTO quotations (tenant_id, branch_id, number, revision, root_quotation_id, previous_revision_id, revision_reason, customer_id, work_order_id, amc_contract_id, title, currency,
       valid_until, subtotal, discount_total, tax_total, total, tax_breakdown, notes, terms, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, COALESCE($13::date, current_date + $14::int),$15,$16,$17,$18,$19,$20,$21,$22) RETURNING *`,
    [db.tenantId, c.branch_id, chain?.number ?? await nextNumber(db, 'quotation'), chain?.revision ?? 1, chain?.root ?? null, chain?.previous ?? null, chain?.reason ?? null,
      b.customerId, b.workOrderId ?? null, b.amcContractId ?? null, b.title ?? null, s.currency, b.validUntil ?? null, s.quotation_validity_days,
      totals.subtotal, totals.discount_total, totals.tax_total, totals.total, JSON.stringify(totals.tax_breakdown), b.notes ?? null, b.terms ?? s.quotation_terms, req?.auth?.userId ?? null]);
  if (!chain) await db.query(`UPDATE quotations SET root_quotation_id = id WHERE id = $1`, [q.id]);
  await insertLines(db, 'quotation_items', 'quotation_id', q.id, lines);
  await audit(db, req, { action: chain ? 'quotation.revised' : 'quotation.created', entityType: 'quotation', entityId: q.id, after: { number: q.number, revision: q.revision, total: q.total, reason: chain?.reason } });
  return q;
}

quotationsRouter.get('/', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), customerId: z.string().uuid().optional(), latestOnly: z.coerce.boolean().default(true) }), req.query);
  const w = new Where();
  if (q.status) w.add('qt.status = ANY(?)', q.status.split(','));
  w.addIf(q.customerId, 'qt.customer_id = ?', q.customerId);
  if (q.latestOnly) w.add(`qt.status <> 'superseded'`);
  const b = branchScope(req); if (b) w.add('qt.branch_id = ?', b);
  if (q.q) w.add('(qt.number ILIKE ? OR c.full_name ILIKE ? OR qt.title ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const order = orderBy(q, { number: 'qt.number', total: 'qt.total', issued: 'qt.issue_date', valid: 'qt.valid_until', created: 'qt.created_at' }, 'qt.created_at');
  const rows = await tx(req, (db) => db.many(`SELECT qt.id, qt.number, qt.revision, qt.status, qt.title, qt.total, qt.currency, qt.issue_date, qt.valid_until, qt.created_at,
      qt.customer_id, c.full_name AS customer_name, w.number AS work_order_number, count(*) OVER() AS _total
    FROM quotations qt JOIN customers c ON c.id = qt.customer_id LEFT JOIN work_orders w ON w.id = qt.work_order_id
    ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

quotationsRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(quoteSchema, req.body);
  res.status(201).json({ data: await tx(req, (db) => createQuotation(db, req, b)) });
}));

export async function quotationDetail(db: Db, id: string) {
  const q = await db.maybeOne(`SELECT qt.*, c.full_name AS customer_name, c.company_name, c.email AS customer_email, c.phone AS customer_phone, w.number AS work_order_number,
      (SELECT id FROM invoices i WHERE i.quotation_id = qt.id AND i.status <> 'cancelled' LIMIT 1) AS invoice_id
    FROM quotations qt JOIN customers c ON c.id = qt.customer_id LEFT JOIN work_orders w ON w.id = qt.work_order_id WHERE qt.id = $1`, [id]);
  if (!q) throw notFound('Quotation');
  const items = await db.many(`SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position`, [id]);
  const revisions = await db.many(`SELECT id, number, revision, status, total, created_at, revision_reason FROM quotations WHERE root_quotation_id = $1 ORDER BY revision`, [q.root_quotation_id ?? q.id]);
  return { ...q, items, revisions };
}

quotationsRouter.get('/:id', read, ah(async (req, res) => { res.json({ data: await tx(req, (db) => quotationDetail(db, req.params.id)) }); }));

quotationsRouter.put('/:id', manage, ah(async (req, res) => {
  const b = parse(quoteSchema.omit({ customerId: true }), req.body);
  const out = await tx(req, async (db) => {
    const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!q) throw notFound('Quotation');
    if (q.status !== 'draft') throw unprocessable('Only drafts can be edited. Create a revision to change a sent or approved quotation.');
    const { lines, totals } = await buildLines(db, b.items);
    await db.query(`DELETE FROM quotation_items WHERE quotation_id = $1`, [q.id]);
    await insertLines(db, 'quotation_items', 'quotation_id', q.id, lines);
    const after = await db.one(`UPDATE quotations SET title = $2, valid_until = COALESCE($3, valid_until), notes = $4, terms = $5, work_order_id = $6, subtotal = $7,
      discount_total = $8, tax_total = $9, total = $10, tax_breakdown = $11 WHERE id = $1 RETURNING *`,
      [q.id, b.title ?? null, b.validUntil ?? null, b.notes ?? null, b.terms ?? null, b.workOrderId ?? q.work_order_id, totals.subtotal, totals.discount_total, totals.tax_total, totals.total, JSON.stringify(totals.tax_breakdown)]);
    await audit(db, req, { action: 'quotation.updated', entityType: 'quotation', entityId: q.id, before: { total: q.total }, after: { total: after.total } });
    return after;
  });
  res.json({ data: out });
}));

quotationsRouter.delete('/:id', manage, ah(async (req, res) => {
  await tx(req, async (db) => {
    const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!q) throw notFound('Quotation');
    if (q.status !== 'draft') throw unprocessable('Only draft quotations can be deleted');
    if (q.previous_revision_id) await db.query(`UPDATE quotations SET status = 'sent' WHERE id = $1 AND status = 'superseded'`, [q.previous_revision_id]);
    await db.query(`DELETE FROM quotations WHERE id = $1`, [q.id]);
    await audit(db, req, { action: 'quotation.deleted', entityType: 'quotation', entityId: q.id, before: { number: q.number, revision: q.revision } });
  });
  res.json({ data: { ok: true } });
}));

quotationsRouter.post('/:id/send', manage, ah(async (req, res) => {
  const out = await tx(req, async (db) => {
    const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!q) throw notFound('Quotation');
    if (!['draft', 'sent', 'viewed'].includes(q.status)) throw unprocessable(`A ${q.status} quotation cannot be sent`);
    if (q.valid_until < new Date().toISOString().slice(0, 10)) throw unprocessable('The quotation has expired; update the validity date or create a revision');
    const after = await db.one(`UPDATE quotations SET status = CASE WHEN status = 'draft' THEN 'sent' ELSE status END, sent_at = now() WHERE id = $1 RETURNING *`, [q.id]);
    const s = await tenantSettings(db);
    await notify(db, { event: 'quotation.sent', customerId: q.customer_id, entityType: 'quotation', entityId: q.id,
      vars: { quotation: { number: `${q.number}${q.revision > 1 ? ` (rev ${q.revision})` : ''}`, total: fmtMoney(q.total, q.currency, s.locale) }, links: { quotation: `${config.APP_URL}/q/view/${q.public_token}` } } });
    await audit(db, req, { action: 'quotation.sent', entityType: 'quotation', entityId: q.id });
    return after;
  });
  res.json({ data: out });
}));

/** Records a decision on behalf of the customer (phone/in-person). Customers decide themselves via portal or public link. */
export async function decideQuotation(db: Db, req: Request | null, id: string, decision: 'approved' | 'rejected', byName: string, reason?: string | null) {
  const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [id]);
  if (!q) throw notFound('Quotation');
  if (!['sent', 'viewed'].includes(q.status)) throw unprocessable(`A ${q.status} quotation cannot be ${decision}`);
  if (q.valid_until < new Date().toISOString().slice(0, 10)) {
    await db.query(`UPDATE quotations SET status = 'expired' WHERE id = $1`, [q.id]);
    throw unprocessable('This quotation has expired');
  }
  const after = decision === 'approved'
    ? await db.one(`UPDATE quotations SET status = 'approved', approved_at = now(), approved_by_name = $2 WHERE id = $1 RETURNING *`, [q.id, byName])
    : await db.one(`UPDATE quotations SET status = 'rejected', rejected_at = now(), rejection_reason = $2 WHERE id = $1 RETURNING *`, [q.id, reason ?? null]);
  await audit(db, req, { action: `quotation.${decision}`, entityType: 'quotation', entityId: q.id, after: { by: byName, reason } });
  if (decision === 'approved') {
    const { staffWithPermission } = await import('../notifications/service.js');
    await notify(db, { event: 'quotation.approved', customerId: q.customer_id, entityType: 'quotation', entityId: q.id, vars: { quotation: { number: q.number } },
      staffUserIds: await staffWithPermission(db, 'quotations.manage'), inApp: { title: `Quotation ${q.number} approved`, body: `Approved by ${byName}`, link: `/app/quotations/${q.id}` } });
    if (q.work_order_id) await db.query(`UPDATE work_orders SET estimated_cost = $2 WHERE id = $1 AND status NOT IN ('invoiced','paid')`, [q.work_order_id, q.total]);
  }
  return after;
}

quotationsRouter.post('/:id/approve', requirePermission('quotations.approve', 'quotations.manage'), ah(async (req, res) => {
  const b = parse(z.object({ approvedByName: z.string().trim().min(2).max(120) }), req.body);
  res.json({ data: await tx(req, (db) => decideQuotation(db, req, req.params.id, 'approved', b.approvedByName)) });
}));
quotationsRouter.post('/:id/reject', requirePermission('quotations.approve', 'quotations.manage'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2).max(1000) }), req.body);
  res.json({ data: await tx(req, (db) => decideQuotation(db, req, req.params.id, 'rejected', req.auth!.fullName, b.reason)) });
}));

/** Authorised revision: approved/sent quotations are never edited in place; a new revision supersedes them. */
quotationsRouter.post('/:id/revise', manage, ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(500) }), req.body);
  const out = await tx(req, async (db) => {
    const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!q) throw notFound('Quotation');
    if (q.status === 'converted') throw unprocessable('This quotation has been invoiced. Cancel the invoice before revising.');
    if (['draft', 'superseded'].includes(q.status)) throw unprocessable(`A ${q.status} quotation cannot be revised`);
    const latest = await db.one(`SELECT max(revision) r FROM quotations WHERE root_quotation_id = $1`, [q.root_quotation_id]);
    if (latest.r !== q.revision) throw unprocessable('Only the latest revision can be revised');
    const items = await db.many(`SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position`, [q.id]);
    await db.query(`UPDATE quotations SET status = 'superseded' WHERE id = $1`, [q.id]);
    return createQuotation(db, req, { customerId: q.customer_id, workOrderId: q.work_order_id, amcContractId: q.amc_contract_id, title: q.title, notes: q.notes, terms: q.terms,
      items: items.map((i) => ({ itemType: i.item_type, inventoryItemId: i.inventory_item_id, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price),
        discountPercent: Number(i.discount_percent), taxRateId: i.tax_rate_id })) },
      { root: q.root_quotation_id, previous: q.id, revision: q.revision + 1, number: q.number, reason: b.reason });
  });
  res.status(201).json({ data: out });
}));

export async function quotationPdf(db: Db, id: string) {
  const q = await quotationDetail(db, id);
  const s = await tenantSettings(db);
  const m = (v: any) => pdfMoney(v, q.currency, s.locale);
  const number = `${q.number}${q.revision > 1 ? `-R${q.revision}` : ''}`;
  return { number, pdf: await renderFinancialPdf({ title: 'Quotation', number, status: q.status, currency: q.currency, locale: s.locale,
    seller: { name: s.legal_name || s.business_name, lines: [s.address_line1, [s.city, s.state, s.postal_code].filter(Boolean).join(' '), s.business_email, s.business_phone],
      taxLabel: s.tax_registration_label, taxId: s.tax_registration_number },
    buyer: { name: q.company_name || q.customer_name, lines: [q.company_name ? q.customer_name : null, q.customer_email, q.customer_phone] },
    meta: [['Date', q.issue_date], ['Valid until', q.valid_until], ...(q.work_order_number ? [['Job', q.work_order_number] as [string, string]] : [])],
    lines: q.items.map((i: any) => ({ description: i.description, qty: i.quantity, unitPrice: i.unit_price, discount: i.discount_percent, taxRate: i.tax_rate, total: i.line_total })),
    totals: [['Subtotal', m(q.subtotal)], ...(Number(q.discount_total) > 0 ? [['Discount', `- ${m(q.discount_total)}`] as [string, string]] : []), ['Tax', m(q.tax_total)], ['Total', m(q.total), true]],
    taxBreakdown: q.tax_breakdown, notes: q.notes, terms: q.terms }) };
}

quotationsRouter.get('/:id/pdf', read, ah(async (req, res) => {
  const { number, pdf } = await tx(req, (db) => quotationPdf(db, req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`);
  res.send(pdf);
}));

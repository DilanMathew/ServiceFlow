import { Router } from 'express';
import QRCode from 'qrcode';
import { enqueue } from '../../jobs/queue.js';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, toCsv, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, notFound, unprocessable } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, branchScope, tenantSettings, fmtMoney } from '../common.js';
import { buildLines, createInvoiceDraft, insertLines, issueInvoice, itemsFromWorkOrder, lineSchema, recomputeInvoice } from './service.js';
import { renderFinancialPdf, pdfMoney } from '../../lib/pdf.js';
import { notify } from '../notifications/service.js';
import { createPaymentLink } from '../payments/service.js';
import { config } from '../../config.js';
import type { Db } from '../../db/pool.js';
import { pdfT } from '../../lib/pdfI18n.js';

export const invoicesRouter = Router();
const read = requirePermission('invoices.read');
const manage = requirePermission('invoices.manage');

invoicesRouter.get('/', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), customerId: z.string().uuid().optional(), from: dateStr.optional(), to: dateStr.optional(),
    overdue: z.coerce.boolean().optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const w = new Where();
  if (q.status) w.add('i.status = ANY(?)', q.status.split(','));
  w.addIf(q.customerId, 'i.customer_id = ?', q.customerId);
  w.addIf(q.from, 'COALESCE(i.issue_date, i.created_at::date) >= ?', q.from);
  w.addIf(q.to, 'COALESCE(i.issue_date, i.created_at::date) <= ?', q.to);
  if (q.overdue) w.add(`i.status IN ('issued','partially_paid','overdue') AND i.due_date < current_date`);
  const b = branchScope(req); if (b) w.add('i.branch_id = ?', b);
  if (q.q) w.add('(i.number ILIKE ? OR c.full_name ILIKE ? OR c.company_name ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const order = orderBy(q, { number: 'i.number', issued: 'i.issue_date', due: 'i.due_date', total: 'i.total', balance: 'i.balance_due', created: 'i.created_at' }, 'i.created_at');
  const limit = q.format === 'csv' ? 50000 : q.pageSize;
  const rows = await tx(req, (db) => db.many(
    `SELECT i.id, i.number, i.status, i.currency, i.issue_date, i.due_date, i.subtotal, i.tax_total, i.total, i.amount_paid, i.amount_refunded, i.amount_credited, i.balance_due,
            i.created_at, i.customer_id, c.full_name AS customer_name, c.company_name, w.number AS work_order_number, count(*) OVER() AS _total
       FROM invoices i JOIN customers c ON c.id = i.customer_id LEFT JOIN work_orders w ON w.id = i.work_order_id
       ${w.sql} ORDER BY ${order} LIMIT ${limit} OFFSET ${q.format === 'csv' ? 0 : (q.page - 1) * q.pageSize}`, w.params));
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="invoices.csv"');
    return res.send(toCsv(rows, ['number', 'status', 'customer_name', 'issue_date', 'due_date', 'currency', 'subtotal', 'tax_total', 'total', 'amount_paid', 'amount_refunded', 'amount_credited', 'balance_due']));
  }
  res.json(paged(rows, q));
}));

const createSchema = z.object({
  customerId: z.string().uuid().optional(), workOrderId: z.string().uuid().nullish(), quotationId: z.string().uuid().nullish(),
  dueDate: dateStr.nullish(), notes: z.string().max(5000).nullish(), placeOfSupply: z.string().max(60).nullish(),
  items: z.array(lineSchema).max(200).optional(), issue: z.boolean().default(false),
});

/** Create from a completed job, an approved quotation, or manual line items. */
invoicesRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(createSchema, req.body);
  const inv = await tx(req, async (db) => {
    let customerId = b.customerId, items = b.items, workOrderId = b.workOrderId ?? null;
    if (b.quotationId) {
      const q = await db.maybeOne(`SELECT * FROM quotations WHERE id = $1 FOR UPDATE`, [b.quotationId]);
      if (!q) throw badRequest('Quotation not found');
      if (q.status !== 'approved') throw unprocessable('Only approved quotations can be converted to an invoice');
      customerId = q.customer_id; workOrderId = workOrderId ?? q.work_order_id;
      items ??= (await db.many(`SELECT * FROM quotation_items WHERE quotation_id = $1 ORDER BY position`, [q.id])).map((i) => ({
        itemType: i.item_type, inventoryItemId: i.inventory_item_id, description: i.description, quantity: Number(i.quantity), unitPrice: Number(i.unit_price),
        discountPercent: Number(i.discount_percent), taxRateId: i.tax_rate_id }));
    } else if (workOrderId && !items) {
      const wo = await db.maybeOne(`SELECT * FROM work_orders WHERE id = $1`, [workOrderId]);
      if (!wo) throw badRequest('Work order not found');
      if (!['completed', 'invoiced'].includes(wo.status)) throw unprocessable('Invoices are created from completed jobs');
      customerId = wo.customer_id;
      items = await itemsFromWorkOrder(db, workOrderId);
    }
    if (!customerId) throw badRequest('customerId is required');
    if (workOrderId) {
      const existing = await db.maybeOne(`SELECT number FROM invoices WHERE work_order_id = $1 AND status NOT IN ('cancelled') AND quotation_id IS NOT DISTINCT FROM $2`, [workOrderId, b.quotationId ?? null]);
      if (existing && !b.quotationId) throw conflict(`This job already has invoice ${existing.number ?? '(draft)'}`);
    }
    const inv = await createInvoiceDraft(db, req, { customerId, workOrderId, quotationId: b.quotationId, dueDate: b.dueDate, notes: b.notes, placeOfSupply: b.placeOfSupply, items: items ?? [] });
    return b.issue ? issueInvoice(db, req, inv.id) : inv;
  });
  res.status(201).json({ data: inv });
}));

export async function invoiceDetail(db: Db, id: string) {
  const inv = await db.maybeOne(`SELECT i.*, c.full_name AS customer_name, c.company_name, c.email AS customer_email, c.phone AS customer_phone,
      w.number AS work_order_number, q.number AS quotation_number FROM invoices i JOIN customers c ON c.id = i.customer_id
      LEFT JOIN work_orders w ON w.id = i.work_order_id LEFT JOIN quotations q ON q.id = i.quotation_id WHERE i.id = $1`, [id]);
  if (!inv) throw notFound('Invoice');
  const [items, payments, refunds, creditNotes] = await Promise.all([
    db.many(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position`, [id]),
    db.many(`SELECT p.*, u.full_name AS recorded_by_name FROM payments p LEFT JOIN users u ON u.id = p.recorded_by WHERE p.invoice_id = $1 ORDER BY p.received_at`, [id]),
    db.many(`SELECT * FROM refunds WHERE invoice_id = $1 ORDER BY created_at`, [id]),
    db.many(`SELECT * FROM credit_notes WHERE invoice_id = $1 ORDER BY created_at`, [id]),
  ]);
  return { ...inv, items, payments, refunds, creditNotes };
}

invoicesRouter.get('/:id', read, ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => invoiceDetail(db, req.params.id)) });
}));

invoicesRouter.put('/:id', manage, ah(async (req, res) => {
  const b = parse(z.object({ dueDate: dateStr.nullish(), notes: z.string().max(5000).nullish(), placeOfSupply: z.string().max(60).nullish(), items: z.array(lineSchema).min(1).max(200) }), req.body);
  const out = await tx(req, async (db) => {
    const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') throw unprocessable('Issued invoices cannot be edited. Cancel it or issue a credit note instead.');
    const { lines, totals } = await buildLines(db, b.items);
    await db.query(`DELETE FROM invoice_items WHERE invoice_id = $1`, [inv.id]);
    await insertLines(db, 'invoice_items', 'invoice_id', inv.id, lines);
    const after = await db.one(`UPDATE invoices SET due_date = $2, notes = $3, place_of_supply = $4, subtotal = $5, discount_total = $6, tax_total = $7, total = $8, tax_breakdown = $9
      WHERE id = $1 RETURNING *`, [inv.id, b.dueDate ?? null, b.notes ?? null, b.placeOfSupply ?? null, totals.subtotal, totals.discount_total, totals.tax_total, totals.total, JSON.stringify(totals.tax_breakdown)]);
    await audit(db, req, { action: 'invoice.draft_updated', entityType: 'invoice', entityId: inv.id, before: { total: inv.total }, after: { total: after.total } });
    return after;
  });
  res.json({ data: out });
}));

invoicesRouter.delete('/:id', manage, ah(async (req, res) => {
  await tx(req, async (db) => {
    const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!inv) throw notFound('Invoice');
    if (inv.status !== 'draft') throw unprocessable('Only drafts can be deleted. Issued invoices must be cancelled.');
    await db.query(`DELETE FROM invoices WHERE id = $1`, [inv.id]);
    await audit(db, req, { action: 'invoice.draft_deleted', entityType: 'invoice', entityId: inv.id, before: { total: inv.total } });
  });
  res.json({ data: { ok: true } });
}));

invoicesRouter.post('/:id/issue', manage, ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => issueInvoice(db, req, req.params.id)) });
}));

invoicesRouter.post('/:id/send', manage, ah(async (req, res) => {
  await tx(req, async (db) => {
    const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1`, [req.params.id]);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'draft' || inv.status === 'cancelled') throw unprocessable('Issue the invoice before sending it');
    const s = await tenantSettings(db);
    await notify(db, { event: 'invoice.issued', customerId: inv.customer_id, entityType: 'invoice', entityId: inv.id,
      vars: { invoice: { number: inv.number, total: fmtMoney(inv.total, inv.currency, s.locale), due_date: inv.due_date }, links: { invoice: `${config.APP_URL}/i/${inv.public_token}` } } });
    await audit(db, req, { action: 'invoice.sent', entityType: 'invoice', entityId: inv.id });
  });
  res.json({ data: { ok: true } });
}));

/** Cancellation keeps the number and record (no silent edits). Requires all payments to be refunded first. */
invoicesRouter.post('/:id/cancel', requirePermission('invoices.cancel'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(3).max(1000) }), req.body);
  const out = await tx(req, async (db) => {
    const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!inv) throw notFound('Invoice');
    if (inv.status === 'draft') throw unprocessable('Delete the draft instead');
    if (inv.status === 'cancelled') return inv;
    if (Number(inv.amount_paid) - Number(inv.amount_refunded) > 0) throw unprocessable('This invoice has payments. Refund them or issue a credit note before cancelling.');
    const after = await db.one(`UPDATE invoices SET status = 'cancelled', cancelled_at = now(), cancellation_reason = $2 WHERE id = $1 RETURNING *`, [inv.id, b.reason]);
    if (inv.work_order_id) await db.query(`UPDATE work_orders SET status = 'completed', version = version + 1 WHERE id = $1 AND status = 'invoiced'
      AND NOT EXISTS (SELECT 1 FROM invoices WHERE work_order_id = $1 AND id <> $2 AND status NOT IN ('draft','cancelled'))`, [inv.work_order_id, inv.id]);
    if (inv.quotation_id) await db.query(`UPDATE quotations SET status = 'approved' WHERE id = $1 AND status = 'converted'`, [inv.quotation_id]);
    await audit(db, req, { action: 'invoice.cancelled', entityType: 'invoice', entityId: inv.id, before: { status: inv.status }, after: { status: 'cancelled', reason: b.reason } });
    return after;
  });
  res.json({ data: out });
}));

invoicesRouter.post('/:id/credit-notes', requirePermission('invoices.cancel'), ah(async (req, res) => {
  const b = parse(z.object({ amount: z.number().positive().max(1e10), reason: z.string().trim().min(3).max(1000) }), req.body);
  const out = await tx(req, async (db) => {
    const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!inv) throw notFound('Invoice');
    if (['draft', 'cancelled'].includes(inv.status)) throw unprocessable('Credit notes apply to issued invoices');
    if (b.amount > Number(inv.balance_due) + 0.001) throw unprocessable(`Credit note cannot exceed the outstanding balance (${inv.balance_due}). Use a refund for paid amounts.`);
    const cn = await db.one(`INSERT INTO credit_notes (tenant_id, invoice_id, number, amount, reason, created_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [db.tenantId, inv.id, await nextNumber(db, 'credit_note'), b.amount, b.reason, req.auth!.userId]);
    await recomputeInvoice(db, req, inv.id);
    await audit(db, req, { action: 'invoice.credit_note_issued', entityType: 'invoice', entityId: inv.id, after: { number: cn.number, amount: b.amount, reason: b.reason } });
    const st = await db.one(`SELECT einvoice_auto FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
    if (st.einvoice_auto) await enqueue(db, 'einvoice_auto', { invoiceId: inv.id, creditNoteId: cn.id }, { maxAttempts: 5, dedupeKey: `einvoice:${cn.id}` });
    return cn;
  });
  res.status(201).json({ data: out });
}));

invoicesRouter.post('/:id/payment-link', requirePermission('payments.record', 'invoices.manage'), ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => createPaymentLink(db, req.params.id)) });
}));

export async function invoicePdf(db: Db, id: string) {
  const inv = await invoiceDetail(db, id);
  const s = await tenantSettings(db);
  const e = await db.maybeOne(`SELECT irn, ack_no, ack_date, signed_qr, mode FROM einvoice_documents
    WHERE invoice_id = $1 AND credit_note_id IS NULL AND scheme = 'IN_IRN' AND status = 'registered' ORDER BY created_at DESC LIMIT 1`, [id]);
  const einvoice = e ? { irn: e.irn, ackNo: e.ack_no, test: e.mode === 'test',
    ackDate: new Intl.DateTimeFormat('en-IN', { dateStyle: 'medium', timeStyle: 'short', timeZone: s.timezone }).format(new Date(e.ack_date)),
    qrPng: await QRCode.toBuffer(e.signed_qr, { errorCorrectionLevel: 'M', margin: 1, width: 300 }) } : null;
  const seller = inv.status === 'draft'
    ? { name: s.legal_name || s.business_name, lines: [s.address_line1, [s.city, s.state, s.postal_code].filter(Boolean).join(' '), s.business_email, s.business_phone], taxLabel: s.tax_registration_label, taxId: s.tax_registration_number }
    : { name: inv.seller.name, lines: [inv.seller.address, inv.seller.email, inv.seller.phone], taxLabel: inv.seller.tax_label, taxId: inv.seller.tax_id };
  const billTo = inv.status === 'draft' ? { name: inv.company_name || inv.customer_name, lines: [inv.customer_email, inv.customer_phone] }
    : { name: inv.bill_to.name, lines: [inv.bill_to.contact, inv.bill_to.address, inv.bill_to.email, inv.bill_to.phone, inv.bill_to.tax_id ? `Tax ID: ${inv.bill_to.tax_id}` : null] };
  const m = (v: any) => pdfMoney(v, inv.currency, s.locale);
  const L = pdfT(s.locale);
  return { number: inv.number ?? 'DRAFT', pdf: await renderFinancialPdf({
    title: L('Tax Invoice'), number: inv.number ?? L('DRAFT'), status: inv.status, currency: inv.currency, locale: s.locale, seller, buyer: billTo,
    meta: [[L('Issue date'), inv.issue_date ?? '—'], [L('Due date'), inv.due_date ?? '—'], ...(inv.work_order_number ? [[L('Job'), inv.work_order_number] as [string, string]] : []),
      ...(inv.place_of_supply ? [[L('Place of supply'), inv.place_of_supply] as [string, string]] : [])],
    lines: inv.items.map((i: any) => ({ description: i.description + (i.hsn_sac_code ? ` (HSN/SAC ${i.hsn_sac_code})` : ''), qty: i.quantity, unitPrice: i.unit_price, discount: i.discount_percent, taxRate: i.tax_rate, total: i.line_total })),
    totals: [[L('Subtotal'), m(inv.subtotal)], ...(Number(inv.discount_total) > 0 ? [[L('Discount'), `- ${m(inv.discount_total)}`] as [string, string]] : []), [L('Tax'), m(inv.tax_total)], [L('Total'), m(inv.total), true],
      ...(Number(inv.amount_paid) > 0 ? [[L('Paid'), m(Number(inv.amount_paid) - Number(inv.amount_refunded))] as [string, string]] : []),
      ...(Number(inv.amount_credited) > 0 ? [[L('Credited'), m(inv.amount_credited)] as [string, string]] : []), [L('Balance due'), m(inv.balance_due), true]],
    taxBreakdown: inv.tax_breakdown, notes: inv.notes, footer: inv.footer ?? undefined, einvoice,
  }) };
}

invoicesRouter.get('/:id/pdf', read, ah(async (req, res) => {
  const { number, pdf } = await tx(req, (db) => invoicePdf(db, req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `${req.query.download ? 'attachment' : 'inline'}; filename="${number}.pdf"`);
  res.send(pdf);
}));

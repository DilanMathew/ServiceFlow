import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, listQuery, orderBy, paged, parse, toCsv, Where } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, notFound } from '../../lib/errors.js';
import { tx, tenantSettings } from '../common.js';
import { recordPayment, refundPayment, settlePending } from './service.js';
import { renderSheetPdf, pdfMoney } from '../../lib/pdf.js';
import type { Db } from '../../db/pool.js';
import { pdfT } from '../../lib/pdfI18n.js';

export const paymentsRouter = Router();

paymentsRouter.get('/', requirePermission('payments.read'), ah(async (req, res) => {
  const q = parse(listQuery.extend({ status: z.string().optional(), method: z.string().optional(), from: z.string().optional(), to: z.string().optional(),
    reconciled: z.enum(['yes', 'no']).optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const w = new Where();
  w.addIf(q.status, 'p.status = ?', q.status);
  w.addIf(q.method, 'p.method = ?', q.method);
  w.addIf(q.from, 'p.received_at >= ?', q.from);
  w.addIf(q.to, 'p.received_at < ?', q.to);
  if (q.reconciled === 'yes') w.add('p.reconciled_at IS NOT NULL');
  if (q.reconciled === 'no') w.add(`p.reconciled_at IS NULL AND p.status = 'succeeded'`);
  if (q.q) w.add('(p.receipt_number ILIKE ? OR p.reference ILIKE ? OR i.number ILIKE ? OR c.full_name ILIKE ? OR p.provider_payment_id ILIKE ?)', ...Array(5).fill(`%${q.q}%`));
  const order = orderBy(q, { received: 'p.received_at', amount: 'p.amount' }, 'p.received_at');
  const rows = await tx(req, (db) => db.many(`SELECT p.id, p.receipt_number, p.amount, p.currency, p.method, p.status, p.provider, p.provider_payment_id, p.reference, p.received_at,
      p.reconciled_at, p.failure_reason, i.id AS invoice_id, i.number AS invoice_number, c.id AS customer_id, c.full_name AS customer_name,
      (SELECT COALESCE(sum(amount),0) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded') AS refunded, count(*) OVER() AS _total
    FROM payments p JOIN invoices i ON i.id = p.invoice_id JOIN customers c ON c.id = p.customer_id ${w.sql} ORDER BY ${order}
    LIMIT ${q.format === 'csv' ? 50000 : q.pageSize} OFFSET ${q.format === 'csv' ? 0 : (q.page - 1) * q.pageSize}`, w.params));
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', 'attachment; filename="payments.csv"');
    return res.send(toCsv(rows, ['receipt_number', 'received_at', 'customer_name', 'invoice_number', 'method', 'status', 'currency', 'amount', 'refunded', 'reference', 'provider_payment_id', 'reconciled_at']));
  }
  res.json(paged(rows, q));
}));

paymentsRouter.post('/', requirePermission('payments.record'), ah(async (req, res) => {
  const b = parse(z.object({ invoiceId: z.string().uuid(), amount: z.number().positive().max(1e10), method: z.enum(['cash', 'bank_transfer', 'card', 'upi', 'cheque', 'other']),
    reference: z.string().max(120).nullish(), receivedAt: z.string().datetime({ offset: true }).nullish(), notes: z.string().max(1000).nullish(),
    status: z.enum(['succeeded', 'pending']).default('succeeded') }), req.body);
  const idem = req.get('idempotency-key') ?? null;
  if (idem && !/^[\w-]{8,100}$/.test(idem)) throw badRequest('Invalid Idempotency-Key header');
  const out = await tx(req, (db) => recordPayment(db, req, { ...b, idempotencyKey: idem }));
  res.status(out.duplicate ? 200 : 201).json({ data: out.payment, meta: { duplicate: out.duplicate } });
}));

paymentsRouter.post('/:id/confirm', requirePermission('payments.record'), ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => settlePending(db, req, req.params.id, 'succeeded')) });
}));
paymentsRouter.post('/:id/fail', requirePermission('payments.record'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2).max(500) }), req.body);
  res.json({ data: await tx(req, (db) => settlePending(db, req, req.params.id, 'failed', b.reason)) });
}));

paymentsRouter.post('/:id/refund', requirePermission('payments.refund'), ah(async (req, res) => {
  const b = parse(z.object({ amount: z.number().positive().max(1e10), reason: z.string().trim().min(3).max(1000) }), req.body);
  const idem = req.get('idempotency-key');
  if (!idem || !/^[\w-]{8,100}$/.test(idem)) throw badRequest('An Idempotency-Key header is required for refunds');
  const out = await tx(req, (db) => refundPayment(db, req, req.params.id, b.amount, b.reason, idem));
  res.status(out.duplicate ? 200 : 201).json({ data: out.refund, meta: { duplicate: out.duplicate } });
}));

paymentsRouter.post('/reconcile', requirePermission('payments.reconcile'), ah(async (req, res) => {
  const b = parse(z.object({ ids: z.array(z.string().uuid()).min(1).max(500), reconciled: z.boolean().default(true) }), req.body);
  const n = await tx(req, async (db) => {
    const r = await db.query(`UPDATE payments SET reconciled_at = CASE WHEN $2 THEN now() ELSE NULL END, reconciled_by = CASE WHEN $2 THEN $3::uuid ELSE NULL END
      WHERE id = ANY($1) AND status = 'succeeded'`, [b.ids, b.reconciled, req.auth!.userId]);
    await audit(db, req, { action: b.reconciled ? 'payments.reconciled' : 'payments.unreconciled', entityType: 'payment', after: { ids: b.ids } });
    return r.rowCount;
  });
  res.json({ data: { updated: n } });
}));

export async function receiptPdf(db: Db, id: string) {
  const p = await db.maybeOne(`SELECT p.*, i.number AS invoice_number, i.total, i.balance_due, c.full_name, c.company_name FROM payments p JOIN invoices i ON i.id = p.invoice_id
    JOIN customers c ON c.id = p.customer_id WHERE p.id = $1`, [id]);
  if (!p) throw notFound('Payment');
  if (p.status !== 'succeeded') throw badRequest('Receipts are available for successful payments only');
  const s = await tenantSettings(db);
  const m = (v: any) => pdfMoney(v, p.currency, s.locale);
  const L = pdfT(s.locale);
  return { number: p.receipt_number, pdf: await renderSheetPdf({ signatures: false, locale: s.locale, title: L('Payment Receipt'), number: p.receipt_number, status: 'paid',
    seller: { name: s.legal_name || s.business_name, lines: [s.address_line1, [s.city, s.postal_code].filter(Boolean).join(' '), s.business_email], taxLabel: s.tax_registration_label, taxId: s.tax_registration_number },
    sections: [{ heading: L('Received from'), rows: [[L('Customer'), p.company_name || p.full_name]] },
      { heading: L('Payment'), rows: [[L('Amount'), m(p.amount)], [L('Method'), p.method.replace('_', ' ')], [L('Reference'), p.reference ?? p.provider_payment_id ?? '—'],
        [L('Date'), new Intl.DateTimeFormat(s.locale, { dateStyle: 'medium', timeZone: s.timezone }).format(new Date(p.received_at))], [L('Invoice'), p.invoice_number],
        [L('Invoice total'), m(p.total)], [L('Balance after payment'), m(p.balance_due)]] }] }) };
}

paymentsRouter.get('/:id/receipt.pdf', requirePermission('payments.read'), ah(async (req, res) => {
  const { number, pdf } = await tx(req, (db) => receiptPdf(db, req.params.id));
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`);
  res.send(pdf);
}));

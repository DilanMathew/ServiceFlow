import type { Request } from 'express';
import { z } from 'zod';
import type { Db } from '../../db/pool.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { calcLine, calcTotals } from '../../lib/money.js';
import { nextNumber } from '../../lib/numbering.js';
import { audit } from '../../lib/audit.js';
import { enqueue } from '../../jobs/queue.js';
import { notify } from '../notifications/service.js';
import { tenantSettings, fmtMoney } from '../common.js';
import { transition } from '../workorders/service.js';
import { config } from '../../config.js';

export const lineSchema = z.object({
  itemType: z.enum(['labour', 'part', 'charge', 'amc']), inventoryItemId: z.string().uuid().nullish(), description: z.string().trim().min(1).max(500),
  hsnSacCode: z.string().max(20).nullish(), quantity: z.number().positive().max(1e6), unitPrice: z.number().min(0).max(1e10),
  discountPercent: z.number().min(0).max(100).default(0), taxRateId: z.string().uuid().nullish(),
});
export type LineInput = z.infer<typeof lineSchema>;

/** Computes lines with a snapshot of the tax rate at the time of creation. */
export async function buildLines(db: Db, items: LineInput[]) {
  const s = await db.one(`SELECT prices_include_tax FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
  const rateIds = [...new Set(items.map((i) => i.taxRateId).filter(Boolean))] as string[];
  const rates = rateIds.length ? await db.many(`SELECT id, rate, components FROM tax_rates WHERE id = ANY($1)`, [rateIds]) : [];
  if (rates.length !== rateIds.length) throw badRequest('Unknown tax rate');
  const lines = items.map((it, i) => {
    const r = rates.find((x) => x.id === it.taxRateId);
    const rate = r ? Number(r.rate) : 0;
    const comps = (r?.components ?? []) as { name: string; rate: number }[];
    const calc = calcLine({ quantity: it.quantity, unitPrice: it.unitPrice, discountPercent: it.discountPercent, taxRate: rate, taxComponents: comps }, s.prices_include_tax);
    return { ...it, position: i, taxRate: rate, ...calc };
  });
  return { lines, totals: calcTotals(lines) };
}

export async function insertLines(db: Db, table: 'invoice_items' | 'quotation_items', fk: 'invoice_id' | 'quotation_id', parentId: string, lines: Awaited<ReturnType<typeof buildLines>>['lines']) {
  for (const l of lines) {
    const common = [db.tenantId, parentId, l.position, l.inventoryItemId ?? null, l.description, l.quantity, l.unitPrice, l.discountPercent, l.taxRateId ?? null,
      l.taxRate, JSON.stringify(l.tax_components), l.line_subtotal, l.line_discount, l.line_tax, l.line_total];
    if (table === 'invoice_items') {
      await db.query(`INSERT INTO invoice_items (tenant_id, invoice_id, position, inventory_item_id, description, quantity, unit_price, discount_percent, tax_rate_id,
          tax_rate, tax_components, line_subtotal, line_discount, line_tax, line_total, item_type, hsn_sac_code)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`, [...common, l.itemType, l.hsnSacCode ?? null]);
    } else {
      await db.query(`INSERT INTO quotation_items (tenant_id, quotation_id, position, inventory_item_id, description, quantity, unit_price, discount_percent, tax_rate_id,
          tax_rate, tax_components, line_subtotal, line_discount, line_tax, line_total, item_type)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`, [...common, l.itemType === 'amc' ? 'charge' : l.itemType]);
    }
  }
  void fk;
}

export interface InvoiceDraftInput {
  customerId: string; workOrderId?: string | null; quotationId?: string | null; amcContractId?: string | null; dueDate?: string | null;
  notes?: string | null; placeOfSupply?: string | null; items: LineInput[]; branchId?: string | null;
}

export async function createInvoiceDraft(db: Db, req: Request | null, b: InvoiceDraftInput) {
  if (!b.items.length) throw badRequest('Add at least one line item');
  const cust = await db.maybeOne(`SELECT id, branch_id FROM customers WHERE id = $1`, [b.customerId]);
  if (!cust) throw badRequest('Customer not found');
  if (b.workOrderId && !(await db.maybeOne(`SELECT 1 FROM work_orders WHERE id = $1 AND customer_id = $2`, [b.workOrderId, b.customerId]))) throw badRequest('Work order does not belong to this customer');
  const s = await tenantSettings(db);
  const { lines, totals } = await buildLines(db, b.items);
  const inv = await db.one(
    `INSERT INTO invoices (tenant_id, branch_id, customer_id, work_order_id, quotation_id, amc_contract_id, currency, due_date, place_of_supply, notes, footer,
       subtotal, discount_total, tax_total, total, tax_breakdown, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17) RETURNING *`,
    [db.tenantId, b.branchId ?? cust.branch_id ?? null, b.customerId, b.workOrderId ?? null, b.quotationId ?? null, b.amcContractId ?? null, s.currency, b.dueDate ?? null,
      b.placeOfSupply ?? null, b.notes ?? null, s.invoice_footer, totals.subtotal, totals.discount_total, totals.tax_total, totals.total,
      JSON.stringify(totals.tax_breakdown), req?.auth?.userId ?? null]);
  await insertLines(db, 'invoice_items', 'invoice_id', inv.id, lines);
  await audit(db, req, { action: 'invoice.draft_created', entityType: 'invoice', entityId: inv.id, after: { total: totals.total, customer_id: b.customerId } });
  return inv;
}

/** Builds draft lines from what was actually recorded on a completed job (labour + parts). */
export async function itemsFromWorkOrder(db: Db, workOrderId: string): Promise<LineInput[]> {
  const wo = await db.maybeOne(`SELECT w.*, sc.name AS category, sc.default_price FROM work_orders w LEFT JOIN service_categories sc ON sc.id = w.service_category_id WHERE w.id = $1`, [workOrderId]);
  if (!wo) throw notFound('Work order');
  const def = await db.maybeOne(`SELECT id FROM tax_rates WHERE is_default AND is_active LIMIT 1`);
  const labour = await db.many(`SELECT description, hours, rate FROM work_order_labour WHERE work_order_id = $1`, [workOrderId]);
  const parts = await db.many(`SELECT p.description, p.quantity, p.unit_price, p.item_id, i.tax_rate_id FROM work_order_parts p LEFT JOIN inventory_items i ON i.id = p.item_id WHERE p.work_order_id = $1`, [workOrderId]);
  const items: LineInput[] = [
    ...labour.map((l) => ({ itemType: 'labour' as const, description: l.description, quantity: Number(l.hours), unitPrice: Number(l.rate), discountPercent: 0, taxRateId: def?.id ?? null })),
    ...parts.map((p) => ({ itemType: 'part' as const, inventoryItemId: p.item_id, description: p.description, quantity: Number(p.quantity), unitPrice: Number(p.unit_price), discountPercent: 0, taxRateId: p.tax_rate_id ?? def?.id ?? null })),
  ];
  if (!items.length) items.push({ itemType: 'labour', description: `${wo.category ?? 'Service'} — ${wo.number}`, quantity: 1,
    unitPrice: Number(wo.estimated_cost ?? wo.default_price ?? 0), discountPercent: 0, taxRateId: def?.id ?? null });
  return items;
}

/** Issuing assigns the gapless number, snapshots parties and makes the invoice immutable (DB trigger). */
export async function issueInvoice(db: Db, req: Request | null, id: string, opts: { notify?: boolean } = {}) {
  const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [id]);
  if (!inv) throw notFound('Invoice');
  if (inv.status !== 'draft') throw unprocessable('Only draft invoices can be issued');
  if (Number(inv.total) <= 0) throw unprocessable('Invoice total must be greater than zero');
  const s = await tenantSettings(db);
  const c = await db.one(`SELECT c.*, a.line1, a.line2, a.city, a.state, a.postal_code, a.country FROM customers c
    LEFT JOIN customer_addresses a ON a.customer_id = c.id AND a.is_default AND a.deleted_at IS NULL WHERE c.id = $1`, [inv.customer_id]);
  // Structured address parts are kept alongside the display string: e-invoices (IRN / UBL) need them.
  const buyerParts = { line1: c.billing_line1 ?? c.line1 ?? null, line2: c.billing_line2 ?? c.line2 ?? null, city: c.billing_city ?? c.city ?? null,
    state: c.billing_state ?? c.state ?? null, postal_code: c.billing_postal_code ?? c.postal_code ?? null, country: c.billing_country ?? c.country ?? s.country ?? null };
  const billTo = { name: c.company_name || c.full_name, contact: c.company_name ? c.full_name : null, email: c.email, phone: c.phone, tax_id: c.tax_id,
    customer_type: c.customer_type, peppol_id: c.peppol_id ?? null, buyer_reference: c.buyer_reference ?? null, parts: buyerParts,
    address: [buyerParts.line1, buyerParts.line2, buyerParts.city, buyerParts.state, buyerParts.postal_code].filter(Boolean).join(', ') };
  const seller = { name: s.legal_name || s.business_name, trade_name: s.business_name, address: [s.address_line1, s.address_line2, s.city, s.state, s.postal_code].filter(Boolean).join(', '),
    parts: { line1: s.address_line1 ?? null, line2: s.address_line2 ?? null, city: s.city ?? null, state: s.state ?? null, postal_code: s.postal_code ?? null, country: s.country ?? null },
    email: s.business_email, phone: s.business_phone, tax_label: s.tax_registration_label, tax_id: s.tax_registration_number, country: s.country,
    peppol_id: s.peppol_id ?? null, bank: s.bank_iban ? { name: s.bank_account_name ?? null, iban: s.bank_iban, bic: s.bank_bic ?? null } : null };
  const number = await nextNumber(db, 'invoice');
  const tz = s.timezone;
  const issued = await db.one(`UPDATE invoices SET status = 'issued', number = $2, issue_date = (now() AT TIME ZONE $3)::date,
      due_date = COALESCE(due_date, (now() AT TIME ZONE $3)::date + $4::int), bill_to = $5, seller = $6, issued_at = now(), issued_by = $7,
      place_of_supply = COALESCE(place_of_supply, $8) WHERE id = $1 RETURNING *`,
    [id, number, tz, s.payment_terms_days, JSON.stringify(billTo), JSON.stringify(seller), req?.auth?.userId ?? null, c.billing_state ?? c.state ?? null]);
  if (inv.work_order_id) {
    const wo = await db.one(`SELECT status FROM work_orders WHERE id = $1`, [inv.work_order_id]);
    if (wo.status === 'completed') await transition(db, req, inv.work_order_id, 'invoiced', { system: true, note: `Invoice ${number} issued` });
  }
  if (inv.quotation_id) await db.query(`UPDATE quotations SET status = 'converted' WHERE id = $1 AND status = 'approved'`, [inv.quotation_id]);
  await audit(db, req, { action: 'invoice.issued', entityType: 'invoice', entityId: id, after: { number, total: issued.total } });
  // E-invoicing runs as a job after commit: a slow or failing IRP/Peppol provider never blocks issuing.
  if (s.einvoice_auto) await enqueue(db, 'einvoice_auto', { invoiceId: id }, { maxAttempts: 5, dedupeKey: `einvoice:${id}` });
  if (opts.notify !== false) {
    await notify(db, { event: 'invoice.issued', customerId: inv.customer_id, entityType: 'invoice', entityId: id, dedupeKey: `invoice-issued:${id}`,
      vars: { invoice: { number, total: fmtMoney(issued.total, issued.currency, s.locale), due_date: issued.due_date }, links: { invoice: `${config.APP_URL}/i/${issued.public_token}` } } });
  }
  return issued;
}

/**
 * Derives amounts and status from the payment/refund ledger. The ONLY place invoice paid state is
 * set: a job/invoice can never be "paid" without succeeded payment records.
 */
export async function recomputeInvoice(db: Db, req: Request | null, invoiceId: string) {
  const inv = await db.one(`SELECT * FROM invoices WHERE id = $1 FOR UPDATE`, [invoiceId]);
  const p = await db.one(`SELECT COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'),0) AS paid FROM payments WHERE invoice_id = $1`, [invoiceId]);
  const r = await db.one(`SELECT COALESCE(sum(amount) FILTER (WHERE status = 'succeeded'),0) AS refunded FROM refunds WHERE invoice_id = $1`, [invoiceId]);
  const cn = await db.one(`SELECT COALESCE(sum(amount),0) AS credited FROM credit_notes WHERE invoice_id = $1`, [invoiceId]);
  const paid = Number(p.paid), refunded = Number(r.refunded), credited = Number(cn.credited), total = Number(inv.total);
  const balance = Math.round((total - paid - credited) * 100) / 100;
  let status = inv.status as string;
  if (inv.status !== 'draft' && inv.status !== 'cancelled') {
    if (refunded > 0 && paid - refunded <= 0) status = 'refunded';
    else if (refunded > 0) status = 'partially_refunded';
    else if (balance <= 0) status = 'paid';
    else if (paid > 0) status = 'partially_paid';
    else status = inv.due_date && new Date(inv.due_date) < new Date(new Date().toISOString().slice(0, 10)) ? 'overdue' : 'issued';
  }
  const updated = await db.one(`UPDATE invoices SET amount_paid = $2, amount_refunded = $3, amount_credited = $4, status = $5 WHERE id = $1 RETURNING *`,
    [invoiceId, paid, refunded, credited, status]);
  if (status !== inv.status) {
    await audit(db, req, { action: 'invoice.status_changed', entityType: 'invoice', entityId: invoiceId, before: { status: inv.status, amount_paid: inv.amount_paid }, after: { status, amount_paid: paid } });
    if (status === 'paid' && inv.work_order_id) {
      const wo = await db.one(`SELECT status FROM work_orders WHERE id = $1`, [inv.work_order_id]);
      // the job is paid only when every live invoice for it is settled
      const unpaid = await db.maybeOne(`SELECT 1 FROM invoices WHERE work_order_id = $1 AND status IN ('issued','partially_paid','overdue')`, [inv.work_order_id]);
      if (wo.status === 'invoiced' && !unpaid) await transition(db, req, inv.work_order_id, 'paid', { system: true, note: `Invoice ${inv.number} paid` });
    }
    if (inv.amc_contract_id) {
      const agg = await db.one(`SELECT bool_and(status IN ('paid','partially_refunded')) AS all_paid, bool_or(amount_paid > 0) AS some FROM invoices WHERE amc_contract_id = $1 AND status NOT IN ('draft','cancelled')`, [inv.amc_contract_id]);
      await db.query(`UPDATE amc_contracts SET payment_status = $2 WHERE id = $1`, [inv.amc_contract_id, agg.all_paid ? 'paid' : agg.some ? 'partially_paid' : 'unpaid']);
    }
  }
  return updated;
}

import type { Request } from 'express';
import type { Db } from '../../db/pool.js';
import { withTenant } from '../../db/pool.js';
import { AppError, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { getIntegration } from '../../integrations/registry.js';
import { cancelIrn, registerIrn, transmitPeppol } from '../../integrations/einvoice.js';
import { buildIrnPayload, type ValidationIssue } from './india.js';
import { buildUbl, type UblVariant } from './ubl.js';

export type Scheme = 'IN_IRN' | 'PEPPOL_BIS3' | 'XRECHNUNG';
const r2 = (n: number) => Math.round(n * 100) / 100;

export interface DocSource {
  inv: any; items: any[];
  cn: any | null;
  /** Lines of the document being reported (invoice lines, or credit-note lines derived from them). */
  lines: any[];
  number: string; date: string;
}

/**
 * Credit notes in ServiceFlow are amount-based. For e-invoicing they are expressed as lines that
 * reverse the invoice proportionally per (HSN/SAC, tax rate, tax components), so tax is correct.
 */
export function creditNoteLines(items: any[], amount: number, label: string) {
  const groups = new Map<string, { hsn: string | null; rate: number; comps: any[]; total: number; type: string }>();
  for (const it of items) {
    const key = `${it.hsn_sac_code ?? ''}|${Number(it.tax_rate)}|${(it.tax_components ?? []).map((c: any) => c.name).join('+')}`;
    const g = groups.get(key) ?? { hsn: it.hsn_sac_code, rate: Number(it.tax_rate), comps: it.tax_components ?? [], total: 0, type: it.item_type };
    g.total += Number(it.line_total); groups.set(key, g);
  }
  const grand = [...groups.values()].reduce((a, g) => a + g.total, 0) || 1;
  const list = [...groups.values()];
  let allocated = 0;
  return list.map((g, i) => {
    const gross = i === list.length - 1 ? r2(amount - allocated) : r2((amount * g.total) / grand);
    allocated = r2(allocated + gross);
    const net = r2(gross / (1 + g.rate / 100)); const tax = r2(gross - net);
    let compAlloc = 0;
    const comps = g.comps.map((c: any, j: number) => {
      const a = j === g.comps.length - 1 ? r2(tax - compAlloc) : r2((tax * Number(c.rate)) / (g.rate || 1));
      compAlloc = r2(compAlloc + a);
      return { name: c.name, rate: Number(c.rate), amount: a };
    });
    return { description: label, hsn_sac_code: g.hsn, quantity: 1, line_subtotal: net, line_discount: 0, line_tax: tax, line_total: gross, tax_rate: g.rate, tax_components: comps, item_type: g.type };
  });
}

export async function loadSource(db: Db, invoiceId: string, creditNoteId?: string | null): Promise<DocSource> {
  const inv = await db.maybeOne(`SELECT * FROM invoices WHERE id = $1`, [invoiceId]);
  if (!inv) throw notFound('Invoice');
  if (inv.status === 'draft') throw unprocessable('Issue the invoice before creating an e-invoice');
  const items = await db.many(`SELECT * FROM invoice_items WHERE invoice_id = $1 ORDER BY position`, [invoiceId]);
  if (!creditNoteId) return { inv, items, cn: null, lines: items, number: inv.number, date: String(isoDate(inv.issue_date)) };
  const cn = await db.maybeOne(`SELECT * FROM credit_notes WHERE id = $1 AND invoice_id = $2`, [creditNoteId, invoiceId]);
  if (!cn) throw notFound('Credit note');
  return { inv, items, cn, lines: creditNoteLines(items, Number(cn.amount), `Credit against invoice ${inv.number}: ${cn.reason}`.slice(0, 300)),
    number: cn.number, date: isoDate(cn.created_at) };
}

const isoDate = (d: unknown) => (d instanceof Date ? new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10) : String(d).slice(0, 10));

export function irnPayload(src: DocSource) {
  return buildIrnPayload({
    docType: src.cn ? 'CRN' : 'INV', number: src.number, date: src.date, seller: src.inv.seller, buyer: src.inv.bill_to,
    placeOfSupply: src.inv.place_of_supply, items: src.lines, preceding: src.cn ? { number: src.inv.number, date: isoDate(src.inv.issue_date) } : undefined,
  });
}

export function ublDocument(src: DocSource, variant: UblVariant) {
  return buildUbl({
    variant, kind: src.cn ? 'credit_note' : 'invoice', number: src.number, issueDate: src.date, dueDate: src.cn ? null : src.inv.due_date ? isoDate(src.inv.due_date) : null,
    currency: src.inv.currency, seller: src.inv.seller, buyer: src.inv.bill_to, lines: src.lines, note: src.cn ? src.cn.reason : src.inv.notes,
    billingReference: src.cn ? { number: src.inv.number, date: isoDate(src.inv.issue_date) } : null,
  });
}

/** Which schemes apply to this tenant's documents. */
export function applicableSchemes(src: DocSource): Scheme[] {
  const sellerCountry = String(src.inv.seller?.parts?.country ?? src.inv.seller?.country ?? '').toUpperCase();
  const buyerCountry = String(src.inv.bill_to?.parts?.country ?? '').toUpperCase();
  if (sellerCountry === 'IN') return ['IN_IRN'];
  if (!sellerCountry) return [];
  return sellerCountry === 'DE' || buyerCountry === 'DE' ? ['PEPPOL_BIS3', 'XRECHNUNG'] : ['PEPPOL_BIS3'];
}

export function readiness(src: DocSource): Partial<Record<Scheme, ValidationIssue[]>> {
  const out: Partial<Record<Scheme, ValidationIssue[]>> = {};
  for (const s of applicableSchemes(src)) {
    out[s] = s === 'IN_IRN' ? irnPayload(src).issues : ublDocument(src, s === 'XRECHNUNG' ? 'xrechnung' : 'peppol').issues;
  }
  return out;
}

const invalid = (issues: ValidationIssue[]) => new AppError(422, 'EINVOICE_INVALID', `The e-invoice cannot be created yet: ${issues[0].message}`, { issues });

/** Registers an invoice or credit note with the IRP (via the tenant's e-invoice provider). */
export async function registerIrnFor(tenantId: string, req: Request | null, invoiceId: string, creditNoteId?: string | null) {
  const { src, payload, issues } = await withTenant(tenantId, async (db) => {
    const src = await loadSource(db, invoiceId, creditNoteId);
    if (src.inv.status === 'cancelled' && !src.cn) throw unprocessable('Cancelled invoices cannot be e-invoiced');
    const existing = await db.maybeOne(`SELECT irn FROM einvoice_documents WHERE invoice_id = $1 AND credit_note_id IS NOT DISTINCT FROM $2 AND scheme = 'IN_IRN' AND status = 'registered'`, [invoiceId, creditNoteId ?? null]);
    if (existing) throw new AppError(409, 'ALREADY_REGISTERED', `This document already has IRN ${existing.irn.slice(0, 12)}…`);
    return { src, ...irnPayload(src) };
  });
  if (issues.length) throw invalid(issues);
  const integ = await getIntegration(tenantId, 'einvoice');
  if (!integ) throw unprocessable('Set up an e-invoice provider first (Integrations → E-invoicing)');
  const body = JSON.stringify(payload);
  try {
    const r = await registerIrn(integ, payload, src.date);
    return await withTenant(tenantId, async (db) => {
      const doc = await db.one(`INSERT INTO einvoice_documents (tenant_id, invoice_id, credit_note_id, scheme, status, mode, provider, irn, ack_no, ack_date, signed_invoice, signed_qr, payload, created_by)
        VALUES ($1,$2,$3,'IN_IRN','registered',$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [tenantId, invoiceId, creditNoteId ?? null, integ.provider === 'in_sandbox' ? 'test' : integ.mode, integ.provider, r.irn, r.ackNo, r.ackDate, r.signedInvoice, r.signedQr, body, req?.auth?.userId ?? null]);
      await audit(db, req, { action: 'einvoice.irn_registered', entityType: 'invoice', entityId: invoiceId, after: { irn: r.irn, ackNo: r.ackNo, document: src.number, provider: integ.provider } });
      return doc;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    await withTenant(tenantId, async (db) => {
      await db.query(`INSERT INTO einvoice_documents (tenant_id, invoice_id, credit_note_id, scheme, status, mode, provider, payload, error, created_by)
        VALUES ($1,$2,$3,'IN_IRN','failed',$4,$5,$6,$7,$8)`, [tenantId, invoiceId, creditNoteId ?? null, integ.mode, integ.provider, body, (e as Error).message.slice(0, 500), req?.auth?.userId ?? null]);
    });
    throw new AppError(502, 'EINVOICE_PROVIDER_ERROR', `E-invoice registration failed: ${(e as Error).message}`);
  }
}

export async function cancelIrnFor(tenantId: string, req: Request, docId: string, reasonCode: '1' | '2' | '3' | '4', remark: string) {
  const doc = await withTenant(tenantId, (db) => db.maybeOne(`SELECT * FROM einvoice_documents WHERE id = $1 AND scheme = 'IN_IRN'`, [docId]));
  if (!doc) throw notFound('E-invoice');
  if (doc.status !== 'registered') throw unprocessable('Only registered IRNs can be cancelled');
  if (Date.now() - new Date(doc.ack_date).getTime() > 24 * 3600_000) throw unprocessable('The IRP only allows cancellation within 24 hours. Issue a credit note instead.');
  const integ = await getIntegration(tenantId, 'einvoice');
  if (!integ) throw unprocessable('The e-invoice provider is not configured');
  await cancelIrn(integ, doc.irn, reasonCode, remark);
  return withTenant(tenantId, async (db) => {
    const out = await db.one(`UPDATE einvoice_documents SET status = 'cancelled', cancelled_at = now(), cancel_reason = $2 WHERE id = $1 RETURNING *`, [docId, `${reasonCode}: ${remark}`]);
    await audit(db, req, { action: 'einvoice.irn_cancelled', entityType: 'invoice', entityId: doc.invoice_id, after: { irn: doc.irn, reasonCode, remark } });
    return out;
  });
}

export async function sendPeppolFor(tenantId: string, req: Request | null, invoiceId: string, variant: UblVariant, creditNoteId?: string | null) {
  const scheme: Scheme = variant === 'xrechnung' ? 'XRECHNUNG' : 'PEPPOL_BIS3';
  const { src, xml, issues } = await withTenant(tenantId, async (db) => {
    const src = await loadSource(db, invoiceId, creditNoteId);
    const existing = await db.maybeOne(`SELECT 1 FROM einvoice_documents WHERE invoice_id = $1 AND credit_note_id IS NOT DISTINCT FROM $2 AND scheme = $3 AND status = 'sent'`, [invoiceId, creditNoteId ?? null, scheme]);
    if (existing) throw new AppError(409, 'ALREADY_SENT', 'This document has already been sent via Peppol');
    return { src, ...ublDocument(src, variant) };
  });
  if (issues.length) throw invalid(issues);
  const integ = await getIntegration(tenantId, 'peppol');
  if (!integ) throw unprocessable('Set up a Peppol access point first (Integrations → Peppol)');
  try {
    const r = await transmitPeppol(integ, xml, { documentNumber: src.number, receiver: src.inv.bill_to?.peppol_id ?? null, sender: src.inv.seller?.peppol_id ?? null });
    return await withTenant(tenantId, async (db) => {
      const doc = await db.one(`INSERT INTO einvoice_documents (tenant_id, invoice_id, credit_note_id, scheme, status, mode, provider, provider_ref, payload, created_by)
        VALUES ($1,$2,$3,$4,'sent',$5,$6,$7,$8,$9) RETURNING *`,
        [tenantId, invoiceId, creditNoteId ?? null, scheme, integ.provider === 'peppol_test' ? 'test' : integ.mode, integ.provider, r.providerRef, xml, req?.auth?.userId ?? null]);
      await audit(db, req, { action: 'einvoice.peppol_sent', entityType: 'invoice', entityId: invoiceId, after: { scheme, document: src.number, ref: r.providerRef } });
      return doc;
    });
  } catch (e) {
    if (e instanceof AppError) throw e;
    await withTenant(tenantId, (db) => db.query(`INSERT INTO einvoice_documents (tenant_id, invoice_id, credit_note_id, scheme, status, mode, provider, payload, error, created_by)
      VALUES ($1,$2,$3,$4,'failed',$5,$6,$7,$8,$9)`, [tenantId, invoiceId, creditNoteId ?? null, scheme, integ.mode, integ.provider, xml, (e as Error).message.slice(0, 500), req?.auth?.userId ?? null]));
    throw new AppError(502, 'EINVOICE_PROVIDER_ERROR', `Peppol transmission failed: ${(e as Error).message}`);
  }
}

/** Automatic e-invoicing after issue (job): registers IRN or sends via Peppol when everything needed is present. */
export async function autoEinvoice(tenantId: string, invoiceId: string, creditNoteId?: string | null): Promise<string> {
  const src = await withTenant(tenantId, (db) => loadSource(db, invoiceId, creditNoteId));
  const schemes = applicableSchemes(src);
  if (schemes.includes('IN_IRN')) {
    if (!src.inv.bill_to?.tax_id) return 'skipped: B2C';
    if (!(await getIntegration(tenantId, 'einvoice'))) return 'skipped: no provider';
    await registerIrnFor(tenantId, null, invoiceId, creditNoteId);
    return 'registered';
  }
  if (!src.inv.bill_to?.peppol_id || !(await getIntegration(tenantId, 'peppol'))) return 'skipped: no Peppol receiver or provider';
  const variant: UblVariant = schemes.includes('XRECHNUNG') && src.inv.bill_to?.buyer_reference ? 'xrechnung' : 'peppol';
  await sendPeppolFor(tenantId, null, invoiceId, variant, creditNoteId);
  return 'sent';
}

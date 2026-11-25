import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { AppError } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { tx } from '../common.js';
import { getIntegration } from '../../integrations/registry.js';
import { applicableSchemes, cancelIrnFor, loadSource, readiness, registerIrnFor, sendPeppolFor, ublDocument } from './service.js';

export const einvoiceRouter = Router();
const cnQuery = z.object({ creditNoteId: z.string().uuid().optional() });

// Status, readiness checks (what is missing) and history for one invoice and its credit notes.
einvoiceRouter.get('/invoices/:id', requirePermission('invoices.read'), ah(async (req, res) => {
  const t = req.auth!.tenantId!;
  const out = await tx(req, async (db) => {
    const src = await loadSource(db, req.params.id);
    const cns = await db.many(`SELECT id, number, amount, reason, created_at FROM credit_notes WHERE invoice_id = $1 ORDER BY created_at`, [req.params.id]);
    const docs = await db.many(`SELECT id, credit_note_id, scheme, status, mode, provider, irn, ack_no, ack_date, provider_ref, error, created_at, cancelled_at, cancel_reason
      FROM einvoice_documents WHERE invoice_id = $1 ORDER BY created_at DESC`, [req.params.id]);
    const creditNotes = [];
    for (const cn of cns) creditNotes.push({ ...cn, readiness: readiness(await loadSource(db, req.params.id, cn.id)) });
    return { schemes: applicableSchemes(src), readiness: readiness(src), documents: docs, creditNotes };
  });
  const [einv, peppol] = await Promise.all([getIntegration(t, 'einvoice'), getIntegration(t, 'peppol')]);
  res.json({ data: { ...out, providers: { einvoice: einv ? { provider: einv.provider, mode: einv.mode } : null, peppol: peppol ? { provider: peppol.provider, mode: peppol.mode } : null } } });
}));

einvoiceRouter.post('/invoices/:id/irn', requirePermission('invoices.manage'), ah(async (req, res) => {
  const b = parse(cnQuery, req.body ?? {});
  res.status(201).json({ data: await registerIrnFor(req.auth!.tenantId!, req, req.params.id, b.creditNoteId) });
}));

einvoiceRouter.post('/documents/:docId/cancel', requirePermission('invoices.cancel'), ah(async (req, res) => {
  const b = parse(z.object({ reasonCode: z.enum(['1', '2', '3', '4']), remark: z.string().trim().min(3).max(100) }), req.body);
  res.json({ data: await cancelIrnFor(req.auth!.tenantId!, req, req.params.docId, b.reasonCode, b.remark) });
}));

// Download the UBL document (Peppol BIS 3.0 or XRechnung) — for upload to a customer portal or another network.
einvoiceRouter.get('/invoices/:id/ubl', requirePermission('invoices.read'), ah(async (req, res) => {
  const q = parse(cnQuery.extend({ variant: z.enum(['peppol', 'xrechnung']).default('peppol') }), req.query);
  const { xml, issues, number } = await tx(req, async (db) => {
    const src = await loadSource(db, req.params.id, q.creditNoteId);
    const doc = ublDocument(src, q.variant);
    await audit(db, req, { action: 'einvoice.ubl_exported', entityType: 'invoice', entityId: req.params.id, after: { variant: q.variant, document: src.number, valid: !doc.issues.length } });
    return { ...doc, number: src.number };
  });
  if (issues.length) throw new AppError(422, 'EINVOICE_INVALID', `The e-invoice cannot be created yet: ${issues[0].message}`, { issues });
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${number.replace(/[^\w.-]/g, '_')}-${q.variant}.xml"`);
  res.send(xml);
}));

einvoiceRouter.post('/invoices/:id/peppol', requirePermission('invoices.manage'), ah(async (req, res) => {
  const b = parse(cnQuery.extend({ variant: z.enum(['peppol', 'xrechnung']).default('peppol') }), req.body ?? {});
  res.status(201).json({ data: await sendPeppolFor(req.auth!.tenantId!, req, req.params.id, b.variant, b.creditNoteId) });
}));

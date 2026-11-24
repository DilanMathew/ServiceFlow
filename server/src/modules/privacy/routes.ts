import { Router } from 'express';
import { z } from 'zod';
import crypto from 'node:crypto';
import { ah, parse } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { notFound, unprocessable } from '../../lib/errors.js';
import { tx } from '../common.js';
import { storage } from '../../integrations/storage.js';
import { sha256 } from '../../lib/crypto.js';

export const privacyRouter = Router();

privacyRouter.get('/requests', ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => db.many(`SELECT d.*, c.full_name AS customer_name, c.number AS customer_number FROM data_requests d JOIN customers c ON c.id = d.customer_id ORDER BY d.created_at DESC LIMIT 200`)) });
}));

privacyRouter.post('/requests', ah(async (req, res) => {
  const b = parse(z.object({ customerId: z.string().uuid(), requestType: z.enum(['export', 'rectification', 'erasure']), notes: z.string().max(2000).nullish() }), req.body);
  const r = await tx(req, async (db) => {
    const r = await db.one(`INSERT INTO data_requests (tenant_id, customer_id, request_type, notes, requested_by) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [db.tenantId, b.customerId, b.requestType, b.notes ?? null, req.auth!.userId]);
    await audit(db, req, { action: 'privacy.request_logged', entityType: 'customer', entityId: b.customerId, after: { type: b.requestType } });
    return r;
  });
  res.status(201).json({ data: r });
}));

/**
 * Export: machine-readable JSON of everything held about the data subject.
 * Erasure: anonymises personal data while keeping financial records required by law (invoices keep
 * their issued snapshot; the customer row is de-identified).
 */
privacyRouter.post('/requests/:id/complete', ah(async (req, res) => {
  const out = await tx(req, async (db) => {
    const r = await db.maybeOne(`SELECT * FROM data_requests WHERE id = $1 FOR UPDATE`, [req.params.id]);
    if (!r) throw notFound('Request');
    if (r.status !== 'pending') throw unprocessable('Request already completed');
    const cid = r.customer_id;
    let documentId: string | null = null;
    if (r.request_type === 'export') {
      const data = {
        customer: await db.one(`SELECT * FROM customers WHERE id = $1`, [cid]),
        addresses: await db.many(`SELECT * FROM customer_addresses WHERE customer_id = $1`, [cid]),
        assets: await db.many(`SELECT * FROM assets WHERE customer_id = $1`, [cid]),
        serviceRequests: await db.many(`SELECT * FROM service_requests WHERE customer_id = $1`, [cid]),
        workOrders: await db.many(`SELECT id, number, title, description, status, scheduled_start, actual_start, actual_end, customer_notes, created_at FROM work_orders WHERE customer_id = $1`, [cid]),
        quotations: await db.many(`SELECT * FROM quotations WHERE customer_id = $1`, [cid]),
        invoices: await db.many(`SELECT * FROM invoices WHERE customer_id = $1`, [cid]),
        payments: await db.many(`SELECT id, amount, currency, method, status, received_at, receipt_number FROM payments WHERE customer_id = $1`, [cid]),
        contracts: await db.many(`SELECT * FROM amc_contracts WHERE customer_id = $1`, [cid]),
        feedback: await db.many(`SELECT * FROM customer_feedback WHERE customer_id = $1`, [cid]),
        communications: await db.many(`SELECT channel, direction, subject, body, created_at FROM communications WHERE customer_id = $1`, [cid]),
        exportedAt: new Date().toISOString(),
      };
      const buf = Buffer.from(JSON.stringify(data, null, 2));
      const key = `${db.tenantId}/privacy/${crypto.randomUUID()}.json`;
      await storage.put(key, buf, 'application/json');
      documentId = (await db.one(`INSERT INTO documents (tenant_id, entity_type, entity_id, category, file_name, mime_type, size_bytes, sha256, storage_key, uploaded_by)
        VALUES ($1,'customer',$2,'attachment',$3,'application/json',$4,$5,$6,$7) RETURNING id`, [db.tenantId, cid, `data-export-${cid}.json`, buf.length, sha256(buf), key, req.auth!.userId])).id;
    }
    if (r.request_type === 'erasure') {
      const open = await db.one(`SELECT count(*)::int n FROM work_orders WHERE customer_id = $1 AND status IN ('new','approved','scheduled','assigned','en_route','in_progress','on_hold')`, [cid]);
      if (open.n) throw unprocessable('Close or cancel open jobs before erasure');
      await db.query(`UPDATE customers SET full_name = 'Erased customer', company_name = NULL, email = NULL, phone = NULL, phone_normalized = NULL, alt_phone = NULL, tax_id = NULL,
        billing_line1 = NULL, billing_line2 = NULL, billing_city = NULL, billing_postal_code = NULL, notes = NULL, anonymized_at = now(), archived_at = COALESCE(archived_at, now()),
        status = 'archived', marketing_opt_in = false WHERE id = $1`, [cid]);
      await db.query(`UPDATE customer_addresses SET line1 = 'Erased', line2 = NULL, latitude = NULL, longitude = NULL, access_notes = NULL, deleted_at = COALESCE(deleted_at, now()) WHERE customer_id = $1`, [cid]);
      await db.query(`UPDATE service_requests SET contact_name = 'Erased', contact_phone = NULL, contact_email = NULL, address_text = NULL WHERE customer_id = $1`, [cid]);
      await db.query(`DELETE FROM communications WHERE customer_id = $1`, [cid]);
      await db.query(`UPDATE customer_feedback SET comment = NULL WHERE customer_id = $1`, [cid]);
      const u = await db.maybeOne(`SELECT portal_user_id FROM customers WHERE id = $1`, [cid]);
      if (u?.portal_user_id) await db.query(`UPDATE users SET is_active = false, email = 'erased-' || id || '@invalid', full_name = 'Erased', phone = NULL, password_hash = NULL WHERE id = $1`, [u.portal_user_id]);
    }
    await db.query(`UPDATE data_requests SET status = 'completed', completed_by = $2, completed_at = now(), result_document_id = $3 WHERE id = $1`, [r.id, req.auth!.userId, documentId]);
    await audit(db, req, { action: `privacy.${r.request_type}_completed`, entityType: 'customer', entityId: cid });
    return { documentId };
  });
  res.json({ data: out });
}));

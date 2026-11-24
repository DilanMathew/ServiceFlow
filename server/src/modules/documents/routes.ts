import { Router, type Request } from 'express';
import multer from 'multer';
import crypto from 'node:crypto';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, forbidden, notFound } from '../../lib/errors.js';
import { tx } from '../common.js';
import { assertLimit } from '../subscriptions/entitlements.js';
import { storage } from '../../integrations/storage.js';
import { config } from '../../config.js';
import { hmacSha256Hex, sha256 } from '../../lib/crypto.js';
import type { Db } from '../../db/pool.js';

export const documentsRouter = Router();
export const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: config.MAX_UPLOAD_MB * 1024 * 1024, files: 10 } });

/** Content sniffing: the declared MIME type is never trusted. */
export function detectType(buf: Buffer, name: string): { mime: string; ext: string } | null {
  const hex = buf.subarray(0, 12).toString('hex');
  if (hex.startsWith('ffd8ff')) return { mime: 'image/jpeg', ext: 'jpg' };
  if (hex.startsWith('89504e470d0a1a0a')) return { mime: 'image/png', ext: 'png' };
  if (hex.startsWith('52494646') && buf.subarray(8, 12).toString() === 'WEBP') return { mime: 'image/webp', ext: 'webp' };
  if (buf.subarray(4, 12).toString().startsWith('ftypheic') || buf.subarray(4, 12).toString().startsWith('ftypheix') || buf.subarray(4, 12).toString().startsWith('ftypmif1')) return { mime: 'image/heic', ext: 'heic' };
  if (hex.startsWith('25504446')) return { mime: 'application/pdf', ext: 'pdf' };
  if (hex.startsWith('504b0304')) {
    if (/\.docx$/i.test(name)) return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: 'docx' };
    if (/\.xlsx$/i.test(name)) return { mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', ext: 'xlsx' };
    return null;
  }
  if (/\.(txt|csv)$/i.test(name) && !buf.subarray(0, 4096).includes(0)) return { mime: name.toLowerCase().endsWith('.csv') ? 'text/csv' : 'text/plain', ext: name.split('.').pop()!.toLowerCase() };
  return null;
}

const ENTITY_TABLE: Record<string, string> = { customer: 'customers', asset: 'assets', work_order: 'work_orders', service_request: 'service_requests', quotation: 'quotations',
  invoice: 'invoices', amc_contract: 'amc_contracts', support_ticket: 'support_tickets', technician: 'technician_profiles', payment: 'payments' };
const ENTITY_READ: Record<string, string> = { customer: 'customers.read', asset: 'assets.read', work_order: 'work_orders.read', service_request: 'requests.read', quotation: 'quotations.read',
  invoice: 'invoices.read', amc_contract: 'amc.read', support_ticket: 'support.read', technician: 'technicians.read', payment: 'payments.read' };

/** Staff need the module permission for the entity; technicians only reach their own jobs. */
async function assertEntityAccess(db: Db, req: Request, entityType: string, entityId: string) {
  const table = ENTITY_TABLE[entityType];
  if (!table) throw badRequest('Unsupported entity type');
  const row = await db.maybeOne(`SELECT * FROM ${table} WHERE id = $1`, [entityId]);
  if (!row) throw notFound('Record');
  if (req.auth!.permissions.has(ENTITY_READ[entityType]) || req.auth!.permissions.has('documents.read')) return row;
  if (entityType === 'work_order' && req.auth!.technicianId && row.assigned_technician_id === req.auth!.technicianId) return row;
  if (entityType === 'asset' && req.auth!.technicianId && await db.maybeOne(`SELECT 1 FROM work_orders WHERE asset_id = $1 AND assigned_technician_id = $2`, [entityId, req.auth!.technicianId])) return row;
  throw forbidden();
}

export async function storeDocument(db: Db, file: Express.Multer.File, meta: { entityType: string; entityId: string; category: string; visibility: 'internal' | 'customer'; userId: string | null }) {
  const t = detectType(file.buffer, file.originalname);
  if (!t) throw badRequest(`Unsupported or unrecognised file type: ${file.originalname}. Allowed: JPG, PNG, WEBP, HEIC, PDF, DOCX, XLSX, CSV, TXT.`);
  await assertLimit(db, 'storage', file.size);
  const key = `${db.tenantId}/${meta.entityType}/${crypto.randomUUID()}.${t.ext}`;
  await storage.put(key, file.buffer, t.mime);
  const safeName = file.originalname.replace(/[^\w.\- ()]/g, '_').slice(-150) || `file.${t.ext}`;
  const s = await db.one(`SELECT document_retention_days FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
  return db.one(`INSERT INTO documents (tenant_id, entity_type, entity_id, category, file_name, mime_type, size_bytes, sha256, storage_key, visibility, uploaded_by, retain_until)
    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, CASE WHEN $12::int IS NULL THEN NULL ELSE current_date + $12::int END)
    RETURNING id, entity_type, entity_id, category, file_name, mime_type, size_bytes, visibility, created_at`,
    [db.tenantId, meta.entityType, meta.entityId, meta.category, safeName, t.mime, file.size, sha256(file.buffer), key, meta.visibility, meta.userId, s.document_retention_days]);
}

const categories = ['photo_before', 'photo_after', 'service_photo', 'equipment_document', 'warranty_certificate', 'quotation', 'invoice', 'contract', 'service_report',
  'customer_attachment', 'attachment', 'receipt'] as const;

documentsRouter.post('/', requirePermission('documents.upload'), upload.array('files', 10), ah(async (req, res) => {
  const b = parse(z.object({ entityType: z.enum(Object.keys(ENTITY_TABLE) as [string, ...string[]]), entityId: z.string().uuid(), category: z.enum(categories).default('attachment'),
    visibility: z.enum(['internal', 'customer']).default('internal') }), req.body);
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (!files.length) throw badRequest('No files received');
  const docs = await tx(req, async (db) => {
    const entity = await assertEntityAccess(db, req, b.entityType, b.entityId);
    if (b.entityType === 'work_order' && !req.auth!.permissions.has('work_orders.read') && ['invoiced', 'paid', 'cancelled'].includes(entity.status)) throw forbidden('This job is closed');
    const out = [];
    for (const f of files) out.push(await storeDocument(db, f, { ...b, userId: req.auth!.userId }));
    await audit(db, req, { action: 'document.uploaded', entityType: b.entityType, entityId: b.entityId, after: { files: out.map((d) => d.file_name), category: b.category } });
    return out;
  });
  res.status(201).json({ data: docs });
}));

documentsRouter.get('/', requirePermission('documents.read', 'work_orders.read_own'), ah(async (req, res) => {
  const q = parse(z.object({ entityType: z.string().optional(), entityId: z.string().uuid().optional(), category: z.string().optional(), q: z.string().optional(),
    page: z.coerce.number().int().min(1).default(1) }), req.query);
  const rows = await tx(req, async (db) => {
    if (q.entityType && q.entityId) await assertEntityAccess(db, req, q.entityType, q.entityId);
    else if (!req.auth!.permissions.has('documents.read')) throw forbidden();
    return db.many(`SELECT d.id, d.entity_type, d.entity_id, d.category, d.file_name, d.mime_type, d.size_bytes, d.visibility, d.created_at, u.full_name AS uploaded_by_name
      FROM documents d LEFT JOIN users u ON u.id = d.uploaded_by WHERE d.deleted_at IS NULL AND ($1::text IS NULL OR d.entity_type = $1) AND ($2::uuid IS NULL OR d.entity_id = $2)
      AND ($3::text IS NULL OR d.category = $3) AND ($4::text IS NULL OR d.file_name ILIKE '%' || $4 || '%') ORDER BY d.created_at DESC LIMIT 100 OFFSET $5`,
      [q.entityType ?? null, q.entityId ?? null, q.category ?? null, q.q ?? null, (q.page - 1) * 100]);
  });
  res.json({ data: rows });
}));

/** Short-lived signed link (5 min) so <img>/<iframe> previews work without exposing permanent URLs. */
export function signFileToken(tenantId: string, docId: string, ttlSec = 300) {
  const exp = Math.floor(Date.now() / 1000) + ttlSec;
  const payload = `${tenantId}.${docId}.${exp}`;
  return `${Buffer.from(payload).toString('base64url')}.${hmacSha256Hex(config.JWT_SECRET, `file:${payload}`)}`;
}

documentsRouter.post('/:id/link', requirePermission('documents.read', 'work_orders.read_own'), ah(async (req, res) => {
  const doc = await tx(req, async (db) => {
    const d = await db.maybeOne(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!d) throw notFound('Document');
    await assertEntityAccess(db, req, d.entity_type, d.entity_id);
    return d;
  });
  res.json({ data: { url: `/api/public/files/${signFileToken(req.auth!.tenantId!, doc.id)}`, expiresIn: 300 } });
}));

documentsRouter.get('/:id/download', requirePermission('documents.read', 'work_orders.read_own'), ah(async (req, res) => {
  const doc = await tx(req, async (db) => {
    const d = await db.maybeOne(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!d) throw notFound('Document');
    await assertEntityAccess(db, req, d.entity_type, d.entity_id);
    return d;
  });
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Content-Disposition', `attachment; filename="${encodeURIComponent(doc.file_name)}"`);
  (await storage.get(doc.storage_key)).pipe(res);
}));

documentsRouter.delete('/:id', requirePermission('documents.delete'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const d = await db.maybeOne(`SELECT * FROM documents WHERE id = $1 AND deleted_at IS NULL`, [req.params.id]);
    if (!d) throw notFound('Document');
    if (d.retain_until && new Date(d.retain_until) > new Date() && ['invoice', 'contract', 'receipt'].includes(d.category)) throw forbidden('This document is under retention and cannot be deleted yet');
    if (d.category === 'signature') throw forbidden('Customer signatures cannot be deleted');
    await db.query(`UPDATE documents SET deleted_at = now() WHERE id = $1`, [d.id]);
    await audit(db, req, { action: 'document.deleted', entityType: d.entity_type, entityId: d.entity_id, before: { file: d.file_name } });
  });
  res.json({ data: { ok: true } });
}));

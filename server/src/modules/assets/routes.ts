import { Router } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, mustFind } from '../common.js';
import { config } from '../../config.js';
import type { Db } from '../../db/pool.js';

export const assetsRouter = Router();
const read = requirePermission('assets.read', 'work_orders.read_own');
const manage = requirePermission('assets.manage');

const assetSchema = z.object({
  customerId: z.string().uuid(), addressId: z.string().uuid().nullish(), equipmentCategoryId: z.string().uuid().nullish(),
  name: z.string().trim().min(2).max(120), manufacturer: z.string().trim().max(80).nullish(), model: z.string().trim().max(80).nullish(),
  serialNumber: z.string().trim().max(80).nullish(), capacity: z.string().max(40).nullish(),
  installationDate: dateStr.nullish(), purchaseDate: dateStr.nullish(), warrantyStart: dateStr.nullish(), warrantyExpiry: dateStr.nullish(),
  nextServiceDue: dateStr.nullish(), status: z.enum(['active', 'under_repair', 'inactive', 'replaced', 'decommissioned']).default('active'),
  notes: z.string().max(5000).nullish(),
});
const cols: Record<string, string> = {
  customerId: 'customer_id', addressId: 'address_id', equipmentCategoryId: 'equipment_category_id', name: 'name', manufacturer: 'manufacturer',
  model: 'model', serialNumber: 'serial_number', capacity: 'capacity', installationDate: 'installation_date', purchaseDate: 'purchase_date',
  warrantyStart: 'warranty_start', warrantyExpiry: 'warranty_expiry', nextServiceDue: 'next_service_due', status: 'status', notes: 'notes',
};

function validateDates(b: Partial<z.infer<typeof assetSchema>>) {
  if (b.warrantyStart && b.warrantyExpiry && b.warrantyExpiry < b.warrantyStart) throw badRequest('Warranty expiry must be after warranty start');
}

async function checkAddress(db: Db, customerId: string, addressId?: string | null) {
  if (!addressId) return;
  const ok = await db.maybeOne(`SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [addressId, customerId]);
  if (!ok) throw badRequest('The address does not belong to this customer');
}

export async function createAsset(db: Db, b: z.infer<typeof assetSchema>) {
  validateDates(b);
  await checkAddress(db, b.customerId, b.addressId);
  let next = b.nextServiceDue;
  if (!next && b.equipmentCategoryId) {
    const cat = await db.maybeOne(`SELECT maintenance_interval_days FROM equipment_categories WHERE id = $1`, [b.equipmentCategoryId]);
    if (cat?.maintenance_interval_days) {
      const base = new Date(b.installationDate ?? new Date().toISOString().slice(0, 10));
      base.setDate(base.getDate() + cat.maintenance_interval_days);
      next = base.toISOString().slice(0, 10);
    }
  }
  const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined && k !== 'nextServiceDue');
  return db.one(`INSERT INTO assets (tenant_id, number, next_service_due, ${keys.map((k) => cols[k]).join(',')}) VALUES ($1,$2,$3, ${keys.map((_, i) => `$${i + 4}`).join(',')}) RETURNING *`,
    [db.tenantId, await nextNumber(db, 'asset'), next ?? null, ...keys.map((k) => (b as any)[k])]);
}

assetsRouter.get('/', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ customerId: z.string().uuid().optional(), status: z.string().optional(), categoryId: z.string().uuid().optional(),
    warranty: z.enum(['active', 'expired', 'expiring']).optional(), serviceDue: z.coerce.boolean().optional() }), req.query);
  const w = new Where();
  w.addIf(q.customerId, 'a.customer_id = ?', q.customerId);
  w.addIf(q.status, 'a.status = ?', q.status);
  w.addIf(q.categoryId, 'a.equipment_category_id = ?', q.categoryId);
  if (q.warranty === 'active') w.add('a.warranty_expiry >= current_date');
  if (q.warranty === 'expired') w.add('a.warranty_expiry < current_date');
  if (q.warranty === 'expiring') w.add(`a.warranty_expiry BETWEEN current_date AND current_date + 30`);
  if (q.serviceDue) w.add(`a.next_service_due <= current_date + 14`);
  if (q.q) w.add('(a.name ILIKE ? OR a.serial_number ILIKE ? OR a.model ILIKE ? OR a.manufacturer ILIKE ? OR a.number ILIKE ? OR c.full_name ILIKE ?)', ...Array(6).fill(`%${q.q}%`));
  if (!req.auth!.permissions.has('assets.read')) w.add(`EXISTS (SELECT 1 FROM work_orders wo WHERE wo.asset_id = a.id AND wo.assigned_technician_id = ?)`, req.auth!.technicianId);
  const order = orderBy(q, { name: 'a.name', number: 'a.number', warranty: 'a.warranty_expiry', next: 'a.next_service_due', created: 'a.created_at' }, 'a.created_at');
  const rows = await tx(req, (db) => db.many(
    `SELECT a.id, a.number, a.name, a.manufacturer, a.model, a.serial_number, a.status, a.warranty_expiry, a.next_service_due, a.last_service_date, a.installation_date,
            c.id AS customer_id, c.full_name AS customer_name, e.name AS category_name, count(*) OVER() AS _total
       FROM assets a JOIN customers c ON c.id = a.customer_id LEFT JOIN equipment_categories e ON e.id = a.equipment_category_id
       ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

assetsRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(assetSchema, req.body);
  const a = await tx(req, async (db) => {
    const a = await createAsset(db, b);
    await audit(db, req, { action: 'asset.created', entityType: 'asset', entityId: a.id, after: a });
    return a;
  });
  res.status(201).json({ data: a });
}));

assetsRouter.get('/:id', read, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const a = await db.maybeOne(`SELECT a.*, c.full_name AS customer_name, c.phone AS customer_phone, e.name AS category_name,
        ad.line1, ad.line2, ad.city, ad.postal_code, r.number AS replaced_by_number
      FROM assets a JOIN customers c ON c.id = a.customer_id LEFT JOIN equipment_categories e ON e.id = a.equipment_category_id
      LEFT JOIN customer_addresses ad ON ad.id = a.address_id LEFT JOIN assets r ON r.id = a.replaced_by_asset_id WHERE a.id = $1`, [req.params.id]);
    if (!a) throw badRequest('Asset not found');
    const [workOrders, contracts, documents, replaces] = await Promise.all([
      db.many(`SELECT w.id, w.number, w.title, w.status, w.scheduled_start, w.actual_end, sc.name AS category, u.full_name AS technician_name,
                 sr.findings, sr.work_performed, sr.equipment_condition
               FROM work_orders w LEFT JOIN service_categories sc ON sc.id = w.service_category_id LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id
               LEFT JOIN users u ON u.id = tp.user_id LEFT JOIN service_reports sr ON sr.work_order_id = w.id
               WHERE w.asset_id = $1 ORDER BY COALESCE(w.actual_end, w.scheduled_start, w.created_at) DESC`, [a.id]),
      db.many(`SELECT m.id, m.number, m.status, m.start_date, m.end_date FROM amc_contracts m JOIN amc_contract_assets x ON x.contract_id = m.id WHERE x.asset_id = $1`, [a.id]),
      db.many(`SELECT id, file_name, mime_type, size_bytes, category, created_at FROM documents WHERE entity_type = 'asset' AND entity_id = $1 AND deleted_at IS NULL`, [a.id]),
      db.many(`SELECT id, number, name FROM assets WHERE replaced_by_asset_id = $1`, [a.id]),
    ]);
    const today = new Date().toISOString().slice(0, 10);
    const warrantyStatus = !a.warranty_expiry ? 'unknown' : a.warranty_expiry < today ? 'expired' : 'active';
    return { ...a, warrantyStatus, workOrders, contracts, documents, replaces, qrUrl: `${config.APP_URL}/q/${a.qr_token}` };
  });
  res.json({ data });
}));

assetsRouter.get('/:id/qr.png', read, ah(async (req, res) => {
  const a = await tx(req, (db) => mustFind(db, 'assets', req.params.id, 'Asset', 'qr_token, number'));
  const png = await QRCode.toBuffer(`${config.APP_URL}/q/${a.qr_token}`, { width: 512, margin: 2, errorCorrectionLevel: 'M' });
  res.setHeader('Content-Type', 'image/png');
  res.setHeader('Content-Disposition', `inline; filename="${a.number}-qr.png"`);
  res.send(png);
}));

assetsRouter.patch('/:id', manage, ah(async (req, res) => {
  const b = parse(assetSchema.partial(), req.body);
  const out = await tx(req, async (db) => {
    const before = await mustFind(db, 'assets', req.params.id, 'Asset');
    validateDates({ warrantyStart: b.warrantyStart ?? before.warranty_start, warrantyExpiry: b.warrantyExpiry ?? before.warranty_expiry });
    await checkAddress(db, b.customerId ?? before.customer_id, b.addressId);
    if (b.customerId && b.customerId !== before.customer_id) {
      const open = await db.maybeOne(`SELECT 1 FROM work_orders WHERE asset_id = $1 AND status NOT IN ('completed','invoiced','paid','cancelled','rejected')`, [before.id]);
      if (open) throw conflict('Cannot transfer an asset with open work orders');
    }
    const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await db.one(`UPDATE assets SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (b as any)[k])]);
    await audit(db, req, { action: 'asset.updated', entityType: 'asset', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

/** Equipment replacement: creates the new asset and links the old one as replaced, preserving its history. */
assetsRouter.post('/:id/replace', manage, ah(async (req, res) => {
  const b = parse(assetSchema.omit({ customerId: true }).extend({ reason: z.string().trim().min(3).max(500) }), req.body);
  const out = await tx(req, async (db) => {
    const old = await mustFind(db, 'assets', req.params.id, 'Asset');
    if (old.status === 'replaced') throw conflict('This asset has already been replaced');
    const created = await createAsset(db, { ...b, customerId: old.customer_id, addressId: b.addressId ?? old.address_id,
      equipmentCategoryId: b.equipmentCategoryId ?? old.equipment_category_id });
    await db.query(`UPDATE assets SET status = 'replaced', replaced_by_asset_id = $2, replacement_reason = $3 WHERE id = $1`, [old.id, created.id, b.reason]);
    await db.query(`UPDATE amc_contract_assets SET asset_id = $2 WHERE asset_id = $1 AND contract_id IN (SELECT id FROM amc_contracts WHERE status = 'active')`, [old.id, created.id]);
    await audit(db, req, { action: 'asset.replaced', entityType: 'asset', entityId: old.id, after: { replacedBy: created.id, reason: b.reason } });
    return created;
  });
  res.status(201).json({ data: out });
}));

import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, listQuery, orderBy, paged, parse, toCsv, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { tx, mustFind } from '../common.js';
import { moveStock, defaultLocation } from './service.js';
import type { Request } from 'express';

export const inventoryRouter = Router();
const read = requirePermission('inventory.read');
const manage = requirePermission('inventory.manage');
const showCost = (req: Request) => req.auth!.permissions.has('inventory.manage') || req.auth!.permissions.has('reports.financial');

const itemSchema = z.object({
  sku: z.string().trim().toUpperCase().regex(/^[A-Z0-9._-]{2,40}$/, 'SKU: 2-40 letters, numbers, dot, dash or underscore'), name: z.string().trim().min(2).max(150),
  category: z.string().max(80).nullish(), description: z.string().max(2000).nullish(), unit: z.string().max(12).default('pcs'),
  purchasePrice: z.number().min(0).default(0), sellingPrice: z.number().min(0).default(0), taxRateId: z.string().uuid().nullish(),
  minStock: z.number().min(0).default(0), supplierId: z.string().uuid().nullish(), isActive: z.boolean().default(true),
  openingStock: z.number().min(0).optional(), openingLocationId: z.string().uuid().optional(),
});
const cols: Record<string, string> = { sku: 'sku', name: 'name', category: 'category', description: 'description', unit: 'unit', purchasePrice: 'purchase_price',
  sellingPrice: 'selling_price', taxRateId: 'tax_rate_id', minStock: 'min_stock', supplierId: 'supplier_id', isActive: 'is_active' };

inventoryRouter.get('/items', read, ah(async (req, res) => {
  const q = parse(listQuery.extend({ category: z.string().optional(), lowStock: z.coerce.boolean().optional(), active: z.enum(['true', 'false', 'all']).default('true'),
    locationId: z.string().uuid().optional(), format: z.enum(['json', 'csv']).default('json') }), req.query);
  const w = new Where();
  if (q.active !== 'all') w.add('i.is_active = ?', q.active === 'true');
  w.addIf(q.category, 'i.category = ?', q.category);
  if (q.q) w.add('(i.sku ILIKE ? OR i.name ILIKE ? OR i.category ILIKE ?)', ...Array(3).fill(`%${q.q}%`));
  const stockExpr = q.locationId ? `(SELECT COALESCE(sum(quantity),0) FROM inventory_stock s WHERE s.item_id = i.id AND s.location_id = '${q.locationId}')` : `(SELECT COALESCE(sum(quantity),0) FROM inventory_stock s WHERE s.item_id = i.id)`;
  if (q.lowStock) w.add(`${stockExpr} <= i.min_stock`);
  const order = orderBy(q, { sku: 'i.sku', name: 'i.name', stock: 'on_hand', category: 'i.category' }, 'i.name');
  const rows = await tx(req, (db) => db.many(`SELECT i.id, i.sku, i.name, i.category, i.unit, i.selling_price, ${showCost(req) ? 'i.purchase_price,' : ''} i.min_stock, i.is_active,
      s.name AS supplier_name, t.name AS tax_name, ${stockExpr} AS on_hand, (${stockExpr} <= i.min_stock) AS low_stock, count(*) OVER() AS _total
    FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id LEFT JOIN tax_rates t ON t.id = i.tax_rate_id
    ${w.sql} ORDER BY ${order} LIMIT ${q.format === 'csv' ? 50000 : q.pageSize} OFFSET ${q.format === 'csv' ? 0 : (q.page - 1) * q.pageSize}`, w.params));
  if (q.format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8'); res.setHeader('Content-Disposition', 'attachment; filename="inventory.csv"');
    return res.send(toCsv(rows, ['sku', 'name', 'category', 'unit', 'on_hand', 'min_stock', 'purchase_price', 'selling_price', 'supplier_name']));
  }
  res.json(paged(rows, q));
}));

inventoryRouter.post('/items', manage, ah(async (req, res) => {
  const b = parse(itemSchema, req.body);
  const item = await tx(req, async (db) => {
    const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
    const it = await db.one(`INSERT INTO inventory_items (tenant_id, ${keys.map((k) => cols[k]).join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
      [db.tenantId, ...keys.map((k) => (b as any)[k])]);
    if (b.openingStock && b.openingStock > 0) {
      await moveStock(db, { itemId: it.id, locationId: b.openingLocationId ?? await defaultLocation(db), quantityChange: b.openingStock, type: 'opening',
        unitCost: b.purchasePrice, reason: 'Opening stock', userId: req.auth!.userId });
    }
    await audit(db, req, { action: 'inventory.item_created', entityType: 'inventory_item', entityId: it.id, after: it });
    return it;
  });
  res.status(201).json({ data: item });
}));

inventoryRouter.get('/items/:id', read, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const item = await db.maybeOne(`SELECT i.*, s.name AS supplier_name FROM inventory_items i LEFT JOIN suppliers s ON s.id = i.supplier_id WHERE i.id = $1`, [req.params.id]);
    if (!item) throw notFound('Item');
    if (!showCost(req)) delete item.purchase_price;
    const [stock, transactions, usage] = await Promise.all([
      db.many(`SELECT l.id AS location_id, l.name AS location_name, l.location_type, COALESCE(s.quantity, 0) AS quantity FROM stock_locations l
        LEFT JOIN inventory_stock s ON s.location_id = l.id AND s.item_id = $1 ORDER BY l.is_default DESC, l.name`, [item.id]),
      db.many(`SELECT t.*, l.name AS location_name, u.full_name AS user_name, w.number AS work_order_number FROM inventory_transactions t JOIN stock_locations l ON l.id = t.location_id
        LEFT JOIN users u ON u.id = t.created_by LEFT JOIN work_orders w ON w.id = t.reference_id AND t.reference_type = 'work_order'
        WHERE t.item_id = $1 ORDER BY t.created_at DESC LIMIT 200`, [item.id]),
      db.one(`SELECT COALESCE(-sum(quantity_change) FILTER (WHERE txn_type = 'job_usage' AND created_at > now() - interval '30 days'),0) AS used_30d,
        COALESCE(-sum(quantity_change) FILTER (WHERE txn_type = 'job_usage' AND created_at > now() - interval '90 days'),0) AS used_90d FROM inventory_transactions WHERE item_id = $1`, [item.id]),
    ]);
    return { ...item, stock, transactions, usage, onHand: stock.reduce((a, s) => a + Number(s.quantity), 0) };
  });
  res.json({ data });
}));

inventoryRouter.patch('/items/:id', manage, ah(async (req, res) => {
  const b = parse(itemSchema.omit({ openingStock: true, openingLocationId: true }).partial(), req.body);
  const out = await tx(req, async (db) => {
    const before = await mustFind(db, 'inventory_items', req.params.id, 'Item');
    const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await db.one(`UPDATE inventory_items SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (b as any)[k])]);
    await audit(db, req, { action: 'inventory.item_updated', entityType: 'inventory_item', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

/** Manual stock adjustment (count correction, damage, loss) — reason is mandatory and audited. */
inventoryRouter.post('/adjustments', manage, ah(async (req, res) => {
  const b = parse(z.object({ itemId: z.string().uuid(), locationId: z.string().uuid(), quantityChange: z.number().refine((n) => n !== 0, 'Cannot be zero'),
    reason: z.string().trim().min(3).max(500) }), req.body);
  const t = await tx(req, async (db) => {
    const t = await moveStock(db, { itemId: b.itemId, locationId: b.locationId, quantityChange: b.quantityChange, type: 'adjustment', reason: b.reason, userId: req.auth!.userId });
    await audit(db, req, { action: 'inventory.adjusted', entityType: 'inventory_item', entityId: b.itemId, after: { change: b.quantityChange, location: b.locationId, reason: b.reason, after: t.quantity_after } });
    return t;
  });
  res.status(201).json({ data: t });
}));

inventoryRouter.post('/transfers', manage, ah(async (req, res) => {
  const b = parse(z.object({ itemId: z.string().uuid(), fromLocationId: z.string().uuid(), toLocationId: z.string().uuid(), quantity: z.number().positive(),
    reason: z.string().max(500).nullish() }), req.body);
  if (b.fromLocationId === b.toLocationId) throw badRequest('Choose two different locations');
  await tx(req, async (db) => {
    const ref = crypto.randomUUID();
    await moveStock(db, { itemId: b.itemId, locationId: b.fromLocationId, quantityChange: -b.quantity, type: 'transfer_out', referenceType: 'transfer', referenceId: ref, reason: b.reason, userId: req.auth!.userId });
    await moveStock(db, { itemId: b.itemId, locationId: b.toLocationId, quantityChange: b.quantity, type: 'transfer_in', referenceType: 'transfer', referenceId: ref, reason: b.reason, userId: req.auth!.userId });
    await audit(db, req, { action: 'inventory.transferred', entityType: 'inventory_item', entityId: b.itemId, after: b });
  });
  res.status(201).json({ data: { ok: true } });
}));

inventoryRouter.get('/purchases', read, ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT p.*, s.name AS supplier_name, l.name AS location_name,
      (SELECT json_agg(json_build_object('item', i.name, 'sku', i.sku, 'quantity', pi.quantity, 'unit_cost', pi.unit_cost)) FROM purchase_record_items pi JOIN inventory_items i ON i.id = pi.item_id WHERE pi.purchase_record_id = p.id) AS items
    FROM purchase_records p LEFT JOIN suppliers s ON s.id = p.supplier_id JOIN stock_locations l ON l.id = p.location_id ORDER BY p.purchase_date DESC, p.created_at DESC LIMIT 200`));
  res.json({ data: rows });
}));

inventoryRouter.post('/purchases', manage, ah(async (req, res) => {
  const b = parse(z.object({ supplierId: z.string().uuid().nullish(), locationId: z.string().uuid(), reference: z.string().max(80).nullish(), purchaseDate: dateStr.optional(),
    notes: z.string().max(2000).nullish(), updateCostPrice: z.boolean().default(true),
    items: z.array(z.object({ itemId: z.string().uuid(), quantity: z.number().positive(), unitCost: z.number().min(0) })).min(1).max(200) }), req.body);
  const out = await tx(req, async (db) => {
    const total = b.items.reduce((a, i) => a + i.quantity * i.unitCost, 0);
    const p = await db.one(`INSERT INTO purchase_records (tenant_id, supplier_id, location_id, reference, purchase_date, total_amount, notes, created_by)
      VALUES ($1,$2,$3,$4,COALESCE($5::date, current_date),$6,$7,$8) RETURNING *`,
      [db.tenantId, b.supplierId ?? null, b.locationId, b.reference ?? null, b.purchaseDate ?? null, Math.round(total * 100) / 100, b.notes ?? null, req.auth!.userId]);
    for (const it of b.items) {
      await db.query(`INSERT INTO purchase_record_items (tenant_id, purchase_record_id, item_id, quantity, unit_cost) VALUES ($1,$2,$3,$4,$5)`, [db.tenantId, p.id, it.itemId, it.quantity, it.unitCost]);
      await moveStock(db, { itemId: it.itemId, locationId: b.locationId, quantityChange: it.quantity, type: 'purchase', unitCost: it.unitCost, referenceType: 'purchase', referenceId: p.id,
        reason: b.reference ? `Purchase ${b.reference}` : 'Purchase', userId: req.auth!.userId });
      if (b.updateCostPrice) await db.query(`UPDATE inventory_items SET purchase_price = $2 WHERE id = $1`, [it.itemId, it.unitCost]);
    }
    await audit(db, req, { action: 'inventory.purchase_recorded', entityType: 'purchase_record', entityId: p.id, after: { total, items: b.items.length } });
    return p;
  });
  res.status(201).json({ data: out });
}));

inventoryRouter.get('/low-stock', read, ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT i.id, i.sku, i.name, i.unit, i.min_stock, COALESCE(sum(s.quantity),0) AS on_hand, sp.name AS supplier_name
    FROM inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id LEFT JOIN suppliers sp ON sp.id = i.supplier_id
    WHERE i.is_active GROUP BY i.id, sp.name HAVING COALESCE(sum(s.quantity),0) <= i.min_stock ORDER BY (COALESCE(sum(s.quantity),0) - i.min_stock)`));
  res.json({ data: rows });
}));

inventoryRouter.get('/locations', read, ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => db.many(`SELECT l.*, b.name AS branch_name, u.full_name AS technician_name FROM stock_locations l LEFT JOIN branches b ON b.id = l.branch_id
    LEFT JOIN technician_profiles tp ON tp.id = l.technician_id LEFT JOIN users u ON u.id = tp.user_id ORDER BY l.is_default DESC, l.name`)) });
}));

// Suppliers
const supplierSchema = z.object({ name: z.string().trim().min(2).max(150), contactName: z.string().max(120).nullish(), email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(), address: z.string().max(500).nullish(), taxId: z.string().max(40).nullish(), isActive: z.boolean().default(true) });
const supCols: Record<string, string> = { name: 'name', contactName: 'contact_name', email: 'email', phone: 'phone', address: 'address', taxId: 'tax_id', isActive: 'is_active' };
inventoryRouter.get('/suppliers', read, ah(async (req, res) => { res.json({ data: await tx(req, (db) => db.many(`SELECT * FROM suppliers ORDER BY is_active DESC, name`)) }); }));
inventoryRouter.post('/suppliers', manage, ah(async (req, res) => {
  const b = parse(supplierSchema, req.body);
  const keys = Object.keys(supCols).filter((k) => (b as any)[k] !== undefined);
  res.status(201).json({ data: await tx(req, (db) => db.one(`INSERT INTO suppliers (tenant_id, ${keys.map((k) => supCols[k]).join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
    [db.tenantId, ...keys.map((k) => (b as any)[k])])) });
}));
inventoryRouter.patch('/suppliers/:id', manage, ah(async (req, res) => {
  const b = parse(supplierSchema.partial(), req.body);
  const keys = Object.keys(supCols).filter((k) => (b as any)[k] !== undefined);
  if (!keys.length) throw unprocessable('Nothing to update');
  res.json({ data: await tx(req, (db) => db.one(`UPDATE suppliers SET ${keys.map((k, i) => `${supCols[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [req.params.id, ...keys.map((k) => (b as any)[k])])) });
}));

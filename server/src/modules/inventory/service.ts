import type { Db } from '../../db/pool.js';
import { unprocessable } from '../../lib/errors.js';

/**
 * The ONLY way stock changes. Row-locks the stock row, refuses to go negative (also enforced by a
 * CHECK constraint), and writes an immutable inventory_transactions ledger entry in the same transaction.
 */
export async function moveStock(db: Db, p: {
  itemId: string; locationId: string; quantityChange: number;
  type: 'purchase' | 'adjustment' | 'job_usage' | 'job_return' | 'transfer_in' | 'transfer_out' | 'opening';
  unitCost?: number | null; referenceType?: string; referenceId?: string; reason?: string | null; userId?: string | null;
}) {
  if (p.quantityChange === 0) throw unprocessable('Quantity change cannot be zero');
  await db.query(`INSERT INTO inventory_stock (tenant_id, item_id, location_id, quantity) VALUES ($1,$2,$3,0) ON CONFLICT (item_id, location_id) DO NOTHING`,
    [db.tenantId, p.itemId, p.locationId]);
  const row = await db.one(`SELECT quantity FROM inventory_stock WHERE item_id = $1 AND location_id = $2 FOR UPDATE`, [p.itemId, p.locationId]);
  const after = Number(row.quantity) + p.quantityChange;
  if (after < 0) {
    const item = await db.one(`SELECT name, unit FROM inventory_items WHERE id = $1`, [p.itemId]);
    throw unprocessable(`Insufficient stock for ${item.name}: ${Number(row.quantity)} ${item.unit} available`, { available: Number(row.quantity) });
  }
  await db.query(`UPDATE inventory_stock SET quantity = $3, updated_at = now() WHERE item_id = $1 AND location_id = $2`, [p.itemId, p.locationId, after]);
  return db.one(
    `INSERT INTO inventory_transactions (tenant_id, item_id, location_id, txn_type, quantity_change, quantity_after, unit_cost, reference_type, reference_id, reason, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
    [db.tenantId, p.itemId, p.locationId, p.type, p.quantityChange, after, p.unitCost ?? null, p.referenceType ?? null, p.referenceId ?? null, p.reason ?? null, p.userId ?? null]);
}

export async function defaultLocation(db: Db, branchId?: string | null, technicianId?: string | null) {
  if (technicianId) {
    const van = await db.maybeOne(`SELECT id FROM stock_locations WHERE technician_id = $1 LIMIT 1`, [technicianId]);
    if (van) return van.id as string;
  }
  const loc = await db.maybeOne(`SELECT id FROM stock_locations WHERE ($1::uuid IS NULL OR branch_id = $1) ORDER BY is_default DESC, created_at LIMIT 1`, [branchId ?? null])
    ?? await db.maybeOne(`SELECT id FROM stock_locations ORDER BY is_default DESC, created_at LIMIT 1`);
  if (!loc) throw unprocessable('No stock location configured');
  return loc.id as string;
}

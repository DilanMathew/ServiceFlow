import { withTenant } from '../db/pool.js';
import { nextNumber } from '../lib/numbering.js';
import { createWorkOrder } from '../modules/workorders/service.js';

/** Small, clearly-labelled sample data for a brand-new business (onboarding "add sample data"). */
export async function seedSampleData(tenantId: string) {
  await withTenant(tenantId, async (db) => {
    if (await db.maybeOne(`SELECT 1 FROM customers WHERE source = 'sample' LIMIT 1`)) return;
    const cat = await db.maybeOne(`SELECT id, name FROM service_categories ORDER BY name LIMIT 1`);
    const eq = await db.maybeOne(`SELECT id, name FROM equipment_categories ORDER BY name LIMIT 1`);
    const people = [['Sample Customer — Anita Desai', '+91 90000 00001'], ['Sample Customer — John Mathews', '+91 90000 00002'], ['Sample Customer — Greenleaf Cafe', '+91 90000 00003']];
    for (let i = 0; i < people.length; i++) {
      const c = await db.one(`INSERT INTO customers (tenant_id, number, full_name, phone, phone_normalized, source, notes) VALUES ($1,$2,$3,$4,$5,'sample','Sample record — safe to archive') RETURNING id`,
        [tenantId, await nextNumber(db, 'customer'), people[i][0], people[i][1], people[i][1].replace(/\D/g, '').slice(-10)]);
      const a = await db.one(`INSERT INTO customer_addresses (tenant_id, customer_id, line1, city, is_default) VALUES ($1,$2,$3,'Sample City',true) RETURNING id`, [tenantId, c.id, `${10 + i} Sample Street`]);
      const asset = eq ? await db.one(`INSERT INTO assets (tenant_id, number, customer_id, address_id, equipment_category_id, name, manufacturer) VALUES ($1,$2,$3,$4,$5,$6,'Sample') RETURNING id`,
        [tenantId, await nextNumber(db, 'asset'), c.id, a.id, eq.id, eq.name]) : null;
      await createWorkOrder(db, null, { customerId: c.id, addressId: a.id, assetId: asset?.id, serviceCategoryId: cat?.id, title: `${cat?.name ?? 'Service'} — sample job`,
        description: 'This is a sample job created during onboarding.', priority: i === 0 ? 'high' : 'normal', status: i === 2 ? 'approved' : 'new' });
    }
  });
}

import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, as, makeCustomer, staff, type TenantCtx } from './helpers.js';
import { withTenant } from '../src/db/pool.js';

describe('tenant isolation', () => {
  let A: TenantCtx, B: TenantCtx;
  let custA: any, woA: any;
  beforeAll(async () => {
    A = await registerTenant('CoolCare');
    B = await registerTenant('Prime Electricals');
    custA = await makeCustomer(A.owner.token, { email: 'shared@example.com' });
    woA = (await as(A.owner.token).post('/api/app/work-orders', { customerId: custA.id, title: 'Tenant A job' })).body.data;
  });

  it('lists never include another tenant\'s records', async () => {
    const list = await as(B.owner.token).get('/api/app/customers?status=all');
    expect(list.body.data.find((c: any) => c.id === custA.id)).toBeUndefined();
    const jobs = await as(B.owner.token).get('/api/app/work-orders');
    expect(jobs.body.meta.total).toBe(0);
    const search = await as(B.owner.token).get('/api/app/search?q=Cust');
    expect(search.body.data.find((x: any) => x.id === custA.id)).toBeUndefined();
  });

  it('direct access by id returns 404 (read, update, delete)', async () => {
    expect((await as(B.owner.token).get(`/api/app/customers/${custA.id}`)).status).toBe(404);
    expect((await as(B.owner.token).patch(`/api/app/customers/${custA.id}`, { fullName: 'Hacked' })).status).toBe(404);
    expect((await as(B.owner.token).delete(`/api/app/customers/${custA.id}`)).status).toBe(404);
    expect((await as(B.owner.token).get(`/api/app/work-orders/${woA.id}`)).status).toBe(404);
    expect((await as(B.owner.token).post(`/api/app/work-orders/${woA.id}/status`, { status: 'cancelled', reason: 'x' })).status).toBe(404);
    const stillA = await as(A.owner.token).get(`/api/app/customers/${custA.id}`);
    expect(stillA.body.data.full_name).not.toBe('Hacked');
  });

  it('cannot reference another tenant\'s records when creating data', async () => {
    const r = await as(B.owner.token).post('/api/app/work-orders', { customerId: custA.id, title: 'Cross-tenant job' });
    expect(r.status).toBe(400);
    const q = await as(B.owner.token).post('/api/app/quotations', { customerId: custA.id, items: [{ itemType: 'labour', description: 'x', quantity: 1, unitPrice: 1 }] });
    expect(q.status).toBe(400);
  });

  it('allows the same customer email in different tenants (uniqueness is per tenant)', async () => {
    const r = await as(B.owner.token).post('/api/app/customers', { fullName: 'Other business customer', email: 'shared@example.com' });
    expect(r.status).toBe(201);
  });

  it('PostgreSQL RLS blocks cross-tenant reads and writes even with raw SQL', async () => {
    const rows = await withTenant(B.tenantId, (db) => db.many(`SELECT id FROM customers WHERE id = $1`, [custA.id]));
    expect(rows).toHaveLength(0);
    const all = await withTenant(B.tenantId, (db) => db.many(`SELECT DISTINCT tenant_id FROM customers`));
    expect(all.every((r) => r.tenant_id === B.tenantId)).toBe(true);
    await expect(withTenant(B.tenantId, (db) => db.query(`INSERT INTO customers (tenant_id, number, full_name) VALUES ($1, 'X-1', 'Injected')`, [A.tenantId]))).rejects.toThrow(/row-level security/);
    const upd = await withTenant(B.tenantId, (db) => db.query(`UPDATE customers SET full_name = 'pwned' WHERE id = $1`, [custA.id]));
    expect(upd.rowCount).toBe(0);
    await expect(withTenant(B.tenantId, (db) => db.query(`UPDATE audit_logs SET action = 'x'`))).rejects.toThrow();
  });

  it('composite foreign keys prevent linking rows across tenants at the database level', async () => {
    const custB = await makeCustomer(B.owner.token);
    await expect(withTenant(A.tenantId, (db) => db.query(
      `INSERT INTO work_orders (tenant_id, number, customer_id, title) VALUES ($1, 'JOB-X', $2, 'bad')`, [A.tenantId, custB.id]))).rejects.toThrow();
  });

  it('a technician of tenant B cannot see tenant A jobs, documents or calendar', async () => {
    const tech = await staff(B, 'technician', { technician: true });
    expect((await as(tech.token).get(`/api/app/work-orders/${woA.id}`)).status).toBe(404);
    const cal = await as(tech.token).get(`/api/app/calendar?from=${new Date(Date.now() - 864e5 * 30).toISOString()}&to=${new Date(Date.now() + 864e5 * 30).toISOString()}`);
    expect(cal.body.data.jobs).toHaveLength(0);
  });
});

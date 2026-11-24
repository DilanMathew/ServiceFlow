import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, as, makeCustomer, type TenantCtx } from './helpers.js';

describe('customers & assets', () => {
  let t: TenantCtx;
  beforeAll(async () => { t = await registerTenant(); });

  it('creates customers with addresses and blocks exact duplicates (email or phone)', async () => {
    const c = await makeCustomer(t.owner.token, { email: 'dup@example.com', phone: '+91 98765 43210' });
    const byEmail = await as(t.owner.token).post('/api/app/customers', { fullName: 'Someone Else', email: 'DUP@example.com' });
    expect(byEmail.status).toBe(409);
    const byPhone = await as(t.owner.token).post('/api/app/customers', { fullName: 'Another', phone: '098765 43210' });
    expect(byPhone.status).toBe(409);
    expect(byPhone.body.error.details.duplicates[0].id).toBe(c.id);
    const d = await as(t.owner.token).get(`/api/app/customers/${c.id}`);
    expect(d.body.data.addresses).toHaveLength(1);
  });

  it('warns on similar names in the same postcode and allows an explicit override', async () => {
    await makeCustomer(t.owner.token, { fullName: 'Priya Sharma', addresses: [{ line1: 'A Street', postalCode: '560034' }] });
    const warn = await as(t.owner.token).post('/api/app/customers', { fullName: 'priya sharma', addresses: [{ line1: 'B Street', postalCode: '560034' }] });
    expect(warn.status).toBe(409);
    expect(warn.body.error.details.canForce).toBe(true);
    const forced = await as(t.owner.token).post('/api/app/customers', { fullName: 'priya sharma', addresses: [{ line1: 'B Street', postalCode: '560034' }], force: true });
    expect(forced.status).toBe(201);
  });

  it('imports customers from CSV, skipping duplicates and reporting invalid rows', async () => {
    const csv = 'full_name,email,phone,city\nImported One,imp1@example.com,9000000001,Pune\nImported Two,imp2@example.com,9000000002,Pune\n,bad@example.com,9000000003,Pune\nImported One Again,imp1@example.com,,Pune\n';
    const r = await as(t.owner.token).post('/api/app/customers/import', { csv });
    expect(r.status).toBe(200);
    expect(r.body.data.created).toBe(2);
    expect(r.body.data.skipped).toBe(1);
    expect(r.body.data.errors).toHaveLength(1);
    const exp = await as(t.owner.token).get('/api/app/customers/export');
    expect(exp.headers['content-type']).toContain('text/csv');
    expect(exp.text).toContain('imp1@example.com');
  });

  it('protects against CSV formula injection in exports', async () => {
    await makeCustomer(t.owner.token, { fullName: '=HYPERLINK("http://evil")' });
    const exp = await as(t.owner.token).get('/api/app/customers/export');
    expect(exp.text).not.toMatch(/(^|,)=HYPERLINK/m);
  });

  it('archives customers only without open jobs; hard delete only without history', async () => {
    const c = await makeCustomer(t.owner.token);
    const wo = await as(t.owner.token).post('/api/app/work-orders', { customerId: c.id, title: 'Open job' });
    expect((await as(t.owner.token).post(`/api/app/customers/${c.id}/archive`)).status).toBe(409);
    expect((await as(t.owner.token).delete(`/api/app/customers/${c.id}`)).status).toBe(409);
    await as(t.owner.token).post(`/api/app/work-orders/${wo.body.data.id}/status`, { status: 'cancelled', reason: 'test' });
    expect((await as(t.owner.token).post(`/api/app/customers/${c.id}/archive`)).status).toBe(200);
    const fresh = await makeCustomer(t.owner.token);
    expect((await as(t.owner.token).delete(`/api/app/customers/${fresh.id}`)).status).toBe(200);
  });

  it('registers assets with warranty validation, history and replacement', async () => {
    const c = await makeCustomer(t.owner.token);
    const bad = await as(t.owner.token).post('/api/app/assets', { customerId: c.id, name: 'AC', warrantyStart: '2026-05-01', warrantyExpiry: '2026-01-01' });
    expect(bad.status).toBe(400);
    const a = await as(t.owner.token).post('/api/app/assets', { customerId: c.id, name: 'Bedroom AC', manufacturer: 'Daikin', serialNumber: 'SN-1', warrantyStart: '2026-01-01', warrantyExpiry: '2031-01-01' });
    expect(a.status).toBe(201);
    const dup = await as(t.owner.token).post('/api/app/assets', { customerId: c.id, name: 'Other', manufacturer: 'Daikin', serialNumber: 'SN-1' });
    expect(dup.status).toBe(409);
    const qr = await as(t.owner.token).get(`/api/app/assets/${a.body.data.id}/qr.png`);
    expect(qr.headers['content-type']).toBe('image/png');
    const rep = await as(t.owner.token).post(`/api/app/assets/${a.body.data.id}/replace`, { name: 'New AC', manufacturer: 'LG', reason: 'Compressor failed beyond repair' });
    expect(rep.status).toBe(201);
    const old = await as(t.owner.token).get(`/api/app/assets/${a.body.data.id}`);
    expect(old.body.data.status).toBe('replaced');
    expect(old.body.data.replaced_by_asset_id).toBe(rep.body.data.id);
  });
});

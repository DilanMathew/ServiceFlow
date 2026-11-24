import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, staff, as, makeCustomer, iso, type TenantCtx } from './helpers.js';
import { withSystem } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { assignRole } from '../src/modules/tenants/provision.js';
import { api, login, PASSWORD } from './helpers.js';

describe('role-based access control', () => {
  let t: TenantCtx; let tech: any; let tech2: any; let accountant: any; let dispatcher: any; let cust: any; let job: any; let otherJob: any;
  beforeAll(async () => {
    t = await registerTenant();
    tech = await staff(t, 'technician', { technician: true });
    tech2 = await staff(t, 'technician', { technician: true });
    accountant = await staff(t, 'accountant');
    dispatcher = await staff(t, 'dispatcher');
    cust = await makeCustomer(t.owner.token);
    job = (await as(dispatcher.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Tech job', scheduledStart: iso(24), technicianId: tech.technicianId, force: true })).body.data;
    otherJob = (await as(dispatcher.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Other tech job', scheduledStart: iso(30), technicianId: tech2.technicianId, force: true })).body.data;
  });

  it('technicians see only their own jobs and no financial or admin modules', async () => {
    const list = await as(tech.token).get('/api/app/work-orders');
    expect(list.status).toBe(200);
    expect(list.body.data.map((j: any) => j.id)).toEqual([job.id]);
    expect(list.body.data[0]).not.toHaveProperty('estimated_cost');
    expect((await as(tech.token).get(`/api/app/work-orders/${otherJob.id}`)).status).toBe(404);
    for (const u of ['/api/app/invoices', '/api/app/payments', '/api/app/reports/revenue', '/api/app/customers', '/api/app/dashboard', '/api/app/users', '/api/app/settings/profile'])
      expect([403, 404]).toContain((u.endsWith('profile') ? await as(tech.token).patch(u, { name: 'x' }) : await as(tech.token).get(u)).status);
  });

  it('technicians can run their own job through the field workflow but not admin transitions', async () => {
    expect((await as(tech.token).post(`/api/app/work-orders/${job.id}/accept`)).status).toBe(200);
    expect((await as(tech.token).post(`/api/app/work-orders/${job.id}/status`, { status: 'en_route' })).status).toBe(200);
    expect((await as(tech.token).post(`/api/app/work-orders/${job.id}/status`, { status: 'cancelled', reason: 'no' })).status).toBe(403);
    expect((await as(tech.token).post(`/api/app/work-orders/${otherJob.id}/status`, { status: 'en_route' })).status).toBe(404);
    expect((await as(tech.token).post(`/api/app/work-orders/${job.id}/assign`, { technicianId: tech2.technicianId })).status).toBe(403);
  });

  it('accountants manage billing but cannot assign technicians', async () => {
    expect((await as(accountant.token).get('/api/app/invoices')).status).toBe(200);
    expect((await as(accountant.token).get('/api/app/reports/revenue')).status).toBe(200);
    expect((await as(accountant.token).post(`/api/app/work-orders/${job.id}/assign`, { technicianId: tech2.technicianId })).status).toBe(403);
  });

  it('dispatchers can assign but cannot see financial reports or manage users', async () => {
    expect((await as(dispatcher.token).get('/api/app/dispatch/board')).status).toBe(200);
    expect((await as(dispatcher.token).get('/api/app/reports/revenue')).status).toBe(403);
    expect((await as(dispatcher.token).post('/api/app/users', { email: 'z@example.com', fullName: 'Zed', roleIds: [] })).status).toBe(403);
  });

  it('only owners can grant the owner role', async () => {
    const admin = await staff(t, 'admin');
    const roles = (await as(admin.token).get('/api/app/users/roles')).body.data.roles;
    const owner = roles.find((r: any) => r.key === 'owner').id;
    const r = await as(admin.token).post('/api/app/users', { email: 'own2@example.com', fullName: 'Owner Two', roleIds: [owner] });
    expect(r.status).toBe(403);
  });

  it('platform super admins cannot read tenant business data; tenants cannot reach the platform API', async () => {
    const email = `root-${Date.now()}@nexus.example`;
    await withSystem(async (db) => {
      const u = await db.one(`INSERT INTO users (tenant_id, email, password_hash, full_name, user_type) VALUES (NULL,$1,$2,'Root','platform') RETURNING id`, [email, await hashPassword(PASSWORD)]);
      await assignRole(db, u.id, null, 'super_admin');
    });
    const root = await login(email);
    expect((await as(root).get('/api/app/customers')).status).toBe(403);
    expect((await as(root).get('/api/platform/overview')).status).toBe(200);
    expect((await as(root).get(`/api/platform/tenants/${t.tenantId}`)).body.data).not.toHaveProperty('customers');
    expect((await as(t.owner.token).get('/api/platform/overview')).status).toBe(403);
    // Support session requires an explicit, time-boxed grant from the tenant
    expect((await as(root).post(`/api/platform/tenants/${t.tenantId}/support-session`)).status).toBe(409);
    expect((await as(t.owner.token).post('/api/app/settings/support-access', { reason: 'Help with invoice setup', hours: 2 })).status).toBe(201);
    const sup = await as(root).post(`/api/platform/tenants/${t.tenantId}/support-session`);
    expect(sup.status).toBe(200);
    const st = sup.body.data.accessToken;
    expect((await as(st).get('/api/app/customers')).status).toBe(200);
    expect((await as(st).post('/api/app/customers', { fullName: 'Support wrote this' })).status).toBe(403); // read-only
  });

  it('unauthenticated requests are rejected', async () => {
    expect((await api().get('/api/app/customers')).status).toBe(401);
    expect((await api().get('/api/app/customers').set('authorization', 'Bearer not-a-jwt')).status).toBe(401);
  });
});

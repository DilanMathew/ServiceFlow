import { describe, it, expect, beforeAll } from 'vitest';
import { api, auth, registerTenant, staff, as, makeCustomer, iso, type TenantCtx } from './helpers.js';
import { systemDb } from '../src/db/pool.js';

describe('offline replay support', () => {
  let t: TenantCtx; let tech: any; let cust: any; let wo: any;
  beforeAll(async () => {
    t = await registerTenant('Offline Co');
    tech = await staff(t, 'technician', { technician: true });
    cust = await makeCustomer(t.owner.token);
    wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Offline job', scheduledStart: iso(-2), technicianId: tech.technicianId, force: true })).body.data;
  });

  const withKey = (key: string) => ({ ...auth(tech.token), 'Idempotency-Key': key });

  it('applies a replayed action exactly once', async () => {
    const key = `k-${Date.now()}-note`;
    const a = await api().post(`/api/app/work-orders/${wo.id}/notes`).set(withKey(key)).send({ body: 'Checked the outdoor unit' });
    const b = await api().post(`/api/app/work-orders/${wo.id}/notes`).set(withKey(key)).send({ body: 'Checked the outdoor unit' });
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(b.headers['idempotent-replay']).toBe('true');
    expect(b.body).toEqual(a.body);
    const detail = await as(tech.token).get(`/api/app/work-orders/${wo.id}`);
    expect(detail.body.data.notes.filter((n: any) => n.body === 'Checked the outdoor unit')).toHaveLength(1);
  });

  it('rejects a key reused for a different request, and malformed keys', async () => {
    const key = `k-${Date.now()}-reuse`;
    await api().post(`/api/app/work-orders/${wo.id}/notes`).set(withKey(key)).send({ body: 'first' });
    const r = await api().post(`/api/app/work-orders/${wo.id}/accept`).set(withKey(key)).send({});
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('IDEMPOTENCY_KEY_REUSED');
    expect((await api().post(`/api/app/work-orders/${wo.id}/notes`).set(withKey('bad key!')).send({ body: 'x' })).status).toBe(400);
  });

  it('keys are scoped per tenant and user', async () => {
    const other = await registerTenant('Other Offline');
    const key = `k-${Date.now()}-scope`;
    await api().post(`/api/app/work-orders/${wo.id}/notes`).set(withKey(key)).send({ body: 'mine' });
    const c = await makeCustomer(other.owner.token);
    const r = await api().post('/api/app/work-orders').set({ ...auth(other.owner.token), 'Idempotency-Key': key }).send({ customerId: c.id, title: 'Theirs' });
    expect(r.status).toBe(201);
    expect(r.headers['idempotent-replay']).toBeUndefined();
  });

  it('records the real time of a status change made offline', async () => {
    await as(tech.token).post(`/api/app/work-orders/${wo.id}/accept`);
    // the job was assigned this morning; the technician started it 40 min ago while offline
    await systemDb.query(`UPDATE work_order_status_history SET changed_at = now() - interval '3 hours' WHERE work_order_id = $1`, [wo.id]);
    const startedAt = new Date(Date.now() - 40 * 60_000).toISOString();
    const r = await as(tech.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'in_progress', occurredAt: startedAt });
    expect(r.status).toBe(200);
    expect(Math.abs(new Date(r.body.data.actual_start).getTime() - new Date(startedAt).getTime())).toBeLessThan(2000);
  });

  it('clamps future or ancient timestamps', async () => {
    const w2 = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Clamp job', scheduledStart: iso(-30), technicianId: tech.technicianId, force: true })).body.data;
    await as(tech.token).post(`/api/app/work-orders/${w2.id}/accept`);
    const r = await as(tech.token).post(`/api/app/work-orders/${w2.id}/status`, { status: 'in_progress', occurredAt: new Date(Date.now() + 86400_000).toISOString() });
    expect(new Date(r.body.data.actual_start).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
    const w3 = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Old job', scheduledStart: iso(-60), technicianId: tech.technicianId, force: true })).body.data;
    await as(tech.token).post(`/api/app/work-orders/${w3.id}/accept`);
    const r3 = await as(tech.token).post(`/api/app/work-orders/${w3.id}/status`, { status: 'in_progress', occurredAt: '2020-01-01T00:00:00Z' });
    expect(new Date(r3.body.data.actual_start).getTime()).toBeGreaterThan(Date.now() - 73 * 3600_000);
  });
});

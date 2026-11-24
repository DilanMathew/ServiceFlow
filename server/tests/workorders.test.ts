import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, staff, as, makeCustomer, iso, type TenantCtx } from './helpers.js';

describe('service requests & work orders', () => {
  let t: TenantCtx; let tech: any; let tech2: any; let cust: any;
  beforeAll(async () => {
    t = await registerTenant();
    tech = await staff(t, 'technician', { technician: true });
    tech2 = await staff(t, 'technician', { technician: true });
    cust = await makeCustomer(t.owner.token);
  });

  it('converts an approved service request into exactly one work order', async () => {
    const r = await as(t.owner.token).post('/api/app/requests', { customerId: cust.id, description: 'AC leaking water near the wall', priority: 'high' });
    expect(r.status).toBe(201);
    expect((await as(t.owner.token).post(`/api/app/requests/${r.body.data.id}/status`, { status: 'rejected' })).status).toBe(400); // reason required
    expect((await as(t.owner.token).post(`/api/app/requests/${r.body.data.id}/status`, { status: 'approved' })).status).toBe(200);
    const c1 = await as(t.owner.token).post(`/api/app/requests/${r.body.data.id}/convert`, {});
    expect(c1.status).toBe(201);
    expect(c1.body.data.priority).toBe('high');
    const c2 = await as(t.owner.token).post(`/api/app/requests/${r.body.data.id}/convert`, {});
    expect(c2.status).toBe(422);
  });

  it('creates a customer from a lead when converting a public request', async () => {
    const r = await as(t.owner.token).post('/api/app/requests', { contactName: 'Walk In', contactPhone: '+91 91234 56780', description: 'Need AC installed', addressText: '5 MG Road', source: 'phone' });
    const c = await as(t.owner.token).post(`/api/app/requests/${r.body.data.id}/convert`, {});
    expect(c.status).toBe(201);
    expect(c.body.data.customer_id).toBeTruthy();
  });

  it('enforces valid status transitions', async () => {
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Transition test' })).body.data;
    const bad = await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'completed' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.code).toBe('INVALID_TRANSITION');
    expect((await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'paid' })).status).toBe(422);
    expect((await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'in_progress' })).status).toBe(422);
    expect((await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/status`, { status: 'approved' })).status).toBe(200);
  });

  it('runs the full field lifecycle and requires a service report before completion', async () => {
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Lifecycle', scheduledStart: iso(2), technicianId: tech.technicianId, force: true })).body.data;
    expect(wo.status).toBe('assigned');
    const tt = as(tech.token);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'en_route' })).status).toBe(200);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'in_progress' })).status).toBe(200);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'on_hold' })).status).toBe(400);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'on_hold', reason: 'Waiting for part' })).status).toBe(200);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'in_progress' })).status).toBe(200);
    expect((await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'completed' })).status).toBe(422);
    expect((await tt.put(`/api/app/work-orders/${wo.id}/report`, { findings: 'Clogged filter', workPerformed: 'Cleaned filters and coil', equipmentCondition: 'good' })).status).toBe(200);
    const png = 'data:image/png;base64,' + Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff1f0003020101d6a73c9d0000000049454e44ae426082', 'hex').toString('base64');
    expect((await tt.post(`/api/app/work-orders/${wo.id}/signature`, { signedName: 'Customer Name', signature: png, approved: true })).status).toBe(200);
    const done = await tt.post(`/api/app/work-orders/${wo.id}/status`, { status: 'completed' });
    expect(done.status).toBe(200);
    expect(done.body.data.actual_start).toBeTruthy();
    expect(done.body.data.actual_end).toBeTruthy();
    const detail = await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`);
    expect(detail.body.data.history.map((h: any) => h.to_status)).toEqual(expect.arrayContaining(['assigned', 'en_route', 'in_progress', 'on_hold', 'completed']));
    const pdf = await as(t.owner.token).get(`/api/app/work-orders/${wo.id}/report.pdf`);
    expect(pdf.headers['content-type']).toBe('application/pdf');
  });

  it('prevents double booking under concurrent assignment', async () => {
    const start = iso(48);
    const w1 = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Race A', scheduledStart: start, expectedDurationMinutes: 120 })).body.data;
    const w2 = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Race B', scheduledStart: iso(49), expectedDurationMinutes: 120 })).body.data;
    const [r1, r2] = await Promise.all([
      as(t.owner.token).post(`/api/app/work-orders/${w1.id}/assign`, { technicianId: tech2.technicianId, force: true }),
      as(t.owner.token).post(`/api/app/work-orders/${w2.id}/assign`, { technicianId: tech2.technicianId, force: true }),
    ]);
    const statuses = [r1.status, r2.status].sort();
    expect(statuses).toEqual([200, 409]);
    const loser = r1.status === 409 ? r1 : r2;
    expect(loser.body.error.code).toBe('SCHEDULE_CONFLICT');
  });

  it('allows overlaps only when the business disables the restriction', async () => {
    await as(t.owner.token).patch('/api/app/settings', { preventDoubleBooking: false });
    const s = iso(96);
    const a = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Overlap A', scheduledStart: s })).body.data;
    const b = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Overlap B', scheduledStart: s })).body.data;
    expect((await as(t.owner.token).post(`/api/app/work-orders/${a.id}/assign`, { technicianId: tech.technicianId, force: true })).status).toBe(200);
    expect((await as(t.owner.token).post(`/api/app/work-orders/${b.id}/assign`, { technicianId: tech.technicianId, force: true })).status).toBe(200);
    const board = await as(t.owner.token).get(`/api/app/dispatch/board?date=${s.slice(0, 10)}&days=2`);
    expect(board.body.data.conflicts.length).toBeGreaterThan(0);
    await as(t.owner.token).patch('/api/app/settings', { preventDoubleBooking: true });
  });

  it('returns assignment warnings and rule-based suggestions without auto-assigning', async () => {
    const cat = (await as(t.owner.token).post('/api/app/settings/service-categories', { name: `Gas Refill ${Date.now()}` })).body.data;
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Skill check', serviceCategoryId: cat.id, scheduledStart: iso(120) })).body.data;
    const warn = await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/assign`, { technicianId: tech.technicianId });
    expect(warn.status).toBe(409);
    expect(warn.body.error.code).toBe('ASSIGNMENT_WARNINGS');
    const sug = await as(t.owner.token).get(`/api/app/dispatch/suggestions/${wo.id}`);
    expect(sug.status).toBe(200);
    expect(sug.body.data.suggestions.length).toBeGreaterThanOrEqual(2);
    const after = await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`);
    expect(after.body.data.assigned_technician_id).toBeNull();
  });

  it('reschedules with history and rejects reschedule of finished jobs', async () => {
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Resched', scheduledStart: iso(150), technicianId: tech.technicianId, force: true })).body.data;
    const r = await as(t.owner.token).post(`/api/app/work-orders/${wo.id}/reschedule`, { scheduledStart: iso(170), reason: 'Customer request', force: true });
    expect(r.status).toBe(200);
    expect(r.body.data.reschedule_count).toBe(1);
  });

  it('updates inventory through controlled transactions when parts are used', async () => {
    const item = (await as(t.owner.token).post('/api/app/inventory/items', { sku: `CAP-${Date.now()}`, name: 'Capacitor', sellingPrice: 450, purchasePrice: 200, openingStock: 2 })).body.data;
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Parts', scheduledStart: iso(200), technicianId: tech.technicianId, force: true })).body.data;
    const p = await as(tech.token).post(`/api/app/work-orders/${wo.id}/parts`, { itemId: item.id, quantity: 2, unitPrice: 1 });
    expect(p.status).toBe(201);
    expect(Number(p.body.data.unit_price)).toBe(450); // technicians cannot override catalogue prices
    const over = await as(tech.token).post(`/api/app/work-orders/${wo.id}/parts`, { itemId: item.id, quantity: 1 });
    expect(over.status).toBe(422);
    const it2 = await as(t.owner.token).get(`/api/app/inventory/items/${item.id}`);
    expect(it2.body.data.onHand).toBe(0);
    await as(tech.token).delete(`/api/app/work-orders/${wo.id}/parts/${p.body.data.id}`);
    expect((await as(t.owner.token).get(`/api/app/inventory/items/${item.id}`)).body.data.onHand).toBe(2);
  });

  it('uses optimistic concurrency for edits', async () => {
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Versioned' })).body.data;
    expect((await as(t.owner.token).patch(`/api/app/work-orders/${wo.id}`, { title: 'Version two', version: wo.version })).status).toBe(200);
    expect((await as(t.owner.token).patch(`/api/app/work-orders/${wo.id}`, { title: 'Version three', version: wo.version })).status).toBe(409);
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { api, registerTenant, staff, as, makeCustomer, iso, setPlan, type TenantCtx } from './helpers.js';
import { drainJobs } from './helpers.js';
import { withTenant, systemDb } from '../src/db/pool.js';
import { generateVisits, visitSchedule } from '../src/modules/amc/routes.js';
import { TASKS } from '../src/jobs/scheduler.js';

describe('AMC contracts', () => {
  let t: TenantCtx; let cust: any;
  beforeAll(async () => { t = await registerTenant(); cust = await makeCustomer(t.owner.token); });

  it('builds monthly / quarterly / half-yearly / annual schedules', () => {
    expect(visitSchedule('2026-01-01', '2026-12-31', 'monthly')).toHaveLength(12);
    expect(visitSchedule('2026-01-01', '2026-12-31', 'quarterly')).toEqual(['2026-01-01', '2026-04-01', '2026-07-01', '2026-10-01']);
    expect(visitSchedule('2026-01-01', '2026-12-31', 'half_yearly')).toHaveLength(2);
    expect(visitSchedule('2026-01-01', '2026-12-31', 'annual')).toHaveLength(1);
  });

  it('activation generates visits once; regeneration never duplicates', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const end = new Date(Date.now() + 364 * 864e5).toISOString().slice(0, 10);
    const m = (await as(t.owner.token).post('/api/app/amc', { customerId: cust.id, title: 'AMC', startDate: today, endDate: end, frequency: 'quarterly', contractValue: 6000 })).body.data;
    const act = await as(t.owner.token).post(`/api/app/amc/${m.id}/activate`, { createInvoice: true });
    expect(act.status).toBe(200);
    expect(act.body.data.visitsGenerated).toBe(4);
    expect(await withTenant(t.tenantId, (db) => generateVisits(db, m.id))).toBe(0);
    expect((await as(t.owner.token).post(`/api/app/amc/${m.id}/activate`, {})).status).toBe(422);
    // scheduler creates work orders for due visits exactly once
    const task = TASKS.find((x) => x.name === 'amc_visits')!;
    await task.run(); await task.run();
    const wos = await systemDb.one(`SELECT count(*)::int n FROM work_orders WHERE tenant_id = $1 AND amc_visit_id IS NOT NULL`, [t.tenantId]);
    expect(wos.n).toBe(1);
    const renew = await as(t.owner.token).post(`/api/app/amc/${m.id}/renew`, {});
    expect(renew.status).toBe(201);
    expect(renew.body.data.quotationId).toBeTruthy();
    expect((await as(t.owner.token).post(`/api/app/amc/${m.id}/renew`, {})).status).toBe(422);
  });
});

describe('notifications', () => {
  let t: TenantCtx; let cust: any;
  beforeAll(async () => { t = await registerTenant(); cust = await makeCustomer(t.owner.token, { email: 'notify@example.com' }); });

  it('never blocks business transactions when a provider fails, and retries with backoff', async () => {
    // WhatsApp configured in live mode with an unreachable/invalid account: sends must fail
    await as(t.owner.token).put('/api/app/integrations/whatsapp', { provider: 'meta_cloud', mode: 'live', config: { phoneNumberId: 'invalid' }, secrets: { accessToken: 'invalid', appSecret: 'x' } });
    const r = await as(t.owner.token).post('/api/app/requests', { customerId: cust.id, description: 'Notification failure test' });
    expect(r.status).toBe(201); // business change committed regardless of providers
    await drainJobs();
    const logs = await systemDb.many(`SELECT channel, status, attempts FROM notification_logs WHERE tenant_id = $1 AND entity_id = $2`, [t.tenantId, r.body.data.id]);
    expect(logs.find((l) => l.channel === 'email')?.status).toBe('sent');
    const wa = logs.find((l) => l.channel === 'whatsapp');
    expect(wa?.status).toBe('failed');
    const job = await systemDb.one(`SELECT status, attempts, run_at > now() AS backoff FROM background_jobs WHERE tenant_id = $1 AND job_type = 'deliver_notification' AND status <> 'succeeded' ORDER BY id DESC LIMIT 1`, [t.tenantId]);
    expect(job.status).toBe('pending');
    expect(job.backoff).toBe(true);
  });

  it('respects customer opt-outs and template overrides', async () => {
    const c = await makeCustomer(t.owner.token, { email: 'optout@example.com', notificationOptOut: { email: true } });
    await as(t.owner.token).post('/api/app/requests', { customerId: c.id, description: 'Opt-out test request' });
    const logs = await systemDb.many(`SELECT channel FROM notification_logs WHERE customer_id = $1`, [c.id]);
    expect(logs.find((l) => l.channel === 'email')).toBeUndefined();
    const tpl = await as(t.owner.token).put('/api/app/notifications/templates', { event: 'request.created', channel: 'email', subject: 'Got it {{request.number}}', body: 'Hello {{customer.name}} from {{business.name}}' });
    expect(tpl.status).toBe(200);
    await as(t.owner.token).post('/api/app/requests', { customerId: cust.id, description: 'Template override test' });
    const last = await systemDb.one(`SELECT subject, body FROM notification_logs WHERE customer_id = $1 AND channel = 'email' ORDER BY created_at DESC LIMIT 1`, [cust.id]);
    expect(last.subject).toMatch(/^Got it SR-/);
    expect(last.body).toContain('Hello');
  });
});

describe('documents', () => {
  let t: TenantCtx; let tech: any; let tech2: any; let wo: any; let wo2: any;
  const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da6364f8ff1f0003020101d6a73c9d0000000049454e44ae426082', 'hex');
  beforeAll(async () => {
    t = await registerTenant();
    tech = await staff(t, 'technician', { technician: true });
    tech2 = await staff(t, 'technician', { technician: true });
    const c = await makeCustomer(t.owner.token);
    wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: c.id, title: 'Docs', scheduledStart: iso(5), technicianId: tech.technicianId, force: true })).body.data;
    wo2 = (await as(t.owner.token).post('/api/app/work-orders', { customerId: c.id, title: 'Docs 2', scheduledStart: iso(9), technicianId: tech2.technicianId, force: true })).body.data;
  });

  it('validates file content (not the declared type) and enforces job ownership', async () => {
    const ok = await api().post('/api/app/documents').set('authorization', `Bearer ${tech.token}`).field('entityType', 'work_order').field('entityId', wo.id).field('category', 'photo_before')
      .attach('files', png, { filename: 'before.png', contentType: 'image/png' });
    expect(ok.status).toBe(201);
    const disguised = await api().post('/api/app/documents').set('authorization', `Bearer ${tech.token}`).field('entityType', 'work_order').field('entityId', wo.id)
      .attach('files', Buffer.from('MZ\x90\x00 fake exe'), { filename: 'photo.png', contentType: 'image/png' });
    expect(disguised.status).toBe(400);
    const notMine = await api().post('/api/app/documents').set('authorization', `Bearer ${tech.token}`).field('entityType', 'work_order').field('entityId', wo2.id)
      .attach('files', png, { filename: 'x.png', contentType: 'image/png' });
    expect(notMine.status).toBe(403);
    const docId = ok.body.data[0].id;
    expect((await as(tech2.token).get(`/api/app/documents/${docId}/download`)).status).toBe(403);
    const dl = await as(tech.token).get(`/api/app/documents/${docId}/download`);
    expect(dl.status).toBe(200);
    expect(dl.headers['x-content-type-options']).toBe('nosniff');
  });

  it('serves previews only through short-lived signed links', async () => {
    const up = await api().post('/api/app/documents').set('authorization', `Bearer ${t.owner.token}`).field('entityType', 'work_order').field('entityId', wo.id)
      .attach('files', png, { filename: 'p.png', contentType: 'image/png' });
    const link = await as(t.owner.token).post(`/api/app/documents/${up.body.data[0].id}/link`);
    expect((await api().get(link.body.data.url)).status).toBe(200);
    const tampered = link.body.data.url.slice(0, -2) + (link.body.data.url.endsWith('aa') ? 'bb' : 'aa');
    expect((await api().get(tampered)).status).toBe(404);
    const row = await systemDb.one(`SELECT storage_key FROM documents WHERE id = $1`, [up.body.data[0].id]);
    expect(row.storage_key).not.toContain('p.png'); // keys are random, not derived from names
  });
});

describe('subscriptions & entitlements', () => {
  it('enforces technician limits, feature gating and read-only access after trial expiry', async () => {
    const t = await registerTenant('Starter Co', 'starter');
    const mk = (n: number) => as(t.owner.token).post('/api/app/technicians', { email: `tech${n}-${Date.now()}@example.com`, fullName: `Tech ${n}` });
    expect((await mk(1)).status).toBe(201);
    expect((await mk(2)).status).toBe(201);
    const third = await mk(3);
    expect(third.status).toBe(403);
    expect(third.body.error.code).toBe('PLAN_LIMIT');
    const inv = await as(t.owner.token).get('/api/app/inventory/items');
    expect(inv.status).toBe(403);
    expect(inv.body.error.code).toBe('FEATURE_NOT_IN_PLAN');
    const up = await as(t.owner.token).post('/api/app/subscription/change-plan', { planCode: 'growth' });
    expect(up.status).toBe(200);
    expect((await as(t.owner.token).get('/api/app/quotations')).status).toBe(200);
    await systemDb.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`, [t.tenantId]);
    await setPlan(t.tenantId, 'growth', 'trialing');
    await systemDb.query(`UPDATE subscriptions SET trial_ends_at = now() - interval '1 day' WHERE tenant_id = $1`, [t.tenantId]);
    (await import('../src/modules/subscriptions/entitlements.js')).invalidateEntitlements(t.tenantId);
    expect((await as(t.owner.token).get('/api/app/customers')).status).toBe(200); // read still allowed
    const write = await as(t.owner.token).post('/api/app/customers', { fullName: 'After expiry' });
    expect(write.status).toBe(402);
    // paying (sandbox billing) reactivates
    const co = await as(t.owner.token).post('/api/app/subscription/checkout', {});
    expect(co.status).toBe(200);
    expect((await api().post(`/api/public/pay/test/billing/${co.body.data.invoice.id}`).send({ outcome: 'success' })).status).toBe(200);
    expect((await as(t.owner.token).post('/api/app/customers', { fullName: 'After payment' })).status).toBe(201);
  });

  it('blocks downgrades that exceed the target plan limits', async () => {
    const t = await registerTenant('Big Co', 'business');
    for (let i = 0; i < 3; i++) await as(t.owner.token).post('/api/app/technicians', { email: `dt${i}-${Date.now()}@example.com`, fullName: `T ${i}` });
    const r = await as(t.owner.token).post('/api/app/subscription/change-plan', { planCode: 'starter' });
    expect(r.status).toBe(422);
    expect(r.body.error.code).toBe('PLAN_LIMIT');
  });
});

import { describe, it, expect, beforeAll } from 'vitest';
import { registerTenant, staff, as, makeCustomer, iso, drainJobs, type TenantCtx } from './helpers.js';
import { pushTestSink } from '../src/integrations/push.js';
import { systemDb } from '../src/db/pool.js';

const sub = (id: string) => ({ endpoint: `https://push.test/${id}`, keys: { p256dh: 'B'.repeat(87), auth: 'a'.repeat(22) } });

describe('web push notifications', () => {
  let t: TenantCtx; let other: TenantCtx; let tech: any; let cust: any;
  beforeAll(async () => {
    t = await registerTenant('Push Co');
    other = await registerTenant('Other Co');
    tech = await staff(t, 'technician', { technician: true });
    cust = await makeCustomer(t.owner.token);
  });

  it('rejects non-https and private-network endpoints', async () => {
    for (const endpoint of ['http://push.test/x', 'https://127.0.0.1/x', 'https://10.0.0.5/x', 'https://localhost/x']) {
      const r = await as(tech.token).post('/api/app/notifications/push/subscribe', { ...sub('x'), endpoint });
      expect(r.status).toBe(400);
    }
  });

  it('pushes a job assignment to the technician’s device', async () => {
    expect((await as(tech.token).post('/api/app/notifications/push/subscribe', sub(`tech-${tech.id}`))).status).toBe(201);
    const list = await as(tech.token).get('/api/app/notifications/push');
    expect(list.body.data.devices).toHaveLength(1);
    expect(list.body.data.publicKey).toBeTruthy();

    pushTestSink.length = 0;
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: cust.id, title: 'Push me', scheduledStart: iso(30), technicianId: tech.technicianId, force: true })).body.data;
    expect(wo.status).toBe('assigned');
    await drainJobs();
    const sent = pushTestSink.filter((p) => p.endpoint === `https://push.test/tech-${tech.id}`);
    expect(sent).toHaveLength(1);
    expect(sent[0].payload.title).toContain(wo.number);
    expect(sent[0].payload.link).toBe(`/tech/jobs/${wo.id}`);
    // payload never carries customer contact details
    expect(JSON.stringify(sent[0].payload)).not.toContain(cust.phone ?? '@@');
  });

  it('prunes endpoints the push service reports as gone', async () => {
    await as(tech.token).post('/api/app/notifications/push/subscribe', sub('gone'));
    await as(tech.token).post('/api/app/notifications/push/test');
    await drainJobs();
    const rows = await systemDb.many(`SELECT endpoint FROM push_subscriptions WHERE user_id = $1`, [tech.id]);
    expect(rows.map((r) => r.endpoint)).not.toContain('https://push.test/gone');
  });

  it('moves an endpoint between accounts and keeps tenants isolated', async () => {
    const shared = sub('shared-browser');
    await as(tech.token).post('/api/app/notifications/push/subscribe', shared);
    expect((await as(other.owner.token).post('/api/app/notifications/push/subscribe', shared)).status).toBe(201);
    const mine = await as(tech.token).get('/api/app/notifications/push');
    const theirs = await as(other.owner.token).get('/api/app/notifications/push');
    expect(theirs.body.data.devices).toHaveLength(1);
    expect(mine.body.data.devices.length).toBeGreaterThanOrEqual(1);
    const owners = await systemDb.many(`SELECT tenant_id FROM push_subscriptions WHERE endpoint = $1`, [shared.endpoint]);
    expect(owners).toEqual([{ tenant_id: other.tenantId }]);
  });

  it('unsubscribes', async () => {
    await as(tech.token).post('/api/app/notifications/push/unsubscribe', { endpoint: `https://push.test/tech-${tech.id}` });
    const rows = await systemDb.many(`SELECT 1 FROM push_subscriptions WHERE endpoint = $1`, [`https://push.test/tech-${tech.id}`]);
    expect(rows).toHaveLength(0);
  });
});

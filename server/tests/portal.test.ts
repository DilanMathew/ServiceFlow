import { describe, it, expect, beforeAll } from 'vitest';
import { api, registerTenant, as, makeCustomer, login, PASSWORD, type TenantCtx } from './helpers.js';
import { drainJobs } from './helpers.js';
import { systemDb } from '../src/db/pool.js';
import { outbox } from '../src/integrations/email.js';

describe('customer portal', () => {
  let t: TenantCtx; let mine: any; let other: any; let myInvoice: any; let otherInvoice: any; let token: string;
  beforeAll(async () => {
    t = await registerTenant();
    mine = await makeCustomer(t.owner.token, { email: 'portal-me@example.com' });
    other = await makeCustomer(t.owner.token, { email: 'portal-other@example.com' });
    const line = [{ itemType: 'charge', description: 'Service', quantity: 1, unitPrice: 500 }];
    myInvoice = (await as(t.owner.token).post('/api/app/invoices', { customerId: mine.id, items: line, issue: true })).body.data;
    otherInvoice = (await as(t.owner.token).post('/api/app/invoices', { customerId: other.id, items: line, issue: true })).body.data;
    const reg = await api().post('/api/auth/portal/register').send({ workspace: t.slug, fullName: 'Portal Me', email: 'portal-me@example.com', password: PASSWORD });
    expect(reg.status).toBe(201);
    await expect(login('portal-me@example.com', PASSWORD, t.slug, true)).rejects.toThrow(); // must verify first
    await drainJobs();
    const vt = [...outbox].reverse().filter((e) => e.to === 'portal-me@example.com').map((e) => e.text.match(/verify-email\?token=([\w-]+)/)).find(Boolean)![1];
    await api().post('/api/auth/verify-email').send({ token: vt });
    token = await login('portal-me@example.com', PASSWORD, t.slug, true);
  });

  it('links the verified account to the matching customer record', async () => {
    const me = await as(token).get('/api/portal/me');
    expect(me.status).toBe(200);
    expect(me.body.data.customer.id).toBe(mine.id);
  });

  it('customers only see their own records', async () => {
    const list = await as(token).get('/api/portal/invoices');
    expect(list.body.data.map((i: any) => i.id)).toEqual([myInvoice.id]);
    expect((await as(token).get(`/api/portal/invoices/${otherInvoice.id}`)).status).toBe(404);
    expect((await as(token).get(`/api/portal/invoices/${otherInvoice.id}/pdf`)).status).toBe(404);
    expect((await as(token).post(`/api/portal/invoices/${otherInvoice.id}/pay`)).status).toBe(404);
  });

  it('customers cannot use staff APIs', async () => {
    expect((await as(token).get('/api/app/customers')).status).toBe(403);
    expect((await as(token).get('/api/app/invoices')).status).toBe(403);
  });

  it('raises service requests and change requests for human review', async () => {
    const r = await api().post('/api/portal/requests').set('authorization', `Bearer ${token}`).field('description', 'My AC is leaking water and making noise');
    expect(r.status).toBe(201);
    expect(r.body.data.source).toBe('portal');
    const wo = (await as(t.owner.token).post('/api/app/work-orders', { customerId: mine.id, title: 'Portal job' })).body.data;
    const cr = await as(token).post(`/api/portal/jobs/${wo.id}/change-request`, { type: 'cancel', reason: 'Travelling', confirmed: true });
    expect(cr.status).toBe(201);
    expect((await as(t.owner.token).get(`/api/app/work-orders/${wo.id}`)).body.data.status).toBe('new'); // not auto-cancelled
  });

  it('AI assistant answers from the customer\'s own data only and proposes actions requiring confirmation', async () => {
    const r = await as(token).post('/api/portal/assistant', { message: 'Do I have any outstanding invoice to pay?' });
    expect(r.status).toBe(200);
    expect(r.body.data.answer).toContain(myInvoice.number);
    expect(r.body.data.answer).not.toContain(otherInvoice.number);
    expect(r.body.data.requiresConfirmation).toBe(true);
    expect(r.body.data.proposedAction.id).toBe(myInvoice.id);
    const logs = await systemDb.one(`SELECT count(*)::int n FROM ai_usage_logs WHERE tenant_id = $1 AND feature = 'support_assistant'`, [t.tenantId]);
    expect(logs.n).toBeGreaterThan(0);
  });
});

describe('AI request interpretation', () => {
  it('suggests category, priority and missing information for human confirmation', async () => {
    const t = await registerTenant();
    await as(t.owner.token).post('/api/app/settings/onboarding', { step: 1, preset: 'hvac' });
    const r = await as(t.owner.token).post('/api/app/ai/interpret', { text: 'My AC is leaking water and making noise.' });
    expect(r.status).toBe(200);
    expect(r.body.data.equipmentType).toBe('Air conditioner');
    expect(r.body.data.serviceCategory).toBe('AC Repair');
    expect(r.body.data.priority).toBe('high');
    expect(r.body.data.missingInformation.length).toBeGreaterThan(0);
    expect(r.body.data.requiresConfirmation).toBe(true);
  });
});

import request from 'supertest';
import crypto from 'node:crypto';
import { createApp } from '../src/app.js';
import { systemDb, withSystem } from '../src/db/pool.js';
import { hashPassword } from '../src/lib/crypto.js';
import { assignRole } from '../src/modules/tenants/provision.js';
import { registerJobHandlers } from '../src/jobs/handlers.js';
import { invalidateEntitlements } from '../src/modules/subscriptions/entitlements.js';

registerJobHandlers();
export const app = createApp();
export const api = () => request(app);
export const PASSWORD = 'Str0ngPassw0rd!';
const uid = () => crypto.randomBytes(4).toString('hex');

export interface TenantCtx { tenantId: string; slug: string; owner: { email: string; token: string; id: string } }

/** Registers a business through the real API (owner gets a session). */
export async function registerTenant(name = 'Biz', planCode = 'business', country = 'IN'): Promise<TenantCtx> {
  const slug = `t-${uid()}`;
  const email = `owner-${uid()}@example.com`;
  const r = await api().post('/api/auth/register').send({ businessName: `${name} ${slug}`, workspace: slug, fullName: 'Owner Person', email, password: PASSWORD, country, planCode, acceptTerms: true });
  if (r.status !== 201) throw new Error(`register failed: ${r.status} ${JSON.stringify(r.body)}`);
  const me = await api().get('/api/auth/me').set('authorization', `Bearer ${r.body.data.accessToken}`);
  return { tenantId: r.body.data.tenant.id, slug, owner: { email, token: r.body.data.accessToken, id: me.body.data.user.id } };
}

/** Creates an active staff user with a role directly (skipping the invitation email) and logs in. */
export async function staff(t: TenantCtx, role: string, opts: { technician?: boolean } = {}) {
  const email = `${role}-${uid()}@example.com`;
  const hash = await hashPassword(PASSWORD);
  const user = await withSystem(async (db) => {
    const u = await db.one(`INSERT INTO users (tenant_id, email, password_hash, full_name, user_type, email_verified_at) VALUES ($1,$2,$3,$4,'staff',now()) RETURNING id`, [t.tenantId, email, hash, `${role} user`]);
    await assignRole(db, u.id, t.tenantId, role);
    if (opts.technician) {
      const tp = await db.one(`INSERT INTO technician_profiles (tenant_id, user_id) VALUES ($1,$2) RETURNING id`, [t.tenantId, u.id]);
      for (let d = 1; d <= 7; d++) await db.query(`INSERT INTO technician_availability (tenant_id, technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,'00:00','23:59')`, [t.tenantId, tp.id, d]);
      return { id: u.id, technicianId: tp.id as string };
    }
    return { id: u.id, technicianId: null as string | null };
  });
  const token = await login(email, PASSWORD, t.slug);
  return { ...user, email, token };
}

export async function login(email: string, password = PASSWORD, workspace?: string, portal = false) {
  const r = await api().post('/api/auth/login').send({ email, password, workspace, portal });
  if (r.status !== 200 || !r.body.data.accessToken) throw new Error(`login failed ${r.status} ${JSON.stringify(r.body)}`);
  return r.body.data.accessToken as string;
}

export const auth = (token: string) => ({ authorization: `Bearer ${token}` });
export const as = (token: string) => ({
  get: (u: string) => api().get(u).set(auth(token)),
  post: (u: string, body?: object) => api().post(u).set(auth(token)).send(body ?? {}),
  patch: (u: string, body?: object) => api().patch(u).set(auth(token)).send(body ?? {}),
  put: (u: string, body?: object) => api().put(u).set(auth(token)).send(body ?? {}),
  delete: (u: string) => api().delete(u).set(auth(token)),
});

export async function makeCustomer(token: string, extra: object = {}) {
  const r = await as(token).post('/api/app/customers', { fullName: `Cust ${uid()}`, phone: `+91 9${Math.floor(100000000 + Math.random() * 899999999)}`,
    addresses: [{ line1: '1 Test Street', city: 'Bengaluru', postalCode: '560001' }], ...extra });
  if (r.status !== 201) throw new Error(`customer failed ${JSON.stringify(r.body)}`);
  return r.body.data;
}

export async function setPlan(tenantId: string, code: string, status = 'trialing') {
  await systemDb.query(`UPDATE subscriptions SET plan_id = (SELECT id FROM subscription_plans WHERE code = $2), status = $3, trial_ends_at = now() + interval '10 days' WHERE tenant_id = $1`, [tenantId, code, status]);
  invalidateEntitlements(tenantId);
}

export const iso = (hoursFromNow: number) => new Date(Math.round((Date.now() + hoursFromNow * 3600_000) / 60000) * 60000).toISOString();

import { runDueJobs } from '../src/jobs/queue.js';
/** Processes every job that is currently due (failed jobs are rescheduled into the future, so this terminates). */
export async function drainJobs() { for (let i = 0; i < 50; i++) if ((await runDueJobs(100)) === 0) return; }

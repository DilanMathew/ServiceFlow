import { describe, it, expect } from 'vitest';
import { authenticator } from 'otplib';
import { api, registerTenant, staff, login, as, PASSWORD } from './helpers.js';
import { drainJobs } from './helpers.js';
import { outbox } from '../src/integrations/email.js';
import { systemDb } from '../src/db/pool.js';

const lastLink = (path: string, to?: string) => {
  const m = [...outbox].reverse().filter((e) => !to || e.to === to).map((e) => e.text.match(new RegExp(`${path}\\?token=([\\w-]+)`))).find(Boolean);
  return m?.[1];
};

describe('authentication', () => {
  it('registers a business with owner role, trial subscription and isolated settings', async () => {
    const t = await registerTenant('Auth Co', 'growth');
    const me = await as(t.owner.token).get('/api/auth/me');
    expect(me.status).toBe(200);
    expect(me.body.data.roles).toContain('owner');
    expect(me.body.data.entitlements.status).toBe('trialing');
    expect(me.body.data.settings.currency).toBe('INR');
    expect(me.body.data.user).not.toHaveProperty('password_hash');
  });

  it('rejects weak passwords and missing consent', async () => {
    const r = await api().post('/api/auth/register').send({ businessName: 'X Co', fullName: 'X', email: 'x@example.com', password: 'short', acceptTerms: true });
    expect(r.status).toBe(400);
    const r2 = await api().post('/api/auth/register').send({ businessName: 'X Co', fullName: 'Xy', email: 'x2@example.com', password: PASSWORD });
    expect(r2.status).toBe(400);
  });

  it('rejects wrong passwords and locks the account after repeated failures', async () => {
    const t = await registerTenant();
    const bad = await api().post('/api/auth/login').send({ email: t.owner.email, password: 'WrongPassword1' });
    expect(bad.status).toBe(401);
    expect(bad.body.error.message).toBe('Invalid email or password');
    for (let i = 0; i < 8; i++) await api().post('/api/auth/login').send({ email: t.owner.email, password: 'WrongPassword1' });
    const locked = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    expect(locked.status).toBe(423);
  });

  it('rotates refresh tokens and revokes the session when an old token is replayed', async () => {
    const t = await registerTenant();
    const r = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const noHeader = await api().post('/api/auth/refresh').set('cookie', cookie);
    expect(noHeader.status).toBe(401); // CSRF guard header required
    const r1 = await api().post('/api/auth/refresh').set('cookie', cookie).set('x-requested-with', 'ServiceFlow');
    expect(r1.status).toBe(200);
    const cookie2 = r1.headers['set-cookie'][0].split(';')[0];
    // The old token is replayed well after its rotation (outside the lost-response grace window): theft.
    await systemDb.query(`UPDATE sessions SET rotated_at = now() - interval '5 minutes' WHERE user_id = $1`, [t.owner.id]);
    const replay = await api().post('/api/auth/refresh').set('cookie', cookie).set('x-requested-with', 'ServiceFlow');
    expect(replay.status).toBe(401);
    const afterTheft = await api().post('/api/auth/refresh').set('cookie', cookie2).set('x-requested-with', 'ServiceFlow');
    expect(afterTheft.status).toBe(401); // whole session revoked
  });

  it('tolerates a lost refresh response (page reloaded mid-refresh) without logging the user out', async () => {
    const t = await registerTenant();
    const r = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    const r1 = await api().post('/api/auth/refresh').set('cookie', cookie).set('x-requested-with', 'ServiceFlow');
    expect(r1.status).toBe(200); // browser never stored this response's cookie
    const retry = await api().post('/api/auth/refresh').set('cookie', cookie).set('x-requested-with', 'ServiceFlow');
    expect(retry.status).toBe(200);
    const cookie3 = retry.headers['set-cookie'][0].split(';')[0];
    expect((await api().post('/api/auth/refresh').set('cookie', cookie3).set('x-requested-with', 'ServiceFlow')).status).toBe(200);
    // the grace window is not extended by repeated replays of the same old token
    await systemDb.query(`UPDATE sessions SET rotated_at = now() - interval '5 minutes' WHERE user_id = $1`, [t.owner.id]);
    expect((await api().post('/api/auth/refresh').set('cookie', cookie3).set('x-requested-with', 'ServiceFlow')).status).toBe(401);
  });

  it('logout revokes the session', async () => {
    const t = await registerTenant();
    const r = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    const cookie = r.headers['set-cookie'][0].split(';')[0];
    await api().post('/api/auth/logout').set('cookie', cookie);
    const again = await api().post('/api/auth/refresh').set('cookie', cookie).set('x-requested-with', 'ServiceFlow');
    expect(again.status).toBe(401);
  });

  it('password reset works once and signs out other sessions; unknown emails get the same response', async () => {
    const t = await registerTenant();
    const unknown = await api().post('/api/auth/forgot-password').send({ email: 'nobody@example.com' });
    const known = await api().post('/api/auth/forgot-password').send({ email: t.owner.email });
    expect(unknown.body).toEqual(known.body);
    await drainJobs();
    const token = lastLink('reset-password', t.owner.email);
    expect(token).toBeTruthy();
    const ok = await api().post('/api/auth/reset-password').send({ token, password: 'An0therStrongPass' });
    expect(ok.status).toBe(200);
    const reuse = await api().post('/api/auth/reset-password').send({ token, password: 'An0therStrongPass2' });
    expect(reuse.status).toBe(400);
    expect((await as(t.owner.token).get('/api/auth/me')).status).toBe(401);
    await login(t.owner.email, 'An0therStrongPass');
  });

  it('verifies email addresses', async () => {
    const t = await registerTenant();
    await drainJobs();
    const token = lastLink('verify-email', t.owner.email);
    expect((await api().post('/api/auth/verify-email').send({ token })).status).toBe(200);
    const u = await systemDb.one(`SELECT email_verified_at FROM users WHERE id = $1`, [t.owner.id]);
    expect(u.email_verified_at).not.toBeNull();
  });

  it('supports TOTP multi-factor authentication', async () => {
    const t = await registerTenant();
    const setup = await as(t.owner.token).post('/api/auth/mfa/setup');
    const secret = setup.body.data.secret;
    expect((await as(t.owner.token).post('/api/auth/mfa/enable', { code: '000000' })).status).toBe(400);
    expect((await as(t.owner.token).post('/api/auth/mfa/enable', { code: authenticator.generate(secret) })).status).toBe(200);
    const step1 = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    expect(step1.body.data.mfaRequired).toBe(true);
    expect(step1.body.data.accessToken).toBeUndefined();
    const bad = await api().post('/api/auth/mfa/verify').send({ mfaToken: step1.body.data.mfaToken, code: '123456' });
    expect(bad.status).toBe(401);
    const step1b = await api().post('/api/auth/login').send({ email: t.owner.email, password: PASSWORD });
    const ok = await api().post('/api/auth/mfa/verify').send({ mfaToken: step1b.body.data.mfaToken, code: authenticator.generate(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.data.accessToken).toBeTruthy();
  });

  it('invites users who set their own password; deactivation blocks access immediately', async () => {
    const t = await registerTenant();
    const roles = await as(t.owner.token).get('/api/app/users/roles');
    const dispatcherRole = roles.body.data.roles.find((r: any) => r.key === 'dispatcher').id;
    const inv = await as(t.owner.token).post('/api/app/users', { email: 'invitee@example.com', fullName: 'New Dispatcher', roleIds: [dispatcherRole] });
    expect(inv.status).toBe(201);
    await drainJobs();
    const token = lastLink('accept-invite', 'invitee@example.com');
    const acc = await api().post('/api/auth/accept-invite').send({ token, password: PASSWORD });
    expect(acc.status).toBe(200);
    const tk = acc.body.data.accessToken;
    expect((await as(tk).get('/api/app/work-orders')).status).toBe(200);
    expect((await as(t.owner.token).post(`/api/app/users/${inv.body.data.id}/deactivate`)).status).toBe(200);
    expect((await as(tk).get('/api/app/work-orders')).status).toBe(401);
    await expect(login('invitee@example.com', PASSWORD, t.slug)).rejects.toThrow();
  });

  it('asks for a workspace when the same email belongs to two businesses', async () => {
    const a = await registerTenant();
    const b = await registerTenant();
    const s1 = await staff(a, 'admin');
    const { hashPassword } = await import('../src/lib/crypto.js');
    await systemDb.query(`INSERT INTO users (tenant_id, email, password_hash, full_name, user_type) VALUES ($1,$2,$3,'Same','staff')`, [b.tenantId, s1.email, await hashPassword(PASSWORD)]);
    const r = await api().post('/api/auth/login').send({ email: s1.email, password: PASSWORD });
    expect(r.status).toBe(409);
    expect(r.body.error.code).toBe('WORKSPACE_REQUIRED');
    expect(r.body.error.details.workspaces).toHaveLength(2);
    expect(await login(s1.email, PASSWORD, a.slug)).toBeTruthy();
  });
});

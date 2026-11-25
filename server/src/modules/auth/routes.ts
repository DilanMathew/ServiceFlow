import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import QRCode from 'qrcode';
import { authenticator } from 'otplib';
import { config, isProd } from '../../config.js';
import { withSystem, systemDb, type Db } from '../../db/pool.js';
import { ah, parse } from '../../lib/http.js';
import { AppError, badRequest, conflict, unauthorized } from '../../lib/errors.js';
import { decrypt, encrypt, hashPassword, passwordPolicy, randomToken, sha256, verifyPassword } from '../../lib/crypto.js';
import { audit } from '../../lib/audit.js';
import { signAccessToken } from '../../auth/tokens.js';
import { authenticate } from '../../auth/middleware.js';
import { invalidateAuthCache } from '../../auth/context.js';
import { getEntitlements } from '../subscriptions/entitlements.js';
import { assignRole, provisionTenant, uniqueSlug } from '../tenants/provision.js';
import { enqueue } from '../../jobs/queue.js';

export const authRouter = Router();
const REFRESH_COOKIE = 'sf_rt';
/** How long a just-rotated refresh token is still accepted (lost-response race), see /refresh. */
const REFRESH_REUSE_GRACE_MS = 60_000;
const MAX_FAILED = 8;

const email = z.string().trim().toLowerCase().email().max(254);
const password = z.string().min(1).max(128);
const checkPolicy = (pw: string) => { const e = passwordPolicy(pw); if (e) throw badRequest(e, { fieldErrors: { password: [e] } }); };

function setRefreshCookie(res: Response, token: string) {
  res.cookie(REFRESH_COOKIE, token, {
    httpOnly: true, secure: isProd, sameSite: 'strict', path: '/api/auth', maxAge: config.REFRESH_TOKEN_TTL_DAYS * 86400_000,
  });
}

async function createSession(db: Db, req: Request, user: { id: string; tenant_id: string | null; user_type: string }, opts: { mfaVerified?: boolean; supportGrantId?: string; tenantId?: string } = {}) {
  const refresh = randomToken(48);
  const s = await db.one(
    `INSERT INTO sessions (user_id, tenant_id, refresh_token_hash, ip, user_agent, mfa_verified, expires_at, support_access_grant_id)
     VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' days')::interval, $8) RETURNING id`,
    [user.id, opts.tenantId ?? user.tenant_id, sha256(refresh), req.ip ?? null, req.get('user-agent')?.slice(0, 300) ?? null,
      !!opts.mfaVerified, String(opts.supportGrantId ? 1 : config.REFRESH_TOKEN_TTL_DAYS), opts.supportGrantId ?? null]);
  const accessToken = signAccessToken({ sub: user.id, sid: s.id, tid: opts.tenantId ?? user.tenant_id, typ: opts.supportGrantId ? 'support' : (user.user_type as any) });
  return { accessToken, refresh, sessionId: s.id };
}
export { createSession };

async function issueToken(db: Db, userId: string, purpose: string, ttlMinutes: number) {
  const token = randomToken(32);
  await db.query(`UPDATE auth_tokens SET used_at = now() WHERE user_id = $1 AND purpose = $2 AND used_at IS NULL`, [userId, purpose]);
  await db.query(`INSERT INTO auth_tokens (user_id, purpose, token_hash, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' minutes')::interval)`,
    [userId, purpose, sha256(token), String(ttlMinutes)]);
  return token;
}
export { issueToken };

async function consumeToken(db: Db, token: string, purpose: string) {
  const row = await db.maybeOne(
    `UPDATE auth_tokens SET used_at = now() WHERE token_hash = $1 AND purpose = $2 AND used_at IS NULL AND expires_at > now() RETURNING user_id`,
    [sha256(token), purpose]);
  if (!row) throw badRequest('This link is invalid or has expired');
  return row.user_id as string;
}

async function sendSystemEmail(db: Db, to: string, subject: string, text: string, tenantId: string | null = null) {
  await enqueue(db, 'send_system_email', { to, subject, text, tenantId }, { maxAttempts: 6 });
}

async function sendVerification(db: Db, user: { id: string; email: string; full_name: string; tenant_id: string | null }) {
  const token = await issueToken(db, user.id, 'email_verification', 60 * 48);
  await sendSystemEmail(db, user.email, 'Verify your email for NEXUS ServiceFlow',
    `Hi ${user.full_name},\n\nPlease verify your email address:\n${config.APP_URL}/verify-email?token=${token}\n\nThis link expires in 48 hours.`, user.tenant_id);
}

// ---------------------------------------------------------------- registration
const registerSchema = z.object({
  businessName: z.string().trim().min(2).max(120),
  workspace: z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/, 'Use 3-50 lowercase letters, numbers or hyphens').optional(),
  fullName: z.string().trim().min(2).max(120),
  email,
  password,
  phone: z.string().trim().max(30).optional(),
  country: z.string().length(2).toUpperCase().default('IN'),
  planCode: z.string().max(40).optional(),
  billingCycle: z.enum(['monthly', 'annual']).optional(),
  acceptTerms: z.literal(true, { error: 'You must accept the terms and privacy policy' }),
});

authRouter.post('/register', ah(async (req, res) => {
  const b = parse(registerSchema, req.body);
  checkPolicy(b.password);
  const passwordHash = await hashPassword(b.password);
  const result = await withSystem(async (db) => {
    const plan = b.planCode ? await db.maybeOne(`SELECT code FROM subscription_plans WHERE code = $1 AND is_active AND is_public`, [b.planCode]) : null;
    const slug = b.workspace ?? await uniqueSlug(db, b.businessName);
    const { tenant, branchId } = await provisionTenant(db, { businessName: b.businessName, slug, country: b.country, email: b.email, phone: b.phone,
      planCode: plan?.code ?? 'growth', billingCycle: b.billingCycle });
    const user = await db.one(
      `INSERT INTO users (tenant_id, branch_id, email, password_hash, full_name, phone, user_type) VALUES ($1,$2,$3,$4,$5,$6,'staff') RETURNING *`,
      [tenant.id, branchId, b.email, passwordHash, b.fullName, b.phone ?? null]);
    await assignRole(db, user.id, tenant.id, 'owner');
    await sendVerification(db, user);
    const s = await createSession(db, req, user);
    await audit(db, req, { action: 'tenant.registered', entityType: 'tenant', entityId: tenant.id, after: { name: tenant.name, slug } }, { tenantId: tenant.id, userId: user.id, email: user.email });
    return { s, tenant };
  });
  setRefreshCookie(res, result.s.refresh);
  res.status(201).json({ data: { accessToken: result.s.accessToken, tenant: { id: result.tenant.id, slug: result.tenant.slug } } });
}));

// ---------------------------------------------------------------- customer portal registration
const portalRegisterSchema = z.object({ workspace: z.string().trim().toLowerCase(), fullName: z.string().trim().min(2).max(120), email, password,
  phone: z.string().trim().max(30).optional() });

authRouter.post('/portal/register', ah(async (req, res) => {
  const b = parse(portalRegisterSchema, req.body);
  checkPolicy(b.password);
  const hash = await hashPassword(b.password);
  await withSystem(async (db) => {
    const tenant = await db.maybeOne(`SELECT id, status FROM tenants WHERE slug = $1`, [b.workspace]);
    if (!tenant || tenant.status !== 'active') throw badRequest('Business not found');
    const exists = await db.maybeOne(`SELECT 1 FROM users WHERE tenant_id = $1 AND email = $2`, [tenant.id, b.email]);
    if (exists) throw conflict('An account with this email already exists. Try signing in or resetting your password.');
    const user = await db.one(
      `INSERT INTO users (tenant_id, email, password_hash, full_name, phone, user_type) VALUES ($1,$2,$3,$4,$5,'customer') RETURNING *`,
      [tenant.id, b.email, hash, b.fullName, b.phone ?? null]);
    await assignRole(db, user.id, tenant.id, 'customer');
    // The portal account is linked to a customer record only AFTER email ownership is verified.
    await sendVerification(db, user);
  });
  res.status(201).json({ data: { message: 'Account created. Check your email to verify your address before signing in.' } });
}));

// ---------------------------------------------------------------- login
const loginSchema = z.object({ email, password, workspace: z.string().trim().toLowerCase().optional(), portal: z.boolean().optional() });

authRouter.post('/login', ah(async (req, res) => {
  const b = parse(loginSchema, req.body);
  const candidates = await systemDb.many(
    `SELECT u.*, t.slug, t.name AS tenant_name, t.status AS tenant_status FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1 ${b.workspace ? 'AND t.slug = $2' : ''} ${b.portal ? `AND u.user_type = 'customer'` : `AND u.user_type <> 'customer'`}`,
    b.workspace ? [b.email, b.workspace] : [b.email]);
  const matched: any[] = [];
  for (const u of candidates) {
    if (u.locked_until && new Date(u.locked_until) > new Date()) continue;
    if (await verifyPassword(b.password, u.password_hash)) matched.push(u);
    else await systemDb.query(
      `UPDATE users SET failed_login_count = failed_login_count + 1,
         locked_until = CASE WHEN failed_login_count + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END WHERE id = $1`, [u.id, MAX_FAILED]);
  }
  if (candidates.length === 0) await verifyPassword(b.password, null); // equalise timing
  if (matched.length === 0) {
    if (candidates.some((u) => u.locked_until && new Date(u.locked_until) > new Date())) throw new AppError(423, 'ACCOUNT_LOCKED', 'Too many failed attempts. Try again in 15 minutes or reset your password.');
    await audit(systemDb, req, { action: 'auth.login_failed', entityType: 'user' }, { tenantId: null, userId: null, email: b.email });
    throw unauthorized('Invalid email or password');
  }
  if (matched.length > 1) {
    return res.status(409).json({ error: { code: 'WORKSPACE_REQUIRED', message: 'This email belongs to several businesses. Choose one.',
      details: { workspaces: matched.map((u) => ({ slug: u.slug, name: u.tenant_name })) } } });
  }
  const user = matched[0];
  if (!user.is_active) throw new AppError(403, 'ACCOUNT_DISABLED', 'This account has been deactivated. Contact your administrator.');
  if (user.tenant_id && user.tenant_status !== 'active') throw new AppError(403, 'TENANT_SUSPENDED', 'This business account is suspended. Contact NEXUS support.');
  if (user.user_type === 'customer' && !user.email_verified_at) throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Please verify your email address first.');
  await systemDb.query(`UPDATE users SET failed_login_count = 0, locked_until = NULL WHERE id = $1`, [user.id]);

  if (user.mfa_enabled) {
    const mfaToken = await issueToken(systemDb, user.id, 'mfa_challenge', 5);
    return res.json({ data: { mfaRequired: true, mfaToken } });
  }
  const s = await withSystem(async (db) => {
    const s = await createSession(db, req, user);
    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await audit(db, req, { action: 'auth.login', entityType: 'user', entityId: user.id }, { tenantId: user.tenant_id, userId: user.id, email: user.email });
    return s;
  });
  setRefreshCookie(res, s.refresh);
  res.json({ data: { accessToken: s.accessToken } });
}));

authRouter.post('/mfa/verify', ah(async (req, res) => {
  const b = parse(z.object({ mfaToken: z.string().min(10), code: z.string().regex(/^\d{6}$/) }), req.body);
  const s = await withSystem(async (db) => {
    const userId = await consumeToken(db, b.mfaToken, 'mfa_challenge');
    const user = await db.one(`SELECT * FROM users WHERE id = $1`, [userId]);
    if (!user.mfa_secret_enc || !authenticator.verify({ token: b.code, secret: decrypt(user.mfa_secret_enc) })) {
      throw unauthorized('Invalid authentication code');
    }
    const s = await createSession(db, req, user, { mfaVerified: true });
    await db.query(`UPDATE users SET last_login_at = now() WHERE id = $1`, [user.id]);
    await audit(db, req, { action: 'auth.login', entityType: 'user', entityId: user.id, after: { mfa: true } }, { tenantId: user.tenant_id, userId: user.id, email: user.email });
    return s;
  });
  setRefreshCookie(res, s.refresh);
  res.json({ data: { accessToken: s.accessToken } });
}));

// ---------------------------------------------------------------- refresh (rotation + reuse detection)
authRouter.post('/refresh', ah(async (req, res) => {
  // CSRF: cookie is SameSite=Strict and the endpoint additionally requires a custom header
  if (req.get('x-requested-with') !== 'ServiceFlow') throw unauthorized();
  const token = req.cookies?.[REFRESH_COOKIE];
  if (!token) throw unauthorized('No session');
  const h = sha256(token);
  const out = await withSystem(async (db) => {
    const s = await db.maybeOne(
      `SELECT s.*, u.user_type, u.is_active, u.tenant_id AS user_tenant FROM sessions s JOIN users u ON u.id = s.user_id
        WHERE s.refresh_token_hash = $1 OR s.previous_token_hash = $1 FOR UPDATE OF s`, [h]);
    if (!s || s.revoked_at || new Date(s.expires_at) < new Date() || !s.is_active) throw unauthorized('Session expired');
    const replayed = s.previous_token_hash === h;
    // Grace window: a rotated-out token presented within seconds of its rotation means the browser never
    // received the new cookie (page reloaded or connection dropped mid-refresh). Rotate again instead of
    // logging the user out. Outside the window it is treated as theft.
    const inGrace = replayed && s.rotated_at && Date.now() - new Date(s.rotated_at).getTime() < REFRESH_REUSE_GRACE_MS;
    if (replayed && !inGrace) {
      // A rotated-out token was replayed: assume theft and kill the session (committed before we reject).
      await db.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1`, [s.id]);
      await audit(db, req, { action: 'auth.refresh_reuse_detected', entityType: 'session', entityId: s.id }, { tenantId: s.tenant_id, userId: s.user_id, email: null });
      invalidateAuthCache(s.id);
      return null;
    }
    const next = randomToken(48);
    // During a grace replay the presented (older) token stays the "previous" one, so the grace window
    // is not extended by repeated replays.
    await db.query(`UPDATE sessions SET previous_token_hash = $3, refresh_token_hash = $2, last_used_at = now(),
        rotated_at = CASE WHEN $4 THEN rotated_at ELSE now() END WHERE id = $1`,
      [s.id, sha256(next), replayed ? h : s.refresh_token_hash, replayed]);
    const accessToken = signAccessToken({ sub: s.user_id, sid: s.id, tid: s.tenant_id, typ: s.support_access_grant_id ? 'support' : s.user_type });
    return { accessToken, next };
  });
  if (!out) { res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' }); throw unauthorized('Session revoked'); }
  setRefreshCookie(res, out.next);
  res.json({ data: { accessToken: out.accessToken } });
}));

authRouter.post('/logout', ah(async (req, res) => {
  const token = req.cookies?.[REFRESH_COOKIE];
  if (token) {
    const s = await systemDb.maybeOne(`UPDATE sessions SET revoked_at = now() WHERE refresh_token_hash = $1 AND revoked_at IS NULL RETURNING id, user_id, tenant_id`, [sha256(token)]);
    if (s) { invalidateAuthCache(s.id); await audit(systemDb, req, { action: 'auth.logout', entityType: 'session', entityId: s.id }, { tenantId: s.tenant_id, userId: s.user_id, email: null }); }
  }
  res.clearCookie(REFRESH_COOKIE, { path: '/api/auth' });
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- password reset & verification
authRouter.post('/forgot-password', ah(async (req, res) => {
  const b = parse(z.object({ email, workspace: z.string().optional() }), req.body);
  await withSystem(async (db) => {
    const users = await db.many(`SELECT u.id, u.email, u.full_name, u.tenant_id FROM users u LEFT JOIN tenants t ON t.id = u.tenant_id
      WHERE u.email = $1 AND u.is_active ${b.workspace ? 'AND t.slug = $2' : ''}`, b.workspace ? [b.email, b.workspace] : [b.email]);
    for (const u of users) {
      const token = await issueToken(db, u.id, 'password_reset', 60);
      await sendSystemEmail(db, u.email, 'Reset your NEXUS ServiceFlow password',
        `Hi ${u.full_name},\n\nReset your password using this link (valid for 1 hour):\n${config.APP_URL}/reset-password?token=${token}\n\nIf you did not request this, you can ignore this email.`, u.tenant_id);
    }
  });
  // Same response whether or not the account exists (no user enumeration)
  res.json({ data: { message: 'If an account exists for this email, a reset link has been sent.' } });
}));

authRouter.post('/reset-password', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password }), req.body);
  checkPolicy(b.password);
  const hash = await hashPassword(b.password);
  await withSystem(async (db) => {
    const userId = await consumeToken(db, b.token, 'password_reset');
    const u = await db.one(`UPDATE users SET password_hash = $2, failed_login_count = 0, locked_until = NULL, email_verified_at = COALESCE(email_verified_at, now())
      WHERE id = $1 RETURNING tenant_id, email`, [userId, hash]);
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [userId]);
    invalidateAuthCache(userId);
    await audit(db, req, { action: 'auth.password_reset', entityType: 'user', entityId: userId }, { tenantId: u.tenant_id, userId, email: u.email });
  });
  res.json({ data: { message: 'Password updated. Please sign in.' } });
}));

authRouter.post('/verify-email', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10) }), req.body);
  await withSystem(async (db) => {
    const userId = await consumeToken(db, b.token, 'email_verification');
    const u = await db.one(`UPDATE users SET email_verified_at = now() WHERE id = $1 RETURNING *`, [userId]);
    if (u.user_type === 'customer') {
      // Link portal account to an existing customer with the same verified email, or create one.
      const existing = await db.maybeOne(`SELECT id FROM customers WHERE tenant_id = $1 AND email = $2 AND archived_at IS NULL AND portal_user_id IS NULL`, [u.tenant_id, u.email]);
      if (existing) await db.query(`UPDATE customers SET portal_user_id = $2 WHERE id = $1`, [existing.id, u.id]);
      else {
        const { withTenant } = await import('../../db/pool.js');
        await withTenant(u.tenant_id, async (tdb) => {
          const { nextNumber } = await import('../../lib/numbering.js');
          await tdb.query(`INSERT INTO customers (tenant_id, number, full_name, email, phone, portal_user_id, source) VALUES ($1,$2,$3,$4,$5,$6,'portal')`,
            [u.tenant_id, await nextNumber(tdb, 'customer'), u.full_name, u.email, u.phone, u.id]);
        });
      }
    }
    invalidateAuthCache(userId);
  });
  res.json({ data: { message: 'Email verified.' } });
}));

authRouter.post('/resend-verification', authenticate, ah(async (req, res) => {
  const u = await systemDb.one(`SELECT id, email, full_name, tenant_id, email_verified_at FROM users WHERE id = $1`, [req.auth!.userId]);
  if (!u.email_verified_at) await withSystem((db) => sendVerification(db, u));
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- invitations
authRouter.get('/invitation', ah(async (req, res) => {
  const token = String(req.query.token ?? '');
  const row = await systemDb.maybeOne(`SELECT u.email, u.full_name, t.name AS business FROM auth_tokens a JOIN users u ON u.id = a.user_id JOIN tenants t ON t.id = u.tenant_id
    WHERE a.token_hash = $1 AND a.purpose = 'invitation' AND a.used_at IS NULL AND a.expires_at > now()`, [sha256(token)]);
  if (!row) throw badRequest('This invitation is invalid or has expired');
  res.json({ data: row });
}));

authRouter.post('/accept-invite', ah(async (req, res) => {
  const b = parse(z.object({ token: z.string().min(10), password, fullName: z.string().trim().min(2).max(120).optional() }), req.body);
  checkPolicy(b.password);
  const hash = await hashPassword(b.password);
  const s = await withSystem(async (db) => {
    const userId = await consumeToken(db, b.token, 'invitation');
    const user = await db.one(`UPDATE users SET password_hash = $2, full_name = COALESCE($3, full_name), email_verified_at = now(), is_active = true
      WHERE id = $1 RETURNING *`, [userId, hash, b.fullName ?? null]);
    await audit(db, req, { action: 'user.invitation_accepted', entityType: 'user', entityId: userId }, { tenantId: user.tenant_id, userId, email: user.email });
    return createSession(db, req, user);
  });
  setRefreshCookie(res, s.refresh);
  res.json({ data: { accessToken: s.accessToken } });
}));

// ---------------------------------------------------------------- current user
authRouter.get('/me', authenticate, ah(async (req, res) => {
  const a = req.auth!;
  const user = await systemDb.one(`SELECT id, email, full_name, phone, user_type, branch_id, mfa_enabled, email_verified_at, locale, avatar_storage_key, created_at FROM users WHERE id = $1`, [a.userId]);
  let tenant = null, settings = null, entitlements = null;
  if (a.tenantId) {
    tenant = await systemDb.one(`SELECT id, name, slug, country, status, is_demo, logo_storage_key FROM tenants WHERE id = $1`, [a.tenantId]);
    settings = await systemDb.one(`SELECT currency, timezone, locale, date_format, tax_regime, inventory_enabled, onboarding_completed_at, onboarding_step,
      technician_can_see_prices, prevent_double_booking FROM tenant_settings WHERE tenant_id = $1`, [a.tenantId]);
    entitlements = await getEntitlements(a.tenantId);
  }
  const announcements = await systemDb.many(`SELECT id, title, body, severity FROM announcements WHERE is_active AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now()) ORDER BY starts_at DESC LIMIT 3`);
  res.json({ data: { user, tenant, settings, entitlements, roles: a.roles, permissions: [...a.permissions], technicianId: a.technicianId,
    customerId: a.customerId, support: a.support, announcements } });
}));

authRouter.patch('/profile', authenticate, ah(async (req, res) => {
  const b = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().trim().max(30).nullable().optional(),
    locale: z.string().max(10).nullable().optional() }), req.body);
  const u = await systemDb.one(`UPDATE users SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3::boolean THEN $4 ELSE phone END,
    locale = CASE WHEN $5::boolean THEN $6 ELSE locale END WHERE id = $1 RETURNING id, full_name, phone, locale`,
    [req.auth!.userId, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.locale !== undefined, b.locale ?? null]);
  invalidateAuthCache(req.auth!.userId);
  res.json({ data: u });
}));

authRouter.post('/change-password', authenticate, ah(async (req, res) => {
  const b = parse(z.object({ currentPassword: password, newPassword: password }), req.body);
  checkPolicy(b.newPassword);
  const u = await systemDb.one(`SELECT password_hash, tenant_id, email FROM users WHERE id = $1`, [req.auth!.userId]);
  if (!(await verifyPassword(b.currentPassword, u.password_hash))) throw badRequest('Current password is incorrect');
  const hash = await hashPassword(b.newPassword);
  await withSystem(async (db) => {
    await db.query(`UPDATE users SET password_hash = $2 WHERE id = $1`, [req.auth!.userId, hash]);
    // Sign out every other session
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND id <> $2 AND revoked_at IS NULL`, [req.auth!.userId, req.auth!.sessionId]);
    await audit(db, req, { action: 'auth.password_changed', entityType: 'user', entityId: req.auth!.userId }, { tenantId: u.tenant_id });
  });
  invalidateAuthCache();
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- MFA management
authRouter.post('/mfa/setup', authenticate, ah(async (req, res) => {
  const secret = authenticator.generateSecret();
  const label = req.auth!.email;
  const otpauth = authenticator.keyuri(label, 'NEXUS ServiceFlow', secret);
  await systemDb.query(`UPDATE users SET mfa_secret_enc = $2 WHERE id = $1 AND NOT mfa_enabled`, [req.auth!.userId, encrypt(secret)]);
  res.json({ data: { secret, otpauth, qr: await QRCode.toDataURL(otpauth) } });
}));

authRouter.post('/mfa/enable', authenticate, ah(async (req, res) => {
  const b = parse(z.object({ code: z.string().regex(/^\d{6}$/) }), req.body);
  const u = await systemDb.one(`SELECT mfa_secret_enc, mfa_enabled, tenant_id FROM users WHERE id = $1`, [req.auth!.userId]);
  if (u.mfa_enabled) throw conflict('MFA is already enabled');
  if (!u.mfa_secret_enc || !authenticator.verify({ token: b.code, secret: decrypt(u.mfa_secret_enc) })) throw badRequest('Invalid code');
  await withSystem(async (db) => {
    await db.query(`UPDATE users SET mfa_enabled = true WHERE id = $1`, [req.auth!.userId]);
    await audit(db, req, { action: 'auth.mfa_enabled', entityType: 'user', entityId: req.auth!.userId }, { tenantId: u.tenant_id });
  });
  invalidateAuthCache(req.auth!.userId);
  res.json({ data: { ok: true } });
}));

authRouter.post('/mfa/disable', authenticate, ah(async (req, res) => {
  const b = parse(z.object({ password, code: z.string().regex(/^\d{6}$/) }), req.body);
  const u = await systemDb.one(`SELECT password_hash, mfa_secret_enc, tenant_id FROM users WHERE id = $1`, [req.auth!.userId]);
  if (!(await verifyPassword(b.password, u.password_hash))) throw badRequest('Password is incorrect');
  if (!u.mfa_secret_enc || !authenticator.verify({ token: b.code, secret: decrypt(u.mfa_secret_enc) })) throw badRequest('Invalid code');
  await withSystem(async (db) => {
    await db.query(`UPDATE users SET mfa_enabled = false, mfa_secret_enc = NULL WHERE id = $1`, [req.auth!.userId]);
    await audit(db, req, { action: 'auth.mfa_disabled', entityType: 'user', entityId: req.auth!.userId }, { tenantId: u.tenant_id });
  });
  invalidateAuthCache(req.auth!.userId);
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- session management
authRouter.get('/sessions', authenticate, ah(async (req, res) => {
  const rows = await systemDb.many(`SELECT id, ip, user_agent, created_at, last_used_at, (id = $2) AS current FROM sessions
    WHERE user_id = $1 AND revoked_at IS NULL AND expires_at > now() ORDER BY last_used_at DESC`, [req.auth!.userId, req.auth!.sessionId]);
  res.json({ data: rows });
}));

authRouter.delete('/sessions/:id', authenticate, ah(async (req, res) => {
  await systemDb.query(`UPDATE sessions SET revoked_at = now() WHERE id = $1 AND user_id = $2`, [req.params.id, req.auth!.userId]);
  invalidateAuthCache(req.params.id);
  res.json({ data: { ok: true } });
}));

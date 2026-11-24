import { Router, type Request } from 'express';
import { z } from 'zod';
import { requireFeature, requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest, conflict, forbidden } from '../../lib/errors.js';
import { tx, mustFind } from '../common.js';
import { assertLimit } from '../subscriptions/entitlements.js';
import { invalidateAuthCache } from '../../auth/context.js';
import { issueToken } from '../auth/routes.js';
import { notify } from '../notifications/service.js';
import { config } from '../../config.js';
import { PERMISSIONS } from '../../auth/permissions.js';
import type { Db } from '../../db/pool.js';

export const usersRouter = Router();
const manage = requirePermission('users.manage');
const TENANT_ROLE_KEYS = ['owner', 'admin', 'branch_manager', 'operations_manager', 'dispatcher', 'technician', 'accountant'];

usersRouter.get('/', requirePermission('users.manage', 'technicians.read', 'support.manage'), ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(
    `SELECT u.id, u.email, u.full_name, u.phone, u.is_active, u.email_verified_at, u.mfa_enabled, u.last_login_at, u.branch_id, u.created_at,
            (u.password_hash IS NULL) AS invitation_pending, b.name AS branch_name,
            COALESCE(json_agg(json_build_object('id', r.id, 'key', r.key, 'name', r.name)) FILTER (WHERE r.id IS NOT NULL), '[]') AS roles
       FROM users u LEFT JOIN user_roles ur ON ur.user_id = u.id LEFT JOIN roles r ON r.id = ur.role_id LEFT JOIN branches b ON b.id = u.branch_id
      WHERE u.user_type = 'staff' GROUP BY u.id, b.name ORDER BY u.is_active DESC, u.full_name`));
  res.json({ data: rows });
}));

usersRouter.get('/roles', ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(
    `SELECT r.id, r.key, r.name, r.description, r.is_system, r.tenant_id, COALESCE(array_agg(rp.permission_code) FILTER (WHERE rp.permission_code IS NOT NULL), '{}') AS permissions
       FROM roles r LEFT JOIN role_permissions rp ON rp.role_id = r.id
      WHERE r.scope = 'tenant' GROUP BY r.id ORDER BY r.is_system DESC, r.name`));
  const permissions = Object.entries(PERMISSIONS).filter(([k]) => !k.startsWith('platform.') && k !== 'portal.use')
    .map(([code, description]) => ({ code, description, module: code.split('.')[0] }));
  res.json({ data: { roles: rows, permissions } });
}));

async function resolveRoles(db: Db, ids: string[]) {
  const roles = await db.many(`SELECT id, key, tenant_id FROM roles WHERE id = ANY($1) AND scope = 'tenant'`, [ids]);
  if (roles.length !== ids.length) throw badRequest('Unknown role');
  return roles;
}

function guardOwnerRole(req: Request, roles: { key: string }[]) {
  if (roles.some((r) => r.key === 'owner') && !req.auth!.roles.includes('owner')) throw forbidden('Only an owner can grant the owner role');
}

const inviteSchema = z.object({ email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120), phone: z.string().max(30).nullish(),
  roleIds: z.array(z.string().uuid()).min(1).max(5), branchId: z.string().uuid().nullish() });

export async function inviteStaff(req: Request, db: Db, b: z.infer<typeof inviteSchema>) {
  await assertLimit(db, 'users');
  const roles = await resolveRoles(db, b.roleIds);
  guardOwnerRole(req, roles);
  const user = await db.one(`INSERT INTO users (tenant_id, branch_id, email, full_name, phone, user_type) VALUES ($1,$2,$3,$4,$5,'staff') RETURNING *`,
    [db.tenantId, b.branchId ?? null, b.email, b.fullName, b.phone ?? null]);
  for (const r of roles) await db.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1,$2,$3)`, [user.id, r.id, db.tenantId]);
  const token = await issueToken(db, user.id, 'invitation', 60 * 24 * 7);
  await notify(db, { event: 'user.invited', recipient: { email: user.email, name: user.full_name }, channels: ['email'],
    vars: { user: { name: user.full_name }, links: { invite: `${config.APP_URL}/accept-invite?token=${token}` } } });
  await audit(db, req, { action: 'user.invited', entityType: 'user', entityId: user.id, after: { email: user.email, roles: roles.map((r) => r.key) } });
  return user;
}

usersRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(inviteSchema, req.body);
  const user = await tx(req, (db) => inviteStaff(req, db, b));
  res.status(201).json({ data: { id: user.id, email: user.email } });
}));

usersRouter.post('/:id/resend-invite', manage, ah(async (req, res) => {
  await tx(req, async (db) => {
    const u = await mustFind(db, 'users', req.params.id, 'User');
    if (u.password_hash) throw conflict('This user has already accepted the invitation');
    const token = await issueToken(db, u.id, 'invitation', 60 * 24 * 7);
    await notify(db, { event: 'user.invited', recipient: { email: u.email, name: u.full_name }, channels: ['email'],
      vars: { user: { name: u.full_name }, links: { invite: `${config.APP_URL}/accept-invite?token=${token}` } } });
  });
  res.json({ data: { ok: true } });
}));

usersRouter.patch('/:id', manage, ah(async (req, res) => {
  const b = parse(z.object({ fullName: z.string().trim().min(2).max(120).optional(), phone: z.string().max(30).nullish(),
    roleIds: z.array(z.string().uuid()).min(1).max(5).optional(), branchId: z.string().uuid().nullish() }), req.body);
  await tx(req, async (db) => {
    const u = await mustFind(db, 'users', req.params.id, 'User');
    if (u.user_type !== 'staff') throw badRequest('Not a staff user');
    await db.query(`UPDATE users SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3 THEN $4 ELSE phone END, branch_id = CASE WHEN $5 THEN $6::uuid ELSE branch_id END WHERE id = $1`,
      [u.id, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.branchId !== undefined, b.branchId ?? null]);
    if (b.roleIds) {
      const roles = await resolveRoles(db, b.roleIds);
      guardOwnerRole(req, roles);
      const prev = await db.many(`SELECT r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1`, [u.id]);
      if (prev.some((r) => r.key === 'owner') && !roles.some((r) => r.key === 'owner')) {
        const owners = await db.one(`SELECT count(*)::int n FROM user_roles ur JOIN roles r ON r.id = ur.role_id JOIN users x ON x.id = ur.user_id WHERE r.key='owner' AND x.is_active`);
        if (owners.n <= 1) throw conflict('A business must keep at least one active owner');
      }
      await db.query(`DELETE FROM user_roles WHERE user_id = $1`, [u.id]);
      for (const r of roles) await db.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1,$2,$3)`, [u.id, r.id, db.tenantId]);
      await audit(db, req, { action: 'user.roles_changed', entityType: 'user', entityId: u.id, before: { roles: prev.map((r) => r.key) }, after: { roles: roles.map((r) => r.key) } });
    }
  });
  invalidateAuthCache(req.params.id);
  res.json({ data: { ok: true } });
}));

usersRouter.post('/:id/deactivate', manage, ah(async (req, res) => {
  if (req.params.id === req.auth!.userId) throw badRequest('You cannot deactivate your own account');
  await tx(req, async (db) => {
    const u = await mustFind(db, 'users', req.params.id, 'User');
    const isOwner = await db.maybeOne(`SELECT 1 FROM user_roles ur JOIN roles r ON r.id = ur.role_id WHERE ur.user_id = $1 AND r.key = 'owner'`, [u.id]);
    if (isOwner && !req.auth!.roles.includes('owner')) throw forbidden('Only an owner can deactivate another owner');
    await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [u.id]);
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [u.id]);
    await audit(db, req, { action: 'user.deactivated', entityType: 'user', entityId: u.id, before: { is_active: true }, after: { is_active: false } });
  });
  invalidateAuthCache(req.params.id);
  res.json({ data: { ok: true } });
}));

usersRouter.post('/:id/activate', manage, ah(async (req, res) => {
  await tx(req, async (db) => {
    const u = await mustFind(db, 'users', req.params.id, 'User');
    if (u.is_active) return;
    await assertLimit(db, 'users');
    await db.query(`UPDATE users SET is_active = true, failed_login_count = 0, locked_until = NULL WHERE id = $1`, [u.id]);
    await audit(db, req, { action: 'user.activated', entityType: 'user', entityId: u.id, before: { is_active: false }, after: { is_active: true } });
  });
  invalidateAuthCache(req.params.id);
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- custom roles (Business plan+)
const roleSchema = z.object({ name: z.string().trim().min(2).max(60), description: z.string().max(300).nullish(),
  permissions: z.array(z.string()).max(100) });

usersRouter.post('/roles', manage, requireFeature('advanced_permissions'), ah(async (req, res) => {
  const b = parse(roleSchema, req.body);
  const valid = new Set(Object.keys(PERMISSIONS).filter((p) => !p.startsWith('platform.') && p !== 'portal.use'));
  if (b.permissions.some((p) => !valid.has(p))) throw badRequest('Unknown permission');
  const role = await tx(req, async (db) => {
    const key = `custom_${b.name.toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 40)}`;
    if (TENANT_ROLE_KEYS.includes(key)) throw conflict('Role name is reserved');
    const r = await db.one(`INSERT INTO roles (tenant_id, key, name, description, scope) VALUES ($1,$2,$3,$4,'tenant') RETURNING *`, [db.tenantId, key, b.name, b.description ?? null]);
    for (const p of b.permissions) await db.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)`, [r.id, p]);
    await audit(db, req, { action: 'role.created', entityType: 'role', entityId: r.id, after: { ...b } });
    return r;
  });
  res.status(201).json({ data: role });
}));

usersRouter.put('/roles/:id', manage, requireFeature('advanced_permissions'), ah(async (req, res) => {
  const b = parse(roleSchema, req.body);
  await tx(req, async (db) => {
    const r = await db.maybeOne(`SELECT * FROM roles WHERE id = $1 AND tenant_id = $2`, [req.params.id, db.tenantId]);
    if (!r) throw forbidden('System roles cannot be modified');
    const before = await db.many(`SELECT permission_code FROM role_permissions WHERE role_id = $1`, [r.id]);
    await db.query(`UPDATE roles SET name = $2, description = $3 WHERE id = $1`, [r.id, b.name, b.description ?? null]);
    await db.query(`DELETE FROM role_permissions WHERE role_id = $1`, [r.id]);
    for (const p of b.permissions) await db.query(`INSERT INTO role_permissions (role_id, permission_code) VALUES ($1,$2)`, [r.id, p]);
    await audit(db, req, { action: 'role.updated', entityType: 'role', entityId: r.id, before: { permissions: before.map((x) => x.permission_code) }, after: { permissions: b.permissions } });
  });
  invalidateAuthCache();
  res.json({ data: { ok: true } });
}));

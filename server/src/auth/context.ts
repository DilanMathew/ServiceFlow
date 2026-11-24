import { systemDb } from '../db/pool.js';

export interface AuthContext {
  userId: string;
  sessionId: string;
  tenantId: string | null;
  email: string;
  fullName: string;
  userType: 'platform' | 'staff' | 'customer';
  roles: string[];
  permissions: Set<string>;
  branchId: string | null;
  technicianId: string | null;
  customerId: string | null;
  emailVerified: boolean;
  mfaEnabled: boolean;
  support: { grantId: string; expiresAt: string } | null; // platform staff in a tenant via support grant
}

declare global {
  namespace Express {
    interface Request { auth?: AuthContext; id?: string; rawBody?: Buffer }
  }
}

type Cached = { at: number; ctx: AuthContext | null };
const cache = new Map<string, Cached>();
const TTL = 15_000;
export const invalidateAuthCache = (sessionOrUserId?: string) => {
  if (!sessionOrUserId) return cache.clear();
  for (const [k, v] of cache) if (k === sessionOrUserId || v.ctx?.userId === sessionOrUserId) cache.delete(k);
};

const READ_ONLY_SUPPORT = /\.(read|view|read_own|operational|financial)$/;

/** Loads the current, authoritative session state (revocation, deactivation, roles) with a short cache. */
export async function loadContext(sessionId: string, userId: string, typ: string): Promise<AuthContext | null> {
  const key = sessionId;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL) return hit.ctx;

  const row = await systemDb.maybeOne(
    `SELECT s.id AS session_id, s.tenant_id AS session_tenant, s.support_access_grant_id, u.id, u.tenant_id, u.email, u.full_name,
            u.user_type, u.branch_id, u.is_active, u.email_verified_at, u.mfa_enabled, t.status AS tenant_status,
            g.expires_at AS grant_expires, g.revoked_at AS grant_revoked
       FROM sessions s JOIN users u ON u.id = s.user_id
       LEFT JOIN tenants t ON t.id = s.tenant_id
       LEFT JOIN support_access_grants g ON g.id = s.support_access_grant_id
      WHERE s.id = $1 AND s.user_id = $2 AND s.revoked_at IS NULL AND s.expires_at > now()`, [sessionId, userId]);

  let ctx: AuthContext | null = null;
  if (row && row.is_active && (row.tenant_status == null || row.tenant_status === 'active')) {
    const isSupport = typ === 'support' && row.support_access_grant_id;
    if (isSupport && (row.grant_revoked || new Date(row.grant_expires) < new Date())) {
      ctx = null;
    } else {
      const perms = await systemDb.many(
        `SELECT DISTINCT rp.permission_code AS p, r.key FROM user_roles ur JOIN roles r ON r.id = ur.role_id
           LEFT JOIN role_permissions rp ON rp.role_id = r.id WHERE ur.user_id = $1`, [userId]);
      let permissions = new Set(perms.map((p) => p.p).filter(Boolean) as string[]);
      const roles = [...new Set(perms.map((p) => p.key))];
      let technicianId: string | null = null;
      let customerId: string | null = null;
      if (row.user_type === 'staff') {
        technicianId = (await systemDb.maybeOne(`SELECT id FROM technician_profiles WHERE user_id = $1`, [userId]))?.id ?? null;
      } else if (row.user_type === 'customer') {
        customerId = (await systemDb.maybeOne(`SELECT id FROM customers WHERE portal_user_id = $1 AND archived_at IS NULL`, [userId]))?.id ?? null;
      }
      if (isSupport) {
        // Read-only support view of a tenant, explicitly granted by that tenant's owner
        const { SYSTEM_ROLES } = await import('./permissions.js');
        const ownerPerms = SYSTEM_ROLES.find((r) => r.key === 'owner')!.permissions;
        permissions = new Set(ownerPerms.filter((p) => READ_ONLY_SUPPORT.test(p)).concat(['dashboard.view', 'calendar.view']));
      }
      ctx = {
        userId: row.id, sessionId: row.session_id, tenantId: isSupport ? row.session_tenant : row.tenant_id, email: row.email,
        fullName: row.full_name, userType: row.user_type, roles: isSupport ? ['support'] : roles, permissions,
        branchId: row.branch_id, technicianId, customerId, emailVerified: !!row.email_verified_at, mfaEnabled: row.mfa_enabled,
        support: isSupport ? { grantId: row.support_access_grant_id, expiresAt: row.grant_expires } : null,
      };
    }
  }
  cache.set(key, { at: Date.now(), ctx });
  return ctx;
}

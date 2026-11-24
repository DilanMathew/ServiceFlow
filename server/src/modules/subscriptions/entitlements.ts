import { systemDb, type Db } from '../../db/pool.js';
import { AppError } from '../../lib/errors.js';
import type { FeatureKey } from './plans.js';

export interface Entitlements {
  planId: string; planCode: string; planName: string; status: string; readOnly: boolean;
  features: Partial<Record<FeatureKey, boolean>>;
  limits: { users: number | null; technicians: number | null; storageMb: number | null; branches: number; aiRequestsPerMonth: number };
  trialEndsAt: string | null; currentPeriodEnd: string; graceEndsAt: string | null;
}

const cache = new Map<string, { at: number; e: Entitlements }>();
export const invalidateEntitlements = (tenantId?: string) => (tenantId ? cache.delete(tenantId) : cache.clear());

export async function getEntitlements(tenantId: string): Promise<Entitlements> {
  const hit = cache.get(tenantId);
  if (hit && Date.now() - hit.at < 30_000) return hit.e;
  const r = await systemDb.maybeOne(
    `SELECT s.*, p.code, p.name, p.features, p.max_users, p.max_technicians, p.max_storage_mb, p.max_branches, p.ai_requests_per_month
       FROM subscriptions s JOIN subscription_plans p ON p.id = s.plan_id WHERE s.tenant_id = $1`, [tenantId]);
  if (!r) throw new AppError(402, 'SUBSCRIPTION_REQUIRED', 'No subscription found for this business');
  const now = new Date();
  let status: string = r.status;
  // Derive effective status from dates so access is correct even before the scheduler runs
  if (status === 'trialing' && r.trial_ends_at && new Date(r.trial_ends_at) < now) status = 'expired';
  if (status === 'grace_period' && r.grace_period_ends_at && new Date(r.grace_period_ends_at) < now) status = 'suspended';
  const c = r.custom_limits ?? {};
  const e: Entitlements = {
    planId: r.plan_id, planCode: r.code, planName: r.name, status,
    readOnly: ['expired', 'cancelled', 'suspended'].includes(status),
    features: { ...r.features, ...(c.features ?? {}) },
    limits: {
      users: c.max_users ?? r.max_users, technicians: c.max_technicians ?? r.max_technicians,
      storageMb: c.max_storage_mb ?? r.max_storage_mb, branches: c.max_branches ?? r.max_branches,
      aiRequestsPerMonth: c.ai_requests_per_month ?? r.ai_requests_per_month,
    },
    trialEndsAt: r.trial_ends_at, currentPeriodEnd: r.current_period_end, graceEndsAt: r.grace_period_ends_at,
  };
  cache.set(tenantId, { at: Date.now(), e });
  return e;
}

/** Enforced inside the creating transaction to make limits race-safe enough (counted under the tenant's lock). */
export async function assertLimit(db: Db, kind: 'users' | 'technicians' | 'branches' | 'storage', addBytes = 0) {
  const e = await getEntitlements(db.tenantId!);
  // serialize limit checks per tenant
  await db.query(`SELECT pg_advisory_xact_lock(hashtext($1))`, [`limit:${db.tenantId}:${kind}`]);
  if (kind === 'users' && e.limits.users != null) {
    const { n } = await db.one(`SELECT count(*)::int n FROM users WHERE user_type='staff' AND is_active`);
    if (n >= e.limits.users) throw new AppError(403, 'PLAN_LIMIT', `Your ${e.planName} plan allows ${e.limits.users} active users. Upgrade to add more.`);
  }
  if (kind === 'technicians' && e.limits.technicians != null) {
    const { n } = await db.one(`SELECT count(*)::int n FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE u.is_active AND tp.employment_status <> 'terminated'`);
    if (n >= e.limits.technicians) throw new AppError(403, 'PLAN_LIMIT', `Your ${e.planName} plan allows ${e.limits.technicians} technicians. Upgrade to add more.`);
  }
  if (kind === 'branches') {
    const { n } = await db.one(`SELECT count(*)::int n FROM branches WHERE is_active`);
    if (n >= e.limits.branches) throw new AppError(403, 'PLAN_LIMIT', `Your ${e.planName} plan allows ${e.limits.branches} branch(es).`);
  }
  if (kind === 'storage' && e.limits.storageMb != null) {
    const { bytes } = await db.one(`SELECT COALESCE(sum(size_bytes),0)::bigint bytes FROM documents WHERE deleted_at IS NULL`);
    if (Number(bytes) + addBytes > e.limits.storageMb * 1024 * 1024) throw new AppError(403, 'PLAN_LIMIT', 'Storage limit reached for your plan.');
  }
}

import type { NextFunction, Request, Response } from 'express';
import { forbidden, paymentRequired, unauthorized } from '../lib/errors.js';
import { verifyAccessToken } from './tokens.js';
import { loadContext } from './context.js';
import { getEntitlements } from '../modules/subscriptions/entitlements.js';
import type { FeatureKey } from '../modules/subscriptions/plans.js';

export async function authenticate(req: Request, _res: Response, next: NextFunction) {
  try {
    const h = req.get('authorization');
    if (!h?.startsWith('Bearer ')) throw unauthorized();
    let claims;
    try { claims = verifyAccessToken(h.slice(7)); } catch { throw unauthorized('Session expired'); }
    const ctx = await loadContext(claims.sid, claims.sub, claims.typ);
    if (!ctx) throw unauthorized('Session is no longer valid');
    req.auth = ctx;
    next();
  } catch (e) { next(e); }
}

/** Passes if the user holds ANY of the listed permissions. */
export const requirePermission = (...perms: string[]) => (req: Request, _res: Response, next: NextFunction) => {
  const a = req.auth;
  if (!a) return next(unauthorized());
  if (!perms.some((p) => a.permissions.has(p))) return next(forbidden());
  next();
};

export const requireTenant = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.tenantId) return next(forbidden('A business account is required'));
  next();
};

export const requireStaff = (req: Request, _res: Response, next: NextFunction) => {
  if (!req.auth?.tenantId || (req.auth.userType !== 'staff' && !req.auth.support)) return next(forbidden());
  next();
};

export const requirePlatform = (req: Request, _res: Response, next: NextFunction) => {
  if (req.auth?.userType !== 'platform' || req.auth.support) return next(forbidden());
  next();
};

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * Enforces SaaS entitlements: suspended/expired subscriptions become read-only (except billing),
 * and support sessions are always read-only.
 */
export async function subscriptionGuard(req: Request, _res: Response, next: NextFunction) {
  try {
    const a = req.auth;
    if (!a?.tenantId) return next();
    if (a.support && MUTATING.has(req.method)) throw forbidden('Support sessions are read-only');
    const ent = await getEntitlements(a.tenantId);
    if (ent.readOnly && MUTATING.has(req.method) && !req.path.startsWith('/subscription')) {
      throw paymentRequired(`Your subscription is ${ent.status.replace('_', ' ')}. Renew to continue making changes.`);
    }
    next();
  } catch (e) { next(e); }
}

export const requireFeature = (feature: FeatureKey) => async (req: Request, _res: Response, next: NextFunction) => {
  try {
    const ent = await getEntitlements(req.auth!.tenantId!);
    if (!ent.features[feature]) throw new (await import('../lib/errors.js')).AppError(403, 'FEATURE_NOT_IN_PLAN', `The "${feature}" feature is not included in your ${ent.planName} plan. Upgrade to enable it.`);
    next();
  } catch (e) { next(e); }
};

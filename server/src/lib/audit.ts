import type { Request } from 'express';
import type { Db } from '../db/pool.js';

const SENSITIVE = /password|secret|token|mfa|api_?key/i;
function scrub(v: unknown): unknown {
  if (!v || typeof v !== 'object') return v;
  if (Array.isArray(v)) return v.map(scrub);
  return Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([k, val]) => [k, SENSITIVE.test(k) ? '[REDACTED]' : scrub(val)]));
}

export interface AuditEntry {
  action: string;
  entityType?: string;
  entityId?: string | null;
  before?: unknown;
  after?: unknown;
}

/** Append-only audit record. Written inside the caller's transaction so it commits with the change. */
export async function audit(db: Db, req: Request | null, e: AuditEntry, overrides?: { tenantId?: string | null; userId?: string | null; email?: string | null }) {
  const u = req?.auth;
  await db.query(
    `INSERT INTO audit_logs (tenant_id, user_id, user_email, action, entity_type, entity_id, before_data, after_data, ip, user_agent, request_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
    [
      overrides?.tenantId !== undefined ? overrides.tenantId : (db.tenantId ?? u?.tenantId ?? null),
      overrides?.userId !== undefined ? overrides.userId : (u?.userId ?? null),
      overrides?.email !== undefined ? overrides.email : (u?.email ?? null),
      e.action, e.entityType ?? null, e.entityId ?? null,
      e.before ? JSON.stringify(scrub(e.before)) : null,
      e.after ? JSON.stringify(scrub(e.after)) : null,
      req?.ip ?? null, req?.get?.('user-agent')?.slice(0, 300) ?? null, req?.id ?? null,
    ],
  );
}

/** Keep only changed keys for before/after diffs. */
export function diff(before: Record<string, any>, after: Record<string, any>) {
  const b: Record<string, unknown> = {}; const a: Record<string, unknown> = {};
  for (const k of Object.keys(after)) {
    if (JSON.stringify(before?.[k]) !== JSON.stringify(after[k])) { b[k] = before?.[k]; a[k] = after[k]; }
  }
  return { before: b, after: a };
}

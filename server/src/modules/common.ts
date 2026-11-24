import type { Request } from 'express';
import { withTenant, type Db } from '../db/pool.js';
import { notFound } from '../lib/errors.js';

/** Run a tenant-scoped (RLS-enforced) transaction for the authenticated user's business. */
export const tx = <T>(req: Request, fn: (db: Db) => Promise<T>) => withTenant(req.auth!.tenantId!, fn);

/** Branch managers only see their own branch's operational data. */
export const branchScope = (req: Request): string | null =>
  req.auth?.roles.includes('branch_manager') && !req.auth.roles.some((r) => r === 'owner' || r === 'admin') ? req.auth.branchId : null;

export const can = (req: Request, p: string) => !!req.auth?.permissions.has(p);

export async function mustFind<T = any>(db: Db, table: string, id: string, what: string, cols = '*'): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(what);
  const r = await db.maybeOne<T>(`SELECT ${cols} FROM ${table} WHERE id = $1`, [id]);
  if (!r) throw notFound(what);
  return r;
}

export async function tenantSettings(db: Db) {
  return db.one(`SELECT s.*, t.name AS business_name, t.legal_name, t.email AS business_email, t.phone AS business_phone,
     t.address_line1, t.address_line2, t.city, t.state, t.postal_code, t.country
     FROM tenant_settings s JOIN tenants t ON t.id = s.tenant_id WHERE s.tenant_id = $1`, [db.tenantId]);
}

export function fmtMoney(amount: number | string, currency: string, locale = 'en-IN') {
  try { return new Intl.NumberFormat(locale, { style: 'currency', currency }).format(Number(amount)); }
  catch { return `${currency} ${Number(amount).toFixed(2)}`; }
}

export function fmtDateTime(d: string | Date | null, tz: string, locale = 'en-IN') {
  if (!d) return '';
  return new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: tz }).format(new Date(d));
}

export const normalizePhone = (p?: string | null) => {
  if (!p) return null;
  const digits = p.replace(/[^\d+]/g, '');
  const d = digits.replace(/^\+/, '');
  return d.length >= 7 ? d.slice(-10) : null; // last 10 digits: tolerant of +91/0 prefixes
};

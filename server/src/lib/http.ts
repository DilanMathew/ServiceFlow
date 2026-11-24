import type { NextFunction, Request, Response, RequestHandler } from 'express';
import { z } from 'zod';
import { badRequest } from './errors.js';

export const ah = (fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>): RequestHandler =>
  (req, res, next) => { fn(req, res, next).catch(next); };

export function parse<S extends z.ZodTypeAny>(schema: S, data: unknown): z.output<S> {
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest('Validation failed', r.error.flatten());
  return r.data;
}

export const listQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  q: z.string().trim().max(200).optional(),
  sort: z.string().max(50).optional(),
  order: z.enum(['asc', 'desc']).default('desc'),
});
export type ListQuery = z.infer<typeof listQuery>;

/** Whitelisted ORDER BY to avoid SQL injection through sort parameters. */
export function orderBy(q: ListQuery, allowed: Record<string, string>, fallback: string): string {
  const col = q.sort && allowed[q.sort] ? allowed[q.sort] : fallback;
  return `${col} ${q.order === 'asc' ? 'ASC' : 'DESC'} NULLS LAST`;
}

/** Tiny dynamic WHERE builder producing parameterised SQL. */
export class Where {
  parts: string[] = [];
  params: unknown[] = [];
  add(sqlWithQ: string, ...values: unknown[]) {
    let s = sqlWithQ;
    for (const v of values) {
      this.params.push(v);
      s = s.replace('?', `$${this.params.length}`);
    }
    this.parts.push(s);
    return this;
  }
  addIf(cond: unknown, sqlWithQ: string, ...values: unknown[]) {
    if (cond !== undefined && cond !== null && cond !== '') this.add(sqlWithQ, ...values);
    return this;
  }
  get sql() { return this.parts.length ? `WHERE ${this.parts.join(' AND ')}` : ''; }
  next() { return `$${this.params.length + 1}`; }
}

export function paged<T>(rows: (T & { _total?: number })[], q: ListQuery) {
  const total = rows.length ? Number((rows[0] as any)._total) : 0;
  return {
    data: rows.map(({ _total, ...r }: any) => r as T),
    meta: { page: q.page, pageSize: q.pageSize, total, totalPages: Math.ceil(total / q.pageSize) },
  };
}

export const uuid = z.string().uuid();
export const optionalUuid = z.string().uuid().nullable().optional();
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
export const money = z.coerce.number().min(0).max(1e11).multipleOf(0.01);

export function toCsv(rows: Record<string, unknown>[], columns: string[]): string {
  const esc = (v: unknown) => {
    if (v === null || v === undefined) return '';
    let s = typeof v === 'object' ? JSON.stringify(v) : String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // CSV/formula injection guard
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [columns.join(','), ...rows.map((r) => columns.map((c) => esc(r[c])).join(','))].join('\n');
}

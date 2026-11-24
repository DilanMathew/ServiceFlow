/**
 * API client. The access token lives only in memory; the refresh token is an httpOnly,
 * SameSite=Strict cookie scoped to /api/auth. 401s trigger one silent refresh + retry.
 */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: any) { super(message); }
  fieldErrors(): Record<string, string> {
    const fe = this.details?.fieldErrors ?? {};
    return Object.fromEntries(Object.entries(fe).map(([k, v]) => [k, Array.isArray(v) ? String(v[0]) : String(v)]));
  }
}

let accessToken: string | null = null;
let refreshing: Promise<boolean> | null = null;
const listeners = new Set<(t: string | null) => void>();
export const getToken = () => accessToken;
export function setToken(t: string | null) { accessToken = t; listeners.forEach((l) => l(t)); }
export const onTokenChange = (fn: (t: string | null) => void) => { listeners.add(fn); return () => listeners.delete(fn); };

export async function refreshSession(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch('/api/auth/refresh', { method: 'POST', credentials: 'include', headers: { 'X-Requested-With': 'ServiceFlow' } })
      .then(async (r) => { if (!r.ok) { setToken(null); return false; } setToken((await r.json()).data.accessToken); return true; })
      .catch(() => false)
      .finally(() => { setTimeout(() => { refreshing = null; }, 0); });
  }
  return refreshing;
}

type Opts = { method?: string; body?: unknown; headers?: Record<string, string>; raw?: boolean; signal?: AbortSignal };

export async function api<T = any>(path: string, opts: Opts = {}, retry = true): Promise<T> {
  const isForm = typeof FormData !== 'undefined' && opts.body instanceof FormData;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (!isForm && opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
  const res = await fetch(path.startsWith('/api') ? path : `/api${path}`, {
    method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, credentials: 'include', signal: opts.signal,
    body: opts.body === undefined ? undefined : isForm ? (opts.body as FormData) : JSON.stringify(opts.body),
  });
  if (res.status === 401 && retry && !path.includes('/auth/login') && !path.includes('/auth/refresh')) {
    if (await refreshSession()) return api<T>(path, opts, false);
  }
  if (opts.raw) {
    if (!res.ok) throw await toError(res);
    return res as unknown as T;
  }
  if (!res.ok) throw await toError(res);
  if (res.status === 204) return undefined as T;
  return res.json();
}

async function toError(res: Response) {
  let body: any = null;
  try { body = await res.json(); } catch { /* not json */ }
  const e = body?.error ?? {};
  return new ApiError(res.status, e.code ?? 'HTTP_' + res.status, e.message ?? (res.status >= 500 ? 'Something went wrong. Please try again.' : 'Request failed'), e.details);
}

export const get = <T = any>(p: string) => api<T>(p);
export const post = <T = any>(p: string, body?: unknown, headers?: Record<string, string>) => api<T>(p, { method: 'POST', body: body ?? {}, headers });
export const patch = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PATCH', body: body ?? {} });
export const put = <T = any>(p: string, body?: unknown) => api<T>(p, { method: 'PUT', body: body ?? {} });
export const del = <T = any>(p: string) => api<T>(p, { method: 'DELETE' });

/** Opens an authenticated file (PDF etc.) in a new tab without putting the token in a URL. */
export async function openFile(path: string, download?: string) {
  const win = download ? null : window.open('', '_blank');
  try {
    const res = await api<Response>(path, { raw: true });
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    if (download) {
      const a = document.createElement('a'); a.href = url; a.download = download; a.click();
    } else if (win) win.location.href = url;
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } catch (e) { win?.close(); throw e; }
}

export function qs(params: Record<string, unknown>) {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '' && v !== false) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
}

export interface Paged<T> { data: T[]; meta: { page: number; pageSize: number; total: number; totalPages: number } }
export const newIdempotencyKey = () => `ui-${crypto.randomUUID()}`;

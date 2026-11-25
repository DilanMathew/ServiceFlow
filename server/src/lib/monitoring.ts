/**
 * Error monitoring. Sentry is used only when SENTRY_DSN is set; otherwise every function is a no-op.
 * Privacy: no request bodies, cookies, auth headers, query strings or user emails are sent —
 * only ids (request, tenant, user) and the error itself.
 */
import * as Sentry from '@sentry/node';
import { config } from '../config.js';

let enabled = false;
const SENSITIVE_KEY = /pass|secret|token|authorization|cookie|otp|code|signature|key/i;

function scrub<T>(v: T, depth = 0): T {
  if (!v || typeof v !== 'object' || depth > 4) return v;
  if (Array.isArray(v)) return v.map((x) => scrub(x, depth + 1)) as T;
  const out: Record<string, unknown> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = SENSITIVE_KEY.test(k) ? '[redacted]' : scrub(val, depth + 1);
  return out as T;
}

export function initMonitoring() {
  if (!config.SENTRY_DSN || config.NODE_ENV === 'test') return;
  Sentry.init({
    dsn: config.SENTRY_DSN,
    environment: config.SENTRY_ENVIRONMENT ?? config.NODE_ENV,
    release: config.RELEASE,
    // Collect nothing personal: no user info, cookies, headers, bodies, query strings, SQL params or local variables.
    dataCollection: { userInfo: false, cookies: false, httpHeaders: false, httpBodies: [], urlQueryParams: false,
      databaseQueryData: false, stackFrameVariables: false, genAI: { inputs: false, outputs: false } },
    tracesSampleRate: config.SENTRY_TRACES_SAMPLE_RATE,
    beforeSend(event) {
      if (event.request) {
        delete event.request.cookies; delete event.request.data; delete event.request.query_string;
        if (event.request.headers) event.request.headers = scrub(event.request.headers);
        if (event.request.url) event.request.url = event.request.url.split('?')[0];
      }
      if (event.user) event.user = { id: event.user.id };
      if (event.extra) event.extra = scrub(event.extra);
      return event;
    },
    beforeBreadcrumb(b) { if (b.data) b.data = scrub(b.data); return b; },
  });
  enabled = true;
}

export function monitoringEnabled() { return enabled; }

export interface ErrorContext { requestId?: string; tenantId?: string | null; userId?: string | null; route?: string; jobType?: string; jobId?: string; [k: string]: unknown }

export function captureError(err: unknown, ctx: ErrorContext = {}) {
  if (!enabled) return;
  Sentry.withScope((scope) => {
    const { requestId, tenantId, userId, route, jobType, ...extra } = ctx;
    if (requestId) scope.setTag('request_id', requestId);
    if (tenantId) scope.setTag('tenant_id', tenantId);
    if (route) scope.setTag('route', route);
    if (jobType) scope.setTag('job_type', jobType);
    if (userId) scope.setUser({ id: userId });
    scope.setExtras(scrub(extra));
    Sentry.captureException(err);
  });
}

export async function flushMonitoring(timeoutMs = 2000) { if (enabled) await Sentry.flush(timeoutMs); }

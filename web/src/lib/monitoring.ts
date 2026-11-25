/**
 * Browser error monitoring. The Sentry SDK is loaded lazily and only when the server
 * publishes a DSN (`/api/public/client-config`), so it costs nothing when monitoring is off.
 * Nothing personal is sent: no user emails, request bodies, cookies or query strings.
 */
type SentryModule = typeof import('@sentry/react');
let sentry: SentryModule | null = null;
const pending: Array<[unknown, Record<string, unknown>]> = [];

export interface ClientConfig { environment: string; release: string | null; sentryDsn: string | null; sentryTracesSampleRate: number }
let clientConfig: Promise<ClientConfig | null> | null = null;
export function getClientConfig() {
  clientConfig ??= fetch('/api/public/client-config').then((r) => (r.ok ? r.json() : null)).then((j) => j?.data ?? null).catch(() => null);
  return clientConfig;
}

const stripQuery = (u?: string) => (u ? u.split('?')[0].split('#')[0] : u);

export async function initMonitoring() {
  const cfg = await getClientConfig();
  if (!cfg?.sentryDsn) return;
  const S = await import('@sentry/react');
  S.init({
    dsn: cfg.sentryDsn, environment: cfg.environment, release: cfg.release ?? undefined,
    tracesSampleRate: cfg.sentryTracesSampleRate,
    beforeSend(event) {
      if (event.request) { event.request.url = stripQuery(event.request.url); delete event.request.cookies; delete event.request.headers; delete event.request.query_string; }
      if (event.user) event.user = event.user.id ? { id: event.user.id } : undefined;
      return event;
    },
    beforeBreadcrumb(b) {
      if (b.category === 'console') return null;                      // console output may contain personal data
      if (b.data?.url) b.data.url = stripQuery(String(b.data.url));
      if (b.category === 'ui.input') return null;
      return b;
    },
  });
  sentry = S;
  for (const [err, ctx] of pending.splice(0)) captureError(err, ctx);
}

export function captureError(err: unknown, ctx: Record<string, unknown> = {}) {
  if (!sentry) { if (pending.length < 20) pending.push([err, ctx]); return; }
  sentry.withScope((scope) => { scope.setExtras(ctx); sentry!.captureException(err); });
}

/** Tag events with ids only (no email or name). */
export function setMonitoringUser(u: { id: string; tenantId?: string | null; role?: string } | null) {
  if (!sentry) return;
  sentry.setUser(u ? { id: u.id } : null);
  sentry.setTag('tenant_id', u?.tenantId ?? undefined);
  sentry.setTag('role', u?.role ?? undefined);
}

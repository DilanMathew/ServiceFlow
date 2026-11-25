import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import rateLimit from 'express-rate-limit';
import { pinoHttp } from 'pino-http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ZodError } from 'zod';
import { captureError } from './lib/monitoring.js';
import { idempotency } from './lib/idempotency.js';
import { config, isProd } from './config.js';
import { logger } from './logger.js';
import { pool } from './db/pool.js';
import { AppError } from './lib/errors.js';
import { authenticate, requireStaff, subscriptionGuard } from './auth/middleware.js';
import { authRouter } from './modules/auth/routes.js';
import { tenantRouter } from './modules/router.js';
import { publicRouter } from './modules/public/routes.js';
import { portalRouter } from './modules/portal/routes.js';
import { platformRouter } from './modules/platform/routes.js';
import { webhookRouter } from './modules/payments/webhooks.js';
import { storage } from './integrations/storage.js';

/** Sentry ingest origin for the browser SDK, if configured (CSP connect-src). */
function sentryOrigins() {
  const dsn = config.SENTRY_DSN_WEB ?? config.SENTRY_DSN;
  try { return dsn ? [new URL(dsn).origin] : []; } catch { return []; }
}

// Storage probe result is cached for a minute: the S3 check is a real write/read/delete round trip.
let storageCache: { at: number; status: string } | null = null;
async function storageStatus() {
  if (storageCache && Date.now() - storageCache.at < 60_000) return storageCache.status;
  let status = 'ok';
  try { await storage.health(); } catch (err) { status = 'error'; logger.warn({ err }, 'storage health check failed'); }
  storageCache = { at: Date.now(), status };
  return status;
}

export function createApp() {
  const app = express();
  app.set('trust proxy', config.TRUST_PROXY);
  app.disable('x-powered-by');

  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[\w-]{8,64}$/.test(incoming) ? incoming : crypto.randomUUID();
    res.setHeader('x-request-id', req.id);
    next();
  });
  app.use(pinoHttp({ logger, genReqId: (req: any) => (req as Request).id!, autoLogging: { ignore: (req: any) => req.url === '/api/health' },
    serializers: { req: (r: any) => ({ id: r.id, method: r.method, url: r.url?.split('?')[0] }) } }));

  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: true,
      directives: {
        'img-src': ["'self'", 'data:', 'blob:'],
        'connect-src': ["'self'", ...sentryOrigins()],
        'frame-ancestors': ["'none'"],
        'font-src': ["'self'", 'https://fonts.gstatic.com', 'data:'],
        'style-src': ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
      },
    },
    crossOriginEmbedderPolicy: false,
    hsts: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  }));

  const allowed = new Set([config.APP_URL, ...config.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean)]);
  app.use(cors({ origin: (origin, cb) => cb(null, !origin || allowed.has(origin)), credentials: true }));

  // Webhooks need the raw body for signature verification
  app.use('/api/webhooks', express.raw({ type: '*/*', limit: '1mb' }), (req, _res, next) => { req.rawBody = req.body as Buffer; next(); }, webhookRouter);

  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => res.json({ status: 'ok', service: 'nexus-serviceflow', time: new Date().toISOString() }));
  app.get('/api/health/ready', async (_req, res) => {
    const checks: Record<string, string> = {};
    try { await pool.query('SELECT 1'); checks.database = 'ok'; } catch { checks.database = 'error'; }
    checks.storage = await storageStatus();
    try {
      const r = await pool.query(`SELECT count(*) FILTER (WHERE status='dead' AND created_at > now() - interval '24 hours')::int dead,
        count(*) FILTER (WHERE status='pending' AND run_at < now() - interval '10 minutes')::int stuck FROM background_jobs`);
      checks.queue = r.rows[0].stuck > 50 ? 'degraded' : 'ok';
    } catch { checks.queue = 'error'; }
    const ok = checks.database === 'ok';
    res.status(ok ? 200 : 503).json({ status: ok ? 'ok' : 'error', checks });
  });

  const authLimiter = rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 10_000 : 20, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please wait a minute.' } } });
  const apiLimiter = rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 100_000 : 600, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } });
  const publicLimiter = rateLimit({ windowMs: 60_000, limit: config.NODE_ENV === 'test' ? 10_000 : 30, standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: { code: 'RATE_LIMITED', message: 'Too many requests' } } });

  // Strict brute-force limits only on credential endpoints; session refresh and /me use the normal API limit.
  const SENSITIVE = new Set(['/login', '/register', '/forgot-password', '/reset-password', '/mfa/verify', '/accept-invite', '/portal/register', '/verify-email', '/resend-verification', '/change-password', '/mfa/disable']);
  app.use('/api/auth', (req, res, next) => (SENSITIVE.has(req.path) ? authLimiter : apiLimiter)(req, res, next), authRouter);
  app.use('/api/public', publicLimiter, publicRouter);
  app.use('/api/portal', apiLimiter, authenticate, subscriptionGuard, portalRouter);
  app.use('/api/platform', apiLimiter, authenticate, platformRouter);
  app.use('/api/app', apiLimiter, authenticate, requireStaff, subscriptionGuard, idempotency, tenantRouter);
  app.use('/api', (_req, res) => res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Endpoint not found' } }));

  // Serve the built SPA in production (single Railway service)
  const here = path.dirname(fileURLToPath(import.meta.url));
  const webDist = [path.resolve(here, '../../web/dist'), path.resolve(here, '../../../web/dist')].find((p) => fs.existsSync(p));
  if (webDist) {
    // Hashed assets are immutable; the HTML shell, service worker and its manifests must always revalidate.
    const fresh = /(\.html|[\\/]sw\.js|[\\/]precache\.json|\.webmanifest)$/;
    app.use(express.static(webDist, { index: false, maxAge: '1y', immutable: true, setHeaders: (res, p) => {
      if (fresh.test(p)) res.setHeader('Cache-Control', 'no-cache');
      if (p.endsWith('sw.js')) res.setHeader('Service-Worker-Allowed', '/');
    } }));
    app.get('*', (_req, res) => { res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(webDist, 'index.html')); });
  }

  // Centralised error handler with a consistent response shape
  app.use((err: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message, details: err.details, requestId: req.id } });
    }
    if (err instanceof ZodError) {
      return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Validation failed', details: err.flatten(), requestId: req.id } });
    }
    const pg = err as { code?: string; constraint?: string; message?: string; type?: string };
    if (pg?.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Malformed JSON body' } });
    if (pg?.code === '23505') return res.status(409).json({ error: { code: 'DUPLICATE', message: duplicateMessage(pg.constraint), details: { constraint: pg.constraint }, requestId: req.id } });
    if (pg?.code === '23P01') return res.status(409).json({ error: { code: 'SCHEDULE_CONFLICT', message: 'This technician already has a job in that time slot.', requestId: req.id } });
    if (pg?.code === '23503') return res.status(400).json({ error: { code: 'INVALID_REFERENCE', message: 'A referenced record does not exist or belongs to another account.', requestId: req.id } });
    if (pg?.code === '23514') return res.status(422).json({ error: { code: 'BUSINESS_RULE', message: pg.message?.includes('quantity') ? 'Insufficient stock for this operation.' : (pg.message ?? 'Constraint violated'), requestId: req.id } });
    if (pg?.code === '42501') return res.status(403).json({ error: { code: 'FORBIDDEN', message: 'Access denied', requestId: req.id } });
    if (pg?.code === '22P02') return res.status(400).json({ error: { code: 'BAD_REQUEST', message: 'Invalid identifier format', requestId: req.id } });
    logger.error({ err, requestId: req.id }, 'unhandled error');
    captureError(err, { requestId: String(req.id ?? ""), tenantId: req.auth?.tenantId, userId: req.auth?.userId, route: `${req.method} ${req.baseUrl}${req.route?.path ?? ''}` });
    res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong. Please try again.', requestId: req.id } });
  });
  return app;
}

function duplicateMessage(c?: string) {
  const map: Record<string, string> = {
    customers_email_uq: 'A customer with this email already exists.', customers_phone_uq: 'A customer with this phone number already exists.',
    users_email_tenant_uq: 'A user with this email already exists in your business.', assets_serial_uq: 'An asset with this manufacturer and serial number already exists.',
    payments_provider_uq: 'This payment has already been recorded.', payments_idem_uq: 'This payment has already been recorded.',
    refunds_tenant_id_idempotency_key_key: 'This refund has already been processed.', inventory_items_tenant_id_sku_key: 'An item with this SKU already exists.',
    invoices_quotation_uq: 'An invoice already exists for this quotation.', work_orders_request_uq: 'This request has already been converted to a work order.',
    job_assignments_current_uq: 'This job already has an active assignment.', tenants_slug_key: 'This workspace URL is already taken.',
  };
  return (c && map[c]) || 'A record with these details already exists.';
}

import { Router } from 'express';
import { z } from 'zod';
import { requireFeature, requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { audit } from '../../lib/audit.js';
import { badRequest } from '../../lib/errors.js';
import { decrypt, encrypt } from '../../lib/crypto.js';
import { tx } from '../common.js';
import { PROVIDER_CATALOG, getIntegration, markIntegrationHealth, type IntegrationKind } from '../../integrations/registry.js';
import { sendEmail } from '../../integrations/email.js';
import { sendWhatsApp, sendSms } from '../../integrations/messaging.js';
import { geocode } from '../../integrations/maps.js';
import { config } from '../../config.js';
import { aiProviderName } from '../../integrations/ai.js';

export const integrationsRouter = Router();
const KINDS = Object.keys(PROVIDER_CATALOG) as IntegrationKind[];

integrationsRouter.get('/', requirePermission('integrations.manage', 'settings.manage'), ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT kind, provider, mode, config, is_enabled, status, last_checked_at, last_error, (secrets_encrypted IS NOT NULL) AS has_secrets,
    secrets_encrypted, updated_at FROM integrations`));
  const out = KINDS.map((kind) => {
    const r = rows.find((x) => x.kind === kind);
    let secretKeys: string[] = [];
    if (r?.secrets_encrypted) { try { secretKeys = Object.keys(JSON.parse(decrypt(r.secrets_encrypted))); } catch { /* ignore */ } }
    return { kind, providers: PROVIDER_CATALOG[kind], current: r ? { provider: r.provider, mode: r.mode, config: r.config, enabled: r.is_enabled, status: r.status,
      lastCheckedAt: r.last_checked_at, lastError: r.last_error, secretsSet: secretKeys } : null,
      webhookUrl: kind === 'payment' && r ? `${config.APP_URL}/api/webhooks/payments/${r.provider}/${req.auth!.tenantId}` : kind === 'whatsapp' ? `${config.APP_URL}/api/webhooks/whatsapp/${req.auth!.tenantId}` : null };
  });
  res.json({ data: out, meta: { aiProvider: aiProviderName(), storageDriver: config.STORAGE_DRIVER, platformEmail: config.EMAIL_DRIVER } });
}));

/** Secrets are write-only: encrypted at rest (AES-256-GCM) and never returned by any endpoint. */
integrationsRouter.put('/:kind', requirePermission('integrations.manage'), ah(async (req, res) => {
  const kind = req.params.kind as IntegrationKind;
  if (!KINDS.includes(kind)) throw badRequest('Unknown integration');
  if (['whatsapp', 'sms'].includes(kind)) await new Promise<void>((resolve, reject) => requireFeature('notifications')(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
  if (kind === 'payment') await new Promise<void>((resolve, reject) => requireFeature('invoicing')(req, res, (e?: unknown) => (e ? reject(e) : resolve())));
  const b = parse(z.object({ provider: z.string(), mode: z.enum(['test', 'live']).default('test'), enabled: z.boolean().default(true),
    config: z.record(z.string(), z.union([z.string().max(500), z.number(), z.boolean()])).default({}), secrets: z.record(z.string(), z.string().max(4000)).optional() }), req.body);
  const def = PROVIDER_CATALOG[kind].find((p) => p.provider === b.provider);
  if (!def) throw badRequest('Unknown provider');
  const cfg = Object.fromEntries(Object.entries(b.config).filter(([k]) => def.config.includes(k)));
  await tx(req, async (db) => {
    const existing = await db.maybeOne(`SELECT secrets_encrypted, provider FROM integrations WHERE kind = $1`, [kind]);
    let secrets: Record<string, string> = {};
    if (existing?.secrets_encrypted && existing.provider === b.provider) { try { secrets = JSON.parse(decrypt(existing.secrets_encrypted)); } catch { secrets = {}; } }
    for (const [k, v] of Object.entries(b.secrets ?? {})) if (def.secrets.includes(k) && v !== '') secrets[k] = v;
    if (b.mode === 'live' && b.enabled) {
      const missing = [...def.config.filter((k) => !['fromName', 'replyTo', 'languageCode', 'businessAccountId'].includes(k) && !cfg[k]), ...def.secrets.filter((k) => !secrets[k] && k !== 'verifyToken')];
      if (missing.length) throw badRequest(`Missing required settings for live mode: ${missing.join(', ')}`);
    }
    await db.query(`INSERT INTO integrations (tenant_id, kind, provider, mode, config, secrets_encrypted, is_enabled, status) VALUES ($1,$2,$3,$4,$5,$6,$7,'unconfigured')
      ON CONFLICT (tenant_id, kind) DO UPDATE SET provider = EXCLUDED.provider, mode = EXCLUDED.mode, config = EXCLUDED.config, secrets_encrypted = EXCLUDED.secrets_encrypted,
      is_enabled = EXCLUDED.is_enabled, status = 'unconfigured', last_error = NULL`,
      [db.tenantId, kind, b.provider, b.mode, JSON.stringify(cfg), Object.keys(secrets).length ? encrypt(JSON.stringify(secrets)) : null, b.enabled]);
    await audit(db, req, { action: 'integration.configured', entityType: 'integration', entityId: kind, after: { provider: b.provider, mode: b.mode, enabled: b.enabled, config: cfg, secretsUpdated: Object.keys(b.secrets ?? {}) } });
  });
  res.json({ data: { ok: true } });
}));

integrationsRouter.post('/:kind/test', requirePermission('integrations.manage'), ah(async (req, res) => {
  const kind = req.params.kind as IntegrationKind;
  const b = parse(z.object({ to: z.string().max(200).optional() }), req.body ?? {});
  const t = req.auth!.tenantId!;
  const integ = await getIntegration(t, kind);
  if (!integ) throw badRequest('Integration is not enabled');
  let result: unknown;
  try {
    if (kind === 'email') result = await sendEmail({ to: b.to ?? req.auth!.email, subject: 'NEXUS ServiceFlow test email', text: 'Your email integration is working.' }, integ);
    else if (kind === 'whatsapp') { if (!b.to) throw badRequest('Phone number required'); result = await sendWhatsApp(integ, b.to, 'Test message from NEXUS ServiceFlow', null); }
    else if (kind === 'sms') { if (!b.to) throw badRequest('Phone number required'); result = await sendSms(integ, b.to, 'Test message from NEXUS ServiceFlow'); }
    else if (kind === 'maps') result = { geocoded: await geocode(b.to ?? 'Connaught Place, New Delhi', integ) };
    else result = { ok: true };
    await markIntegrationHealth(t, kind, true);
    res.json({ data: { ok: true, result } });
  } catch (e) {
    await markIntegrationHealth(t, kind, false, (e as Error).message);
    res.status(502).json({ error: { code: 'INTEGRATION_ERROR', message: (e as Error).message } });
  }
}));

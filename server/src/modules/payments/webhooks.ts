import { Router } from 'express';
import { ah } from '../../lib/http.js';
import { systemDb, withTenant } from '../../db/pool.js';
import { getIntegration } from '../../integrations/registry.js';
import { paymentProvider, testProvider, type PaymentProvider } from '../../integrations/payments.js';
import { applyGatewayEvent } from './service.js';
import { logger } from '../../logger.js';
import { handleBillingWebhook } from '../subscriptions/billing.js';
import { handleWhatsAppWebhook, verifyWhatsAppSubscription } from '../notifications/whatsapp-inbound.js';

export const webhookRouter = Router();

/**
 * Processes a verified gateway webhook for a tenant. The event is written to the webhook_events
 * ledger first; a replayed event id is acknowledged without reprocessing.
 */
export async function processPaymentWebhook(tenantId: string, provider: PaymentProvider, raw: Buffer, headers: Record<string, string | undefined>) {
  const valid = provider.verifyWebhook(raw, headers);
  let event;
  try { event = provider.parseWebhook(raw, headers); } catch { return { status: 400, body: { error: 'Malformed payload' } }; }
  let payload: unknown; try { payload = JSON.parse(raw.toString('utf8')); } catch { payload = {}; }
  const inserted = await systemDb.maybeOne(`INSERT INTO webhook_events (provider, event_id, event_type, tenant_id, payload, signature_valid)
    VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`,
    [`${provider.name}:${tenantId}`, event.eventId, event.type, tenantId, JSON.stringify(payload), valid]);
  if (!valid) { logger.warn({ provider: provider.name, tenantId }, 'webhook signature invalid'); return { status: 401, body: { error: 'Invalid signature' } }; }
  if (!inserted) {
    const prior = await systemDb.maybeOne(`SELECT processed_at FROM webhook_events WHERE provider = $1 AND event_id = $2`, [`${provider.name}:${tenantId}`, event.eventId]);
    if (prior?.processed_at) return { status: 200, body: { received: true, duplicate: true } };
  }
  try {
    const result = await withTenant(tenantId, (db) => applyGatewayEvent(db, provider.name, event));
    await systemDb.query(`UPDATE webhook_events SET processed_at = now(), processing_error = NULL WHERE provider = $1 AND event_id = $2`, [`${provider.name}:${tenantId}`, event.eventId]);
    return { status: 200, body: { received: true, ...result } };
  } catch (err) {
    await systemDb.query(`UPDATE webhook_events SET processing_error = $3 WHERE provider = $1 AND event_id = $2`, [`${provider.name}:${tenantId}`, event.eventId, (err as Error).message.slice(0, 500)]);
    logger.error({ err, tenantId }, 'webhook processing failed');
    return { status: 500, body: { error: 'Processing failed; the provider will retry' } }; // non-2xx -> provider retries
  }
}

webhookRouter.post('/payments/:provider/:tenantId', ah(async (req, res) => {
  const { provider: name, tenantId } = req.params;
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return res.status(404).end();
  const integ = await getIntegration(tenantId, 'payment');
  const provider = name === 'test' && integ?.provider === 'test' ? testProvider : paymentProvider(integ);
  if (!provider || provider.name !== name) return res.status(404).json({ error: 'Gateway not configured' });
  const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k.toLowerCase(), Array.isArray(v) ? v[0] : v]));
  const out = await processPaymentWebhook(tenantId, provider, req.rawBody ?? Buffer.alloc(0), headers);
  res.status(out.status).json(out.body);
}));

// NEXUS SaaS subscription billing (separate from tenant payments)
webhookRouter.post('/billing/:provider', ah(async (req, res) => {
  const out = await handleBillingWebhook(req.params.provider, req.rawBody ?? Buffer.alloc(0), req.headers as Record<string, string>);
  res.status(out.status).json(out.body);
}));

// WhatsApp Business Cloud API inbound messages & delivery statuses
webhookRouter.get('/whatsapp/:tenantId', ah(async (req, res) => {
  const challenge = await verifyWhatsAppSubscription(req.params.tenantId, req.query as Record<string, string>);
  if (challenge === null) return res.status(403).end();
  res.type('text/plain').send(challenge);
}));
webhookRouter.post('/whatsapp/:tenantId', ah(async (req, res) => {
  const out = await handleWhatsAppWebhook(req.params.tenantId, req.rawBody ?? Buffer.alloc(0), req.get('x-hub-signature-256'));
  res.status(out.status).json(out.body);
}));

import { systemDb } from '../db/pool.js';
import { decrypt } from '../lib/crypto.js';

export type IntegrationKind = 'email' | 'whatsapp' | 'sms' | 'payment' | 'maps' | 'ai' | 'storage' | 'einvoice' | 'peppol';
export interface TenantIntegration {
  kind: IntegrationKind; provider: string; mode: 'test' | 'live'; config: Record<string, any>;
  secrets: Record<string, string>; enabled: boolean;
}

/** Loads a tenant's integration with decrypted secrets (server-side only, never returned to clients). */
export async function getIntegration(tenantId: string, kind: IntegrationKind): Promise<TenantIntegration | null> {
  const r = await systemDb.maybeOne(`SELECT * FROM integrations WHERE tenant_id = $1 AND kind = $2`, [tenantId, kind]);
  if (!r || !r.is_enabled) return null;
  let secrets = {};
  if (r.secrets_encrypted) { try { secrets = JSON.parse(decrypt(r.secrets_encrypted)); } catch { secrets = {}; } }
  return { kind, provider: r.provider, mode: r.mode, config: r.config ?? {}, secrets, enabled: r.is_enabled };
}

export async function markIntegrationHealth(tenantId: string, kind: IntegrationKind, ok: boolean, error?: string) {
  await systemDb.query(`UPDATE integrations SET status = $3, last_error = $4, last_checked_at = now() WHERE tenant_id = $1 AND kind = $2`,
    [tenantId, kind, ok ? 'ok' : 'error', error?.slice(0, 500) ?? null]);
}

/** Describes each provider's credentials so the UI can render configuration forms. */
export const PROVIDER_CATALOG: Record<IntegrationKind, { provider: string; label: string; config: string[]; secrets: string[]; docs: string }[]> = {
  email: [
    { provider: 'platform', label: 'NEXUS shared sender', config: ['fromName', 'replyTo'], secrets: [], docs: 'Sends from the NEXUS domain with your business name.' },
    { provider: 'smtp', label: 'Your SMTP server', config: ['host', 'port', 'user', 'fromAddress', 'fromName'], secrets: ['password'], docs: 'Any SMTP provider (Google Workspace, SES, Postmark, SendGrid SMTP).' },
  ],
  whatsapp: [
    { provider: 'meta_cloud', label: 'WhatsApp Business Cloud API (Meta)', config: ['phoneNumberId', 'businessAccountId', 'languageCode'],
      secrets: ['accessToken', 'appSecret', 'verifyToken'], docs: 'Official Meta Cloud API. Templates must be pre-approved in WhatsApp Manager.' },
  ],
  sms: [{ provider: 'twilio', label: 'Twilio SMS', config: ['accountSid', 'fromNumber'], secrets: ['authToken'], docs: 'Twilio Programmable Messaging.' }],
  payment: [
    { provider: 'test', label: 'Test gateway (sandbox)', config: [], secrets: [], docs: 'Simulated checkout for trials and demos. No money moves.' },
    { provider: 'razorpay', label: 'Razorpay (India: UPI, cards, netbanking)', config: ['keyId'], secrets: ['keySecret', 'webhookSecret'], docs: 'Webhook URL: /api/webhooks/payments/razorpay/{tenantId}' },
    { provider: 'stripe', label: 'Stripe (cards, SEPA, international)', config: ['publishableKey'], secrets: ['secretKey', 'webhookSecret'], docs: 'Webhook URL: /api/webhooks/payments/stripe/{tenantId}' },
  ],
  maps: [
    { provider: 'osm', label: 'OpenStreetMap (Nominatim)', config: [], secrets: [], docs: 'Free geocoding with fair-use limits; straight-line travel estimates.' },
    { provider: 'google', label: 'Google Maps Platform', config: [], secrets: ['apiKey'], docs: 'Geocoding API + Distance Matrix API.' },
  ],
  ai: [{ provider: 'platform', label: 'NEXUS AI (Claude)', config: [], secrets: [], docs: 'Uses the platform AI provider, subject to your plan quota.' }],
  storage: [{ provider: 'platform', label: 'NEXUS secure storage', config: [], secrets: [], docs: 'Private object storage managed by NEXUS.' }],
  einvoice: [
    { provider: 'in_sandbox', label: 'India e-invoice sandbox (no registration)', config: [], secrets: [],
      docs: 'Generates IRNs with the official algorithm and a TEST QR code, without contacting the IRP. For trials and training only: not valid for GST compliance.' },
    { provider: 'gsp', label: 'India e-invoice via your GSP', config: ['baseUrl', 'generatePath', 'cancelPath', 'gstin', 'clientId', 'username', 'apiKeyHeader'], secrets: ['apiKey', 'clientSecret', 'password'],
      docs: 'Registers invoices with the IRP through your GST Suvidha Provider (GSP). Paths and headers vary by GSP — test against the GSP sandbox first.' },
  ],
  peppol: [
    { provider: 'peppol_test', label: 'Peppol test (no transmission)', config: [], secrets: [], docs: 'Validates and records UBL documents as sent without transmitting them.' },
    { provider: 'peppol_http', label: 'Peppol Access Point (REST)', config: ['endpointUrl'], secrets: ['apiKey'],
      docs: 'POSTs Peppol BIS 3.0 / XRechnung UBL to your certified Access Point provider. Confirm the request format with your provider.' },
  ],
};

import { logger } from '../logger.js';
import type { TenantIntegration } from './registry.js';

export const messagingOutbox: { channel: string; to: string; body: string }[] = [];

/**
 * WhatsApp via the official Meta WhatsApp Business Cloud API only. Business-initiated messages
 * must use pre-approved templates; we send the template with the rendered body as a parameter.
 */
export async function sendWhatsApp(integration: TenantIntegration, to: string, body: string, templateName?: string | null) {
  const phone = to.replace(/[^\d]/g, '');
  if (integration.mode === 'test') {
    messagingOutbox.push({ channel: 'whatsapp', to: phone, body });
    logger.info({ to: phone }, '[whatsapp:test] message captured');
    return { provider: 'meta_cloud:test', messageId: `wa-test-${Date.now()}` };
  }
  const { phoneNumberId, languageCode = 'en' } = integration.config;
  const token = integration.secrets.accessToken;
  if (!phoneNumberId || !token) throw new Error('WhatsApp integration is missing phoneNumberId or accessToken');
  const payload = templateName
    ? { messaging_product: 'whatsapp', to: phone, type: 'template',
        template: { name: templateName, language: { code: languageCode }, components: [{ type: 'body', parameters: [{ type: 'text', text: body.slice(0, 1000) }] }] } }
    : { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: body.slice(0, 4096) } };
  const res = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phoneNumberId)}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(15000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`WhatsApp API ${res.status}: ${json?.error?.message ?? 'unknown error'}`);
  return { provider: 'meta_cloud', messageId: json?.messages?.[0]?.id ?? null };
}

export async function sendSms(integration: TenantIntegration, to: string, body: string) {
  if (integration.mode === 'test') {
    messagingOutbox.push({ channel: 'sms', to, body });
    return { provider: 'twilio:test', messageId: `sms-test-${Date.now()}` };
  }
  const { accountSid, fromNumber } = integration.config;
  const auth = Buffer.from(`${accountSid}:${integration.secrets.authToken}`).toString('base64');
  const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`, {
    method: 'POST', headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ To: to, From: fromNumber, Body: body.slice(0, 1600) }), signal: AbortSignal.timeout(15000),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Twilio ${res.status}: ${json?.message ?? 'unknown error'}`);
  return { provider: 'twilio', messageId: json.sid ?? null };
}

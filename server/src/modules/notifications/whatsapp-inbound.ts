import { systemDb, withTenant } from '../../db/pool.js';
import { getIntegration } from '../../integrations/registry.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import { normalizePhone } from '../common.js';
import { createServiceRequest } from '../requests/routes.js';
import { logger } from '../../logger.js';

export async function verifyWhatsAppSubscription(tenantId: string, q: Record<string, string>) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return null;
  const integ = await getIntegration(tenantId, 'whatsapp');
  if (!integ?.secrets.verifyToken || q['hub.mode'] !== 'subscribe' || !safeEqual(q['hub.verify_token'] ?? '', integ.secrets.verifyToken)) return null;
  return q['hub.challenge'] ?? '';
}

/**
 * Official WhatsApp Cloud API webhook: verifies X-Hub-Signature-256, updates delivery status of
 * outbound messages and turns inbound customer messages into service requests (source=whatsapp)
 * for human review. No unofficial automation is used.
 */
export async function handleWhatsAppWebhook(tenantId: string, raw: Buffer, signature?: string) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) return { status: 404, body: {} };
  const integ = await getIntegration(tenantId, 'whatsapp');
  if (!integ?.secrets.appSecret) return { status: 404, body: { error: 'WhatsApp not configured' } };
  const expected = `sha256=${hmacSha256Hex(integ.secrets.appSecret, raw)}`;
  if (!signature || !safeEqual(signature, expected)) return { status: 401, body: { error: 'Invalid signature' } };
  let payload: any; try { payload = JSON.parse(raw.toString('utf8')); } catch { return { status: 400, body: {} }; }
  for (const entry of payload.entry ?? []) for (const change of entry.changes ?? []) {
    const v = change.value ?? {};
    for (const st of v.statuses ?? []) {
      const map: Record<string, string> = { sent: 'sent', delivered: 'delivered', read: 'delivered', failed: 'failed' };
      if (map[st.status]) await systemDb.query(`UPDATE notification_logs SET status = $3, last_error = COALESCE($4, last_error) WHERE tenant_id = $1 AND provider_message_id = $2`,
        [tenantId, st.id, map[st.status], st.errors?.[0]?.title ?? null]);
    }
    for (const m of v.messages ?? []) {
      if (m.type !== 'text' || !m.text?.body || m.text.body.trim().length < 5) continue;
      const fresh = await systemDb.maybeOne(`INSERT INTO webhook_events (provider, event_id, event_type, tenant_id, payload, signature_valid) VALUES ('whatsapp',$1,'message',$2,$3,true)
        ON CONFLICT (provider, event_id) DO NOTHING RETURNING id`, [m.id, tenantId, JSON.stringify(m)]);
      if (!fresh) continue;
      const name = v.contacts?.find((c: any) => c.wa_id === m.from)?.profile?.name ?? 'WhatsApp customer';
      try {
        await withTenant(tenantId, async (db) => {
          const cust = await db.maybeOne(`SELECT id FROM customers WHERE phone_normalized = $1 AND archived_at IS NULL LIMIT 1`, [normalizePhone(m.from)]);
          await db.query(`INSERT INTO communications (tenant_id, customer_id, channel, direction, body) SELECT $1, $2, 'whatsapp', 'inbound', $3 WHERE $2::uuid IS NOT NULL`,
            [tenantId, cust?.id ?? null, m.text.body.slice(0, 5000)]);
          await createServiceRequest(db, null, { customerId: cust?.id ?? null, contactName: name, contactPhone: `+${m.from}`, description: m.text.body.slice(0, 5000),
            priority: 'normal', source: 'whatsapp' } as any);
        });
        await systemDb.query(`UPDATE webhook_events SET processed_at = now() WHERE provider = 'whatsapp' AND event_id = $1`, [m.id]);
      } catch (err) { logger.error({ err, tenantId }, 'whatsapp inbound failed'); }
    }
  }
  return { status: 200, body: { received: true } };
}

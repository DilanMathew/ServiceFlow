/**
 * Web Push (RFC 8030 + VAPID) for staff devices, mainly technicians' phones.
 * Keys come from VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY, or are generated once and stored in
 * platform_settings (private key encrypted with ENCRYPTION_KEY) so push works without setup.
 * Payloads carry only a title, short body and an in-app link — never customer contact details.
 */
import * as webpush from 'web-push';
import { config } from '../config.js';
import { systemDb } from '../db/pool.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { logger } from '../logger.js';

interface VapidKeys { publicKey: string; privateKey: string }
let keys: VapidKeys | null = null;

export async function ensureVapidKeys(): Promise<VapidKeys> {
  if (keys) return keys;
  if (config.VAPID_PUBLIC_KEY && config.VAPID_PRIVATE_KEY) {
    keys = { publicKey: config.VAPID_PUBLIC_KEY, privateKey: config.VAPID_PRIVATE_KEY };
  } else {
    const row = await systemDb.maybeOne(`SELECT value FROM platform_settings WHERE key = 'vapid_keys'`);
    if (row) keys = { publicKey: row.value.publicKey, privateKey: decrypt(row.value.privateKeyEnc) };
    else {
      const k = webpush.generateVAPIDKeys();
      // Concurrent boots: the first insert wins and everyone re-reads it.
      await systemDb.query(`INSERT INTO platform_settings (key, value) VALUES ('vapid_keys', $1) ON CONFLICT (key) DO NOTHING`,
        [{ publicKey: k.publicKey, privateKeyEnc: encrypt(k.privateKey) }]);
      const saved = await systemDb.one(`SELECT value FROM platform_settings WHERE key = 'vapid_keys'`);
      keys = { publicKey: saved.value.publicKey, privateKey: decrypt(saved.value.privateKeyEnc) };
      logger.info('generated VAPID keys for web push');
    }
  }
  return keys;
}

export function vapidPublicKey() { return keys?.publicKey ?? null; }

export interface PushTarget { endpoint: string; p256dh: string; auth: string }
export interface PushPayload { title: string; body?: string | null; link?: string | null; tag?: string }

export type PushResult = { ok: true } | { ok: false; gone: boolean; error: string };

/** Test hook: lets tests capture pushes instead of calling real push services. */
export const pushTestSink: Array<{ endpoint: string; payload: PushPayload }> = [];

export async function sendPush(target: PushTarget, payload: PushPayload): Promise<PushResult> {
  const k = await ensureVapidKeys();
  if (config.NODE_ENV === 'test' || target.endpoint.startsWith('https://push.test/')) {
    pushTestSink.push({ endpoint: target.endpoint, payload });
    return target.endpoint.includes('/gone') ? { ok: false, gone: true, error: 'gone' } : { ok: true };
  }
  try {
    await webpush.sendNotification({ endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
      JSON.stringify(payload), {
        vapidDetails: { subject: config.VAPID_SUBJECT ?? `mailto:${config.PLATFORM_ADMIN_EMAIL ?? 'admin@example.com'}`, publicKey: k.publicKey, privateKey: k.privateKey },
        TTL: 60 * 60 * 12, urgency: 'high', timeout: 10_000,
      });
    return { ok: true };
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    return { ok: false, gone: status === 404 || status === 410, error: `${status ?? ''} ${(err as Error).message}`.trim().slice(0, 300) };
  }
}

/** Only https endpoints on the public internet are accepted (prevents using push as an SSRF vector). */
export function isAllowedPushEndpoint(endpoint: string) {
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|\[?f[cd])/i.test(u.hostname)) return false;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname)) return false;
    return true;
  } catch { return false; }
}

import type { Db } from '../../db/pool.js';
import { enqueue } from '../../jobs/queue.js';
import { renderTemplate, type NotificationEvent } from './templates.js';

type Channel = 'email' | 'whatsapp' | 'sms';
export interface NotifyInput {
  event: NotificationEvent;
  customerId?: string | null;
  recipient?: { email?: string | null; phone?: string | null; name?: string | null }; // for non-customer recipients (e.g. leads)
  entityType?: string;
  entityId?: string;
  vars: Record<string, unknown>;
  staffUserIds?: string[];                 // in-app notifications for staff
  inApp?: { title: string; body?: string; link?: string };
  dedupeKey?: string;
  channels?: Channel[];                    // restrict channels
}

const DEFAULT_PREFS: Record<Channel, boolean> = { email: true, whatsapp: true, sms: false };

/**
 * Queue customer notifications and staff in-app alerts. Runs inside the caller's transaction but
 * never sends synchronously, so a failing provider can never roll back or block the business change.
 */
export async function notify(db: Db, n: NotifyInput) {
  const tenant = await db.one(`SELECT t.name, t.phone, t.email, s.notification_preferences FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = $1`, [db.tenantId]);
  const vars = { ...n.vars, business: { name: tenant.name, phone: tenant.phone, email: tenant.email, ...(n.vars.business as object ?? {}) } };

  if (n.staffUserIds?.length && n.inApp) {
    for (const uid of [...new Set(n.staffUserIds)]) {
      await db.query(`INSERT INTO notifications (tenant_id, user_id, event, title, body, link) VALUES ($1,$2,$3,$4,$5,$6)`,
        [db.tenantId, uid, n.event, n.inApp.title, n.inApp.body ?? null, n.inApp.link ?? null]);
    }
  }

  let recipient = n.recipient ?? null;
  let optOut: Record<string, boolean> = {};
  if (n.customerId) {
    const c = await db.maybeOne(`SELECT full_name, email, phone, notification_opt_out FROM customers WHERE id = $1 AND anonymized_at IS NULL`, [n.customerId]);
    if (c) { recipient = { email: c.email, phone: c.phone, name: c.full_name }; optOut = c.notification_opt_out ?? {}; }
  }
  if (!recipient) return;
  (vars as any).customer = { name: recipient.name ?? 'there', ...((n.vars.customer as object) ?? {}) };

  const prefs = { ...DEFAULT_PREFS, ...(tenant.notification_preferences?.[n.event] ?? {}) };
  const channels = (n.channels ?? (['email', 'whatsapp', 'sms'] as Channel[])).filter((c) => prefs[c] && !optOut[c]);
  for (const channel of channels) {
    const to = channel === 'email' ? recipient.email : recipient.phone;
    if (!to) continue;
    const tpl = await db.maybeOne(
      `SELECT subject, body, whatsapp_template_name FROM notification_templates WHERE event = $1 AND channel = $2 AND is_active
        AND (tenant_id = $3 OR tenant_id IS NULL) ORDER BY tenant_id NULLS LAST LIMIT 1`, [n.event, channel, db.tenantId]);
    if (!tpl) continue;
    const log = await db.maybeOne(
      `INSERT INTO notification_logs (tenant_id, event, channel, recipient, customer_id, entity_type, entity_id, subject, body, dedupe_key)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING RETURNING id`,
      [db.tenantId, n.event, channel, to, n.customerId ?? null, n.entityType ?? null, n.entityId ?? null,
        tpl.subject ? renderTemplate(tpl.subject, vars) : null, renderTemplate(tpl.body, vars),
        n.dedupeKey ? `${n.dedupeKey}:${channel}` : null]);
    if (log) await enqueue(db, 'deliver_notification', { logId: log.id, whatsappTemplate: tpl.whatsapp_template_name }, { maxAttempts: 5 });
  }
}

/** Staff users holding any of the given permissions (for routing in-app alerts). */
export async function staffWithPermission(db: Db, ...perms: string[]): Promise<string[]> {
  const rows = await db.many(
    `SELECT DISTINCT u.id FROM users u JOIN user_roles ur ON ur.user_id = u.id JOIN role_permissions rp ON rp.role_id = ur.role_id
      WHERE u.is_active AND u.user_type = 'staff' AND rp.permission_code = ANY($1)`, [perms]);
  return rows.map((r) => r.id);
}

import { systemDb, withTenant } from '../db/pool.js';
import { registerHandler } from './queue.js';
import { sendEmail, simpleHtml } from '../integrations/email.js';
import { sendSms, sendWhatsApp } from '../integrations/messaging.js';
import { getIntegration, markIntegrationHealth } from '../integrations/registry.js';
import { sendPush } from '../integrations/push.js';
import { autoEinvoice } from '../modules/einvoice/service.js';
import { AppError } from '../lib/errors.js';
import { notifyStaff, staffWithPermission } from '../modules/notifications/service.js';

export function registerJobHandlers() {
  registerHandler('send_system_email', async (job) => {
    const { to, subject, text } = job.payload;
    await sendEmail({ to, subject, text, html: simpleHtml(subject, text) });
  });

  registerHandler('deliver_notification', async (job) => {
    const tenantId = job.tenant_id!;
    const log = await systemDb.maybeOne(`SELECT * FROM notification_logs WHERE id = $1 AND tenant_id = $2`, [job.payload.logId, tenantId]);
    if (!log || ['sent', 'delivered', 'skipped'].includes(log.status)) return;
    await systemDb.query(`UPDATE notification_logs SET status = 'sending', attempts = attempts + 1 WHERE id = $1`, [log.id]);
    try {
      let result: { provider: string; messageId: string | null };
      if (log.channel === 'email') {
        const integ = await getIntegration(tenantId, 'email');
        const t = await systemDb.one(`SELECT name, email FROM tenants WHERE id = $1`, [tenantId]);
        result = await sendEmail({ to: log.recipient, subject: log.subject ?? t.name, text: log.body, html: simpleHtml(log.subject ?? '', log.body, t.name),
          fromName: t.name, replyTo: t.email ?? undefined }, integ);
      } else {
        const integ = await getIntegration(tenantId, log.channel);
        if (!integ) {
          await systemDb.query(`UPDATE notification_logs SET status = 'skipped', last_error = $2 WHERE id = $1`, [log.id, `${log.channel} integration not configured`]);
          return;
        }
        result = log.channel === 'whatsapp'
          ? await sendWhatsApp(integ, log.recipient, log.body, job.payload.whatsappTemplate)
          : await sendSms(integ, log.recipient, log.body);
        await markIntegrationHealth(tenantId, log.channel, true);
      }
      await systemDb.query(`UPDATE notification_logs SET status = 'sent', sent_at = now(), provider = $2, provider_message_id = $3, last_error = NULL WHERE id = $1`,
        [log.id, result.provider, result.messageId]);
      if (log.customer_id) {
        await withTenant(tenantId, (db) => db.query(
          `INSERT INTO communications (tenant_id, customer_id, channel, direction, subject, body, notification_log_id) VALUES ($1,$2,$3,'outbound',$4,$5,$6)`,
          [tenantId, log.customer_id, log.channel, log.subject, log.body, log.id]));
      }
    } catch (err) {
      const msg = (err as Error).message;
      await systemDb.query(`UPDATE notification_logs SET status = 'failed', last_error = $2 WHERE id = $1`, [log.id, msg.slice(0, 500)]);
      if (log.channel !== 'email') await markIntegrationHealth(tenantId, log.channel, false, msg);
      throw err; // queue retries with backoff
    }
  });

  // Web push for one in-app notification to every device of its user. Dead endpoints are pruned;
  // transient failures retry (only devices that have not yet succeeded are retried).
  registerHandler('deliver_push', async (job) => {
    const tenantId = job.tenant_id!;
    const n = await systemDb.maybeOne(`SELECT id, user_id, event, title, body, link, read_at FROM notifications WHERE id = $1 AND tenant_id = $2`, [job.payload.notificationId, tenantId]);
    if (!n || n.read_at) return;
    const done: string[] = job.payload.done ?? [];
    const subs = await systemDb.many(`SELECT id, endpoint, p256dh, auth, failure_count FROM push_subscriptions WHERE tenant_id = $1 AND user_id = $2`, [tenantId, n.user_id]);
    let transient = 0;
    for (const sub of subs.filter((x) => !done.includes(x.id))) {
      const r = await sendPush(sub, { title: n.title, body: n.body, link: n.link, tag: `${n.event}:${n.id}` });
      if (r.ok) {
        done.push(sub.id);
        await systemDb.query(`UPDATE push_subscriptions SET failure_count = 0, last_success_at = now() WHERE id = $1`, [sub.id]);
      } else if (r.gone || sub.failure_count >= 9) {
        await systemDb.query(`DELETE FROM push_subscriptions WHERE id = $1`, [sub.id]);
      } else {
        transient++;
        await systemDb.query(`UPDATE push_subscriptions SET failure_count = failure_count + 1 WHERE id = $1`, [sub.id]);
      }
    }
    if (transient) {
      job.payload.done = done;
      await systemDb.query(`UPDATE background_jobs SET payload = $2 WHERE id = $1`, [job.id, job.payload]);
      throw new Error(`push failed for ${transient} device(s)`);
    }
  });

  // Automatic e-invoicing after an invoice / credit note is issued. Data problems are reported to the
  // billing team in-app (no retry); provider outages retry with backoff.
  registerHandler('einvoice_auto', async (job) => {
    const tenantId = job.tenant_id!;
    const { invoiceId, creditNoteId } = job.payload;
    try {
      await autoEinvoice(tenantId, invoiceId, creditNoteId ?? null);
    } catch (e) {
      const dataProblem = e instanceof AppError && e.status < 500;
      const lastTry = job.attempts >= 5;
      if (dataProblem || lastTry) {
        await withTenant(tenantId, async (db) => {
          const inv = await db.one(`SELECT number FROM invoices WHERE id = $1`, [invoiceId]);
          for (const uid of await staffWithPermission(db, 'invoices.manage')) {
            await notifyStaff(db, uid, 'einvoice.failed', { title: `E-invoice needs attention: ${inv.number}`, body: (e as Error).message.slice(0, 200), link: `/app/invoices/${invoiceId}` });
          }
        });
        if (dataProblem) return;
      }
      throw e;
    }
  });
}

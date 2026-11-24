import { systemDb, withTenant } from '../db/pool.js';
import { registerHandler } from './queue.js';
import { sendEmail, simpleHtml } from '../integrations/email.js';
import { sendSms, sendWhatsApp } from '../integrations/messaging.js';
import { getIntegration, markIntegrationHealth } from '../integrations/registry.js';

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
}

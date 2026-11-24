import { pool, systemDb, withTenant } from '../db/pool.js';
import { logger } from '../logger.js';
import { createVisitWorkOrder } from '../modules/amc/routes.js';
import { recomputeInvoice } from '../modules/invoices/service.js';
import { notify, staffWithPermission } from '../modules/notifications/service.js';
import { runSubscriptionLifecycle } from '../modules/subscriptions/billing.js';
import { fmtDateTime } from '../modules/common.js';
import { config } from '../config.js';

type Task = { name: string; everyMin: number; run: () => Promise<void> };
let timer: NodeJS.Timeout | null = null;
const lastRun = new Map<string, number>();

/** Runs fn once cluster-wide: other replicas skip while the advisory lock is held. */
async function exclusive(name: string, fn: () => Promise<void>) {
  const client = await pool.connect();
  try {
    const { rows } = await client.query(`SELECT pg_try_advisory_lock(hashtext($1)) AS ok`, [`sched:${name}`]);
    if (!rows[0].ok) return;
    try { await fn(); } finally { await client.query(`SELECT pg_advisory_unlock(hashtext($1))`, [`sched:${name}`]); }
  } finally { client.release(); }
}

async function forEachTenant(fn: (tenantId: string) => Promise<void>) {
  for (const t of await systemDb.many(`SELECT id FROM tenants WHERE status = 'active'`)) {
    try { await fn(t.id); } catch (err) { logger.error({ err, tenant: t.id }, 'scheduled tenant task failed'); }
  }
}

export const TASKS: Task[] = [
  { name: 'amc_visits', everyMin: 30, run: () => forEachTenant(async (tid) => {
    const visits = await withTenant(tid, (db) => db.many(`SELECT v.id FROM scheduled_visits v JOIN amc_contracts m ON m.id = v.contract_id
      WHERE m.status = 'active' AND v.status = 'scheduled' AND v.work_order_id IS NULL AND v.due_date <= current_date + 14`));
    for (const v of visits) await withTenant(tid, (db) => createVisitWorkOrder(db, null, v.id));
    await withTenant(tid, async (db) => {
      for (const v of await db.many(`SELECT v.id, v.due_date, m.number, m.customer_id FROM scheduled_visits v JOIN amc_contracts m ON m.id = v.contract_id
        WHERE m.status = 'active' AND v.status IN ('scheduled','work_order_created') AND v.due_date = current_date + 7`)) {
        await notify(db, { event: 'amc.visit_upcoming', customerId: v.customer_id, entityType: 'amc_contract', dedupeKey: `amc-visit:${v.id}`, vars: { amc: { number: v.number }, visit: { due_date: v.due_date } } });
      }
      await db.query(`UPDATE amc_contracts SET status = 'expired' WHERE status = 'active' AND end_date < current_date`);
      for (const m of await db.many(`SELECT id, number, end_date, customer_id FROM amc_contracts WHERE status = 'active' AND renewal_reminder_sent_at IS NULL
        AND end_date <= current_date + renewal_reminder_days AND NOT EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = amc_contracts.id)`)) {
        await notify(db, { event: 'amc.expiring', customerId: m.customer_id, entityType: 'amc_contract', entityId: m.id, dedupeKey: `amc-expiring:${m.id}`,
          vars: { amc: { number: m.number, end_date: m.end_date } }, staffUserIds: await staffWithPermission(db, 'amc.manage'),
          inApp: { title: `AMC ${m.number} expires ${m.end_date}`, body: 'Create a renewal quotation', link: `/app/amc/${m.id}` } });
        await db.query(`UPDATE amc_contracts SET renewal_reminder_sent_at = now() WHERE id = $1`, [m.id]);
      }
    });
  }) },
  { name: 'invoices_overdue', everyMin: 60, run: () => forEachTenant(async (tid) => {
    const due = await withTenant(tid, (db) => db.many(`SELECT id FROM invoices WHERE status IN ('issued','partially_paid') AND due_date < current_date`));
    for (const i of due) await withTenant(tid, (db) => recomputeInvoice(db, null, i.id));
  }) },
  { name: 'quotations_expire', everyMin: 60, run: () => forEachTenant((tid) => withTenant(tid, async (db) => {
    await db.query(`UPDATE quotations SET status = 'expired' WHERE status IN ('sent','viewed') AND valid_until < current_date`);
  })) },
  { name: 'job_reminders', everyMin: 30, run: () => forEachTenant((tid) => withTenant(tid, async (db) => {
    const s = await db.one(`SELECT timezone, locale FROM tenant_settings WHERE tenant_id = $1`, [tid]);
    const jobs = await db.many(`SELECT w.id, w.number, w.customer_id, w.scheduled_start, u.full_name AS tech FROM work_orders w LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id
      LEFT JOIN users u ON u.id = tp.user_id WHERE w.status IN ('scheduled','assigned') AND (w.scheduled_start AT TIME ZONE $1)::date = (now() AT TIME ZONE $1)::date + 1`, [s.timezone]);
    for (const j of jobs) await notify(db, { event: 'job.reminder', customerId: j.customer_id, entityType: 'work_order', entityId: j.id, dedupeKey: `reminder:${j.id}:${new Date(j.scheduled_start).toISOString().slice(0, 10)}`,
      vars: { job: { number: j.number, scheduled: fmtDateTime(j.scheduled_start, s.timezone, s.locale) }, technician: { name: j.tech ?? 'our technician' } } });
  })) },
  { name: 'low_stock', everyMin: 24 * 60, run: () => forEachTenant((tid) => withTenant(tid, async (db) => {
    const s = await db.one(`SELECT inventory_enabled FROM tenant_settings WHERE tenant_id = $1`, [tid]);
    if (!s.inventory_enabled) return;
    const low = await db.many(`SELECT i.name FROM inventory_items i LEFT JOIN inventory_stock st ON st.item_id = i.id WHERE i.is_active AND i.min_stock > 0
      GROUP BY i.id HAVING COALESCE(sum(st.quantity),0) <= i.min_stock`);
    if (!low.length) return;
    const users = await staffWithPermission(db, 'inventory.manage');
    for (const u of users) await db.query(`INSERT INTO notifications (tenant_id, user_id, event, title, body, link) VALUES ($1,$2,'inventory.low_stock',$3,$4,'/app/inventory?lowStock=1')`,
      [tid, u, `${low.length} item(s) low on stock`, low.slice(0, 5).map((x) => x.name).join(', ')]);
  })) },
  { name: 'subscriptions', everyMin: 60, run: runSubscriptionLifecycle },
  { name: 'cleanup', everyMin: 24 * 60, run: async () => {
    await systemDb.query(`DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR expires_at < now() - interval '30 days'`);
    await systemDb.query(`DELETE FROM auth_tokens WHERE expires_at < now() - interval '7 days'`);
    await systemDb.query(`DELETE FROM background_jobs WHERE status = 'succeeded' AND completed_at < now() - interval '14 days'`);
  } },
];

export function startScheduler() {
  if (timer || config.NODE_ENV === 'test') return;
  const tick = async () => {
    for (const t of TASKS) {
      if (Date.now() - (lastRun.get(t.name) ?? 0) < t.everyMin * 60_000) continue;
      lastRun.set(t.name, Date.now());
      exclusive(t.name, t.run).catch((err) => logger.error({ err, task: t.name }, 'scheduled task failed'));
    }
  };
  setTimeout(tick, 10_000);
  timer = setInterval(tick, 60_000);
}
export function stopScheduler() { if (timer) clearInterval(timer); timer = null; }

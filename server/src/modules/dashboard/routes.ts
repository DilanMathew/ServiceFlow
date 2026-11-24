import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, parse } from '../../lib/http.js';
import { tx, branchScope } from '../common.js';
import type { Db } from '../../db/pool.js';

export const dashboardRouter = Router();

/** Resolves a named period into [from, to) timestamps in the tenant's time zone. */
export async function resolvePeriod(db: Db, period: string, from?: string, to?: string) {
  const tz = (await db.one(`SELECT timezone FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId])).timezone;
  const exprs: Record<string, [string, string]> = {
    today: [`date_trunc('day', now() AT TIME ZONE $1)`, `date_trunc('day', now() AT TIME ZONE $1) + interval '1 day'`],
    week: [`date_trunc('week', now() AT TIME ZONE $1)`, `date_trunc('week', now() AT TIME ZONE $1) + interval '1 week'`],
    month: [`date_trunc('month', now() AT TIME ZONE $1)`, `date_trunc('month', now() AT TIME ZONE $1) + interval '1 month'`],
    last_month: [`date_trunc('month', now() AT TIME ZONE $1) - interval '1 month'`, `date_trunc('month', now() AT TIME ZONE $1)`],
    quarter: [`date_trunc('quarter', now() AT TIME ZONE $1)`, `date_trunc('quarter', now() AT TIME ZONE $1) + interval '3 months'`],
    year: [`date_trunc('year', now() AT TIME ZONE $1)`, `date_trunc('year', now() AT TIME ZONE $1) + interval '1 year'`],
  };
  if (period === 'custom' && from && to) {
    const r = await db.one(`SELECT ($2::date::timestamp AT TIME ZONE $1) AS f, (($3::date + 1)::timestamp AT TIME ZONE $1) AS t`, [tz, from, to]);
    return { from: r.f as Date, to: r.t as Date, tz };
  }
  const [f, t] = exprs[period] ?? exprs.month;
  const r = await db.one(`SELECT (${f}) AT TIME ZONE $1 AS f, (${t}) AT TIME ZONE $1 AS t`, [tz]);
  return { from: r.f as Date, to: r.t as Date, tz };
}

dashboardRouter.get('/', requirePermission('dashboard.view'), ah(async (req, res) => {
  const q = parse(z.object({ period: z.enum(['today', 'week', 'month', 'last_month', 'quarter', 'year', 'custom']).default('month'), from: dateStr.optional(), to: dateStr.optional() }), req.query);
  const fin = req.auth!.permissions.has('reports.financial') || req.auth!.permissions.has('invoices.read');
  const b = branchScope(req);
  const data = await tx(req, async (db) => {
    const p = await resolvePeriod(db, q.period, q.from, q.to);
    const P = [p.from, p.to, b];
    const bw = `($3::uuid IS NULL OR branch_id = $3)`;
    const kpi = await db.one(`SELECT
        (SELECT count(*) FROM service_requests WHERE created_at >= $1 AND created_at < $2 AND ${bw})::int AS total_requests,
        (SELECT count(*) FROM service_requests WHERE status IN ('new','under_review') AND ${bw})::int AS new_requests,
        (SELECT count(*) FROM work_orders WHERE status IN ('new','approved','scheduled') AND ${bw})::int AS pending_jobs,
        (SELECT count(*) FROM work_orders WHERE status IN ('assigned','en_route') AND ${bw})::int AS assigned_jobs,
        (SELECT count(*) FROM work_orders WHERE status IN ('in_progress','on_hold') AND ${bw})::int AS in_progress_jobs,
        (SELECT count(*) FROM work_orders WHERE status IN ('completed','invoiced','paid') AND actual_end >= $1 AND actual_end < $2 AND ${bw})::int AS completed_jobs,
        (SELECT count(*) FROM work_orders WHERE status IN ('cancelled','rejected') AND updated_at >= $1 AND updated_at < $2 AND ${bw})::int AS cancelled_jobs,
        (SELECT count(*) FROM amc_contracts WHERE status = 'active' AND ${bw})::int AS active_amc,
        (SELECT count(*) FROM scheduled_visits v JOIN amc_contracts m ON m.id = v.contract_id WHERE m.status = 'active' AND v.status IN ('scheduled','work_order_created')
           AND v.due_date <= current_date + 30 AND ($3::uuid IS NULL OR m.branch_id = $3))::int AS upcoming_visits,
        (SELECT count(*) FROM customers WHERE created_at >= $1 AND created_at < $2)::int AS new_customers`, P);
    const money = fin ? await db.one(`SELECT
        (SELECT COALESCE(sum(total),0) FROM invoices WHERE status NOT IN ('draft','cancelled') AND issued_at >= $1 AND issued_at < $2 AND ${bw}) AS invoiced,
        (SELECT COALESCE(sum(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.status = 'succeeded' AND p.received_at >= $1 AND p.received_at < $2 AND ($3::uuid IS NULL OR i.branch_id = $3))
          - (SELECT COALESCE(sum(r.amount),0) FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE r.status = 'succeeded' AND r.created_at >= $1 AND r.created_at < $2 AND ($3::uuid IS NULL OR i.branch_id = $3)) AS collected,
        (SELECT COALESCE(sum(balance_due),0) FROM invoices WHERE status IN ('issued','partially_paid','overdue') AND ${bw}) AS outstanding,
        (SELECT COALESCE(sum(balance_due),0) FROM invoices WHERE status IN ('issued','partially_paid','overdue') AND due_date < current_date AND ${bw}) AS overdue,
        (SELECT COALESCE(sum(estimated_cost),0) FROM work_orders WHERE status IN ('new','approved','scheduled','assigned','en_route','in_progress','on_hold','completed') AND ${bw}) AS pipeline_estimate,
        (SELECT currency FROM tenant_settings WHERE tenant_id = current_tenant_id()) AS currency`, P) : null;
    const charts: Record<string, unknown> = {};
    charts.jobsByStatus = await db.many(`SELECT status, count(*)::int AS count FROM work_orders WHERE (created_at >= $1 AND created_at < $2 OR status IN ('new','approved','scheduled','assigned','en_route','in_progress','on_hold')) AND ${bw} GROUP BY status ORDER BY count DESC`, P);
    charts.jobsByCategory = await db.many(`SELECT COALESCE(sc.name, 'Uncategorised') AS category, count(*)::int AS count FROM work_orders w LEFT JOIN service_categories sc ON sc.id = w.service_category_id
      WHERE w.created_at >= $1 AND w.created_at < $2 AND ($3::uuid IS NULL OR w.branch_id = $3) GROUP BY 1 ORDER BY 2 DESC LIMIT 10`, P);
    charts.technicianPerformance = await db.many(`SELECT u.full_name AS technician, count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid'))::int AS completed,
        count(*) FILTER (WHERE w.status IN ('assigned','en_route','in_progress','on_hold'))::int AS open, round(avg(f.technician_rating),1) AS rating
      FROM technician_profiles tp JOIN users u ON u.id = tp.user_id LEFT JOIN work_orders w ON w.assigned_technician_id = tp.id AND (w.actual_end >= $1 AND w.actual_end < $2 OR w.status IN ('assigned','en_route','in_progress','on_hold'))
      LEFT JOIN customer_feedback f ON f.work_order_id = w.id WHERE u.is_active AND ($3::uuid IS NULL OR tp.branch_id = $3) GROUP BY u.full_name ORDER BY completed DESC LIMIT 12`, P);
    charts.customerGrowth = await db.many(`SELECT to_char(m, 'YYYY-MM') AS month, (SELECT count(*) FROM customers c WHERE date_trunc('month', c.created_at AT TIME ZONE $1) = m)::int AS new_customers,
        (SELECT count(*) FROM customers c WHERE c.created_at AT TIME ZONE $1 < m + interval '1 month')::int AS total
      FROM generate_series(date_trunc('month', now() AT TIME ZONE $1) - interval '11 months', date_trunc('month', now() AT TIME ZONE $1), interval '1 month') m`, [p.tz]);
    if (fin) {
      charts.revenueByMonth = await db.many(`SELECT to_char(m, 'YYYY-MM') AS month,
          (SELECT COALESCE(sum(total),0) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc('month', i.issued_at AT TIME ZONE $1) = m AND ($2::uuid IS NULL OR i.branch_id = $2)) AS invoiced,
          (SELECT COALESCE(sum(p.amount),0) FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.status = 'succeeded' AND date_trunc('month', p.received_at AT TIME ZONE $1) = m AND ($2::uuid IS NULL OR i.branch_id = $2)) AS collected
        FROM generate_series(date_trunc('month', now() AT TIME ZONE $1) - interval '11 months', date_trunc('month', now() AT TIME ZONE $1), interval '1 month') m`, [p.tz, b]);
      charts.paymentMethods = await db.many(`SELECT method, count(*)::int AS count, sum(amount) AS amount FROM payments WHERE status = 'succeeded' AND received_at >= $1 AND received_at < $2 GROUP BY method ORDER BY amount DESC`, [p.from, p.to]);
      charts.outstandingAging = await db.one(`SELECT
          COALESCE(sum(balance_due) FILTER (WHERE due_date >= current_date),0) AS current,
          COALESCE(sum(balance_due) FILTER (WHERE due_date < current_date AND due_date >= current_date - 30),0) AS d1_30,
          COALESCE(sum(balance_due) FILTER (WHERE due_date < current_date - 30 AND due_date >= current_date - 60),0) AS d31_60,
          COALESCE(sum(balance_due) FILTER (WHERE due_date < current_date - 60 AND due_date >= current_date - 90),0) AS d61_90,
          COALESCE(sum(balance_due) FILTER (WHERE due_date < current_date - 90),0) AS d90_plus
        FROM invoices WHERE status IN ('issued','partially_paid','overdue') AND ($1::uuid IS NULL OR branch_id = $1)`, [b]);
    }
    const upcoming = await db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, c.full_name AS customer_name, u.full_name AS technician_name
      FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
      WHERE w.scheduled_start >= now() AND w.status IN ('scheduled','assigned','en_route','approved') AND ($1::uuid IS NULL OR w.branch_id = $1) ORDER BY w.scheduled_start LIMIT 8`, [b]);
    const activity = await db.many(`SELECT a.action, a.entity_type, a.entity_id, a.user_email, a.created_at, a.after_data FROM audit_logs a
      WHERE a.tenant_id = current_tenant_id() AND a.action NOT LIKE 'auth.%' ORDER BY a.created_at DESC LIMIT 12`);
    const alerts: { level: 'info' | 'warning' | 'critical'; message: string; link: string }[] = [];
    const al = await db.one(`SELECT
        (SELECT count(*) FROM work_orders WHERE priority = 'urgent' AND assigned_technician_id IS NULL AND status IN ('new','approved','scheduled'))::int AS urgent_unassigned,
        (SELECT count(*) FROM work_orders WHERE scheduled_start < now() - interval '1 hour' AND status IN ('scheduled','assigned','en_route'))::int AS overdue_jobs,
        (SELECT count(*) FROM invoices WHERE status IN ('issued','partially_paid','overdue') AND due_date < current_date)::int AS overdue_invoices,
        (SELECT count(*) FROM amc_contracts WHERE status = 'active' AND end_date <= current_date + renewal_reminder_days AND NOT EXISTS (SELECT 1 FROM amc_contracts r WHERE r.renewed_from_id = amc_contracts.id))::int AS expiring_amc,
        (SELECT count(*) FROM (SELECT i.id FROM inventory_items i LEFT JOIN inventory_stock s ON s.item_id = i.id WHERE i.is_active GROUP BY i.id HAVING COALESCE(sum(s.quantity),0) <= i.min_stock AND i.min_stock > 0) x)::int AS low_stock,
        (SELECT count(*) FROM notification_logs WHERE status = 'failed' AND created_at > now() - interval '7 days')::int AS failed_notifications,
        (SELECT count(*) FROM customer_feedback WHERE rating <= 2 AND review_status = 'pending')::int AS negative_feedback,
        (SELECT count(*) FROM service_requests WHERE status = 'new' AND created_at < now() - interval '24 hours')::int AS stale_requests`);
    if (al.urgent_unassigned) alerts.push({ level: 'critical', message: `${al.urgent_unassigned} urgent job(s) are not assigned`, link: '/app/dispatch' });
    if (al.overdue_jobs) alerts.push({ level: 'warning', message: `${al.overdue_jobs} job(s) are past their scheduled time`, link: '/app/work-orders?overdue=1' });
    if (fin && al.overdue_invoices) alerts.push({ level: 'warning', message: `${al.overdue_invoices} invoice(s) are overdue`, link: '/app/invoices?overdue=1' });
    if (al.expiring_amc) alerts.push({ level: 'info', message: `${al.expiring_amc} AMC contract(s) are due for renewal`, link: '/app/amc?expiring=1' });
    if (al.low_stock) alerts.push({ level: 'warning', message: `${al.low_stock} inventory item(s) are at or below minimum stock`, link: '/app/inventory?lowStock=1' });
    if (al.failed_notifications) alerts.push({ level: 'warning', message: `${al.failed_notifications} notification(s) failed to send this week`, link: '/app/communications' });
    if (al.negative_feedback) alerts.push({ level: 'warning', message: `${al.negative_feedback} negative review(s) need attention`, link: '/app/support?tab=feedback' });
    if (al.stale_requests) alerts.push({ level: 'info', message: `${al.stale_requests} service request(s) waiting more than 24h`, link: '/app/requests?status=new' });
    return { period: { name: q.period, from: p.from, to: p.to, timezone: p.tz }, kpi, money, charts, upcoming, activity, alerts };
  });
  res.json({ data });
}));

import { Router, type Request } from 'express';
import { z } from 'zod';
import { ah, dateStr, parse, toCsv } from '../../lib/http.js';
import { AppError, forbidden, notFound } from '../../lib/errors.js';
import { tx, tenantSettings } from '../common.js';
import { getEntitlements } from '../subscriptions/entitlements.js';
import { renderSheetPdf } from '../../lib/pdf.js';
import type { Db } from '../../db/pool.js';

export const reportsRouter = Router();

interface Filters { from: string; to: string; technicianId?: string; customerId?: string; categoryId?: string; branchId?: string; groupBy: 'day' | 'week' | 'month' }
interface ReportDef {
  title: string; description: string; financial: boolean; advanced: boolean;
  columns: { key: string; label: string; type?: 'money' | 'number' | 'date' | 'text' | 'percent' }[];
  run: (db: Db, f: Filters, tz: string) => Promise<{ rows: any[]; summary?: Record<string, unknown>; notes?: string }>;
}

const range = `($1::date::timestamp AT TIME ZONE $3) AND (($2::date + 1)::timestamp AT TIME ZONE $3)`;

export const REPORTS: Record<string, ReportDef> = {
  revenue: { title: 'Revenue report', description: 'Invoiced revenue (issued invoices), tax and amounts actually collected, by period.', financial: true, advanced: false,
    columns: [{ key: 'period', label: 'Period' }, { key: 'invoices', label: 'Invoices', type: 'number' }, { key: 'subtotal', label: 'Net invoiced', type: 'money' },
      { key: 'tax', label: 'Tax', type: 'money' }, { key: 'invoiced', label: 'Gross invoiced', type: 'money' }, { key: 'collected', label: 'Collected (payments)', type: 'money' }, { key: 'refunded', label: 'Refunded', type: 'money' }],
    run: async (db, f, tz) => {
      const rows = await db.many(`WITH periods AS (SELECT generate_series(date_trunc($4, $1::date::timestamp), date_trunc($4, $2::date::timestamp), ('1 ' || $4)::interval) AS p)
        SELECT to_char(p, CASE WHEN $4 = 'month' THEN 'YYYY-MM' ELSE 'YYYY-MM-DD' END) AS period,
          (SELECT count(*) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc($4, i.issued_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5))::int AS invoices,
          (SELECT COALESCE(sum(subtotal - discount_total),0) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc($4, i.issued_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5)) AS subtotal,
          (SELECT COALESCE(sum(tax_total),0) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc($4, i.issued_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5)) AS tax,
          (SELECT COALESCE(sum(total),0) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc($4, i.issued_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5)) AS invoiced,
          (SELECT COALESCE(sum(x.amount),0) FROM payments x JOIN invoices i ON i.id = x.invoice_id WHERE x.status = 'succeeded' AND date_trunc($4, x.received_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5)) AS collected,
          (SELECT COALESCE(sum(r.amount),0) FROM refunds r JOIN invoices i ON i.id = r.invoice_id WHERE r.status = 'succeeded' AND date_trunc($4, r.created_at AT TIME ZONE $3) = p AND ($5::uuid IS NULL OR i.branch_id = $5)) AS refunded
        FROM periods ORDER BY p`, [f.from, f.to, tz, f.groupBy, f.branchId ?? null]);
      const sum = (k: string) => rows.reduce((a, r) => a + Number(r[k]), 0);
      return { rows, summary: { invoiced: sum('invoiced'), collected: sum('collected'), refunded: sum('refunded'), tax: sum('tax') },
        notes: 'Invoiced = issued invoices (accrual). Collected = successful payments received (cash basis). Estimated job values are excluded.' };
    } },
  monthly_revenue: { title: 'Monthly revenue', description: 'Twelve-month comparison of invoiced, collected and estimated pipeline value.', financial: true, advanced: false,
    columns: [{ key: 'month', label: 'Month' }, { key: 'invoiced', label: 'Invoiced', type: 'money' }, { key: 'collected', label: 'Collected', type: 'money' },
      { key: 'net_collected', label: 'Net of refunds', type: 'money' }, { key: 'estimated', label: 'Estimated (jobs scheduled)', type: 'money' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT to_char(m, 'YYYY-MM') AS month,
        (SELECT COALESCE(sum(total),0) FROM invoices i WHERE i.status NOT IN ('draft','cancelled') AND date_trunc('month', i.issued_at AT TIME ZONE $1) = m) AS invoiced,
        (SELECT COALESCE(sum(amount),0) FROM payments p WHERE p.status = 'succeeded' AND date_trunc('month', p.received_at AT TIME ZONE $1) = m) AS collected,
        (SELECT COALESCE(sum(amount),0) FROM payments p WHERE p.status = 'succeeded' AND date_trunc('month', p.received_at AT TIME ZONE $1) = m)
          - (SELECT COALESCE(sum(amount),0) FROM refunds r WHERE r.status = 'succeeded' AND date_trunc('month', r.created_at AT TIME ZONE $1) = m) AS net_collected,
        (SELECT COALESCE(sum(estimated_cost),0) FROM work_orders w WHERE date_trunc('month', w.scheduled_start AT TIME ZONE $1) = m AND w.status NOT IN ('cancelled','rejected')) AS estimated
      FROM generate_series(date_trunc('month', $2::date::timestamp) - interval '11 months', date_trunc('month', $2::date::timestamp), interval '1 month') m ORDER BY m`, [tz, f.to]),
      notes: 'Estimated values are job estimates and are not revenue.' }) },
  outstanding: { title: 'Outstanding invoices', description: 'Unpaid issued invoices with ageing.', financial: true, advanced: false,
    columns: [{ key: 'number', label: 'Invoice' }, { key: 'customer', label: 'Customer' }, { key: 'issue_date', label: 'Issued', type: 'date' }, { key: 'due_date', label: 'Due', type: 'date' },
      { key: 'days_overdue', label: 'Days overdue', type: 'number' }, { key: 'total', label: 'Total', type: 'money' }, { key: 'balance_due', label: 'Balance', type: 'money' }],
    run: async (db, f) => {
      const rows = await db.many(`SELECT i.number, c.full_name AS customer, i.issue_date, i.due_date, GREATEST(current_date - i.due_date, 0) AS days_overdue, i.total, i.balance_due
        FROM invoices i JOIN customers c ON c.id = i.customer_id WHERE i.status IN ('issued','partially_paid','overdue') AND ($1::uuid IS NULL OR i.customer_id = $1)
        AND ($2::uuid IS NULL OR i.branch_id = $2) ORDER BY i.due_date`, [f.customerId ?? null, f.branchId ?? null]);
      return { rows, summary: { count: rows.length, outstanding: rows.reduce((a, r) => a + Number(r.balance_due), 0),
        overdue: rows.filter((r) => r.days_overdue > 0).reduce((a, r) => a + Number(r.balance_due), 0) } };
    } },
  payments: { title: 'Payment collection', description: 'Successful payments by method.', financial: true, advanced: false,
    columns: [{ key: 'method', label: 'Method' }, { key: 'count', label: 'Payments', type: 'number' }, { key: 'amount', label: 'Amount', type: 'money' },
      { key: 'refunded', label: 'Refunded', type: 'money' }, { key: 'reconciled_pct', label: 'Reconciled', type: 'percent' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT p.method, count(*)::int AS count, sum(p.amount) AS amount,
        COALESCE(sum((SELECT sum(r.amount) FROM refunds r WHERE r.payment_id = p.id AND r.status = 'succeeded')),0) AS refunded,
        round(100.0 * count(*) FILTER (WHERE p.reconciled_at IS NOT NULL) / count(*)) AS reconciled_pct
      FROM payments p WHERE p.status = 'succeeded' AND p.received_at BETWEEN ${range} AND ($4::uuid IS NULL OR p.customer_id = $4) GROUP BY p.method ORDER BY amount DESC`,
      [f.from, f.to, tz, f.customerId ?? null]) }) },
  job_completion: { title: 'Job completion', description: 'Completed jobs, durations and first-time completion by category.', financial: false, advanced: false,
    columns: [{ key: 'category', label: 'Service category' }, { key: 'created', label: 'Created', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' },
      { key: 'completion_rate', label: 'Completion rate', type: 'percent' }, { key: 'avg_duration_min', label: 'Avg duration (min)', type: 'number' }, { key: 'avg_lead_hours', label: 'Avg request→done (h)', type: 'number' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT COALESCE(sc.name,'Uncategorised') AS category, count(*)::int AS created,
        count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid'))::int AS completed,
        round(100.0 * count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid')) / NULLIF(count(*) FILTER (WHERE w.status NOT IN ('cancelled','rejected')),0)) AS completion_rate,
        round(avg(extract(epoch FROM w.actual_end - w.actual_start)/60))::int AS avg_duration_min, round(avg(extract(epoch FROM w.actual_end - w.created_at)/3600)::numeric,1) AS avg_lead_hours
      FROM work_orders w LEFT JOIN service_categories sc ON sc.id = w.service_category_id WHERE w.created_at BETWEEN ${range}
        AND ($4::uuid IS NULL OR w.assigned_technician_id = $4) AND ($5::uuid IS NULL OR w.service_category_id = $5) AND ($6::uuid IS NULL OR w.branch_id = $6)
      GROUP BY 1 ORDER BY created DESC`, [f.from, f.to, tz, f.technicianId ?? null, f.categoryId ?? null, f.branchId ?? null]) }) },
  cancellations: { title: 'Job cancellations', description: 'Cancelled and rejected jobs with reasons.', financial: false, advanced: false,
    columns: [{ key: 'number', label: 'Job' }, { key: 'customer', label: 'Customer' }, { key: 'status', label: 'Status' }, { key: 'reason', label: 'Reason' }, { key: 'date', label: 'Date', type: 'date' }],
    run: async (db, f, tz) => {
      const rows = await db.many(`SELECT w.number, c.full_name AS customer, w.status, w.cancellation_reason AS reason, w.updated_at::date AS date FROM work_orders w JOIN customers c ON c.id = w.customer_id
        WHERE w.status IN ('cancelled','rejected') AND w.updated_at BETWEEN ${range} AND ($4::uuid IS NULL OR w.customer_id = $4) ORDER BY w.updated_at DESC`, [f.from, f.to, tz, f.customerId ?? null]);
      const total = await db.one(`SELECT count(*)::int n FROM work_orders WHERE created_at BETWEEN ${range}`, [f.from, f.to, tz]);
      return { rows, summary: { cancelled: rows.length, cancellation_rate: total.n ? Math.round((rows.length / total.n) * 1000) / 10 : 0 } };
    } },
  technician_performance: { title: 'Technician performance', description: 'Jobs, time on site, punctuality and customer ratings per technician.', financial: false, advanced: true,
    columns: [{ key: 'technician', label: 'Technician' }, { key: 'assigned', label: 'Assigned', type: 'number' }, { key: 'completed', label: 'Completed', type: 'number' },
      { key: 'avg_duration_min', label: 'Avg time on job (min)', type: 'number' }, { key: 'on_time_pct', label: 'On time', type: 'percent' }, { key: 'avg_rating', label: 'Avg rating', type: 'number' },
      { key: 'callbacks', label: 'Rescheduled', type: 'number' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT u.full_name AS technician, count(w.id)::int AS assigned,
        count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid'))::int AS completed, round(avg(extract(epoch FROM w.actual_end - w.actual_start)/60))::int AS avg_duration_min,
        round(100.0 * count(*) FILTER (WHERE w.actual_start <= w.scheduled_start + interval '15 minutes') / NULLIF(count(*) FILTER (WHERE w.actual_start IS NOT NULL),0)) AS on_time_pct,
        round(avg(fb.technician_rating),2) AS avg_rating, count(*) FILTER (WHERE w.reschedule_count > 0)::int AS callbacks
      FROM technician_profiles tp JOIN users u ON u.id = tp.user_id LEFT JOIN work_orders w ON w.assigned_technician_id = tp.id AND w.scheduled_start BETWEEN ${range}
      LEFT JOIN customer_feedback fb ON fb.work_order_id = w.id WHERE ($4::uuid IS NULL OR tp.id = $4) AND ($5::uuid IS NULL OR tp.branch_id = $5)
      GROUP BY u.full_name ORDER BY completed DESC`, [f.from, f.to, tz, f.technicianId ?? null, f.branchId ?? null]) }) },
  customer_growth: { title: 'Customer growth', description: 'New and active customers per period.', financial: false, advanced: true,
    columns: [{ key: 'period', label: 'Period' }, { key: 'new_customers', label: 'New customers', type: 'number' }, { key: 'active_customers', label: 'Customers with jobs', type: 'number' }, { key: 'total', label: 'Total customers', type: 'number' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT to_char(p, CASE WHEN $4 = 'month' THEN 'YYYY-MM' ELSE 'YYYY-MM-DD' END) AS period,
        (SELECT count(*) FROM customers c WHERE date_trunc($4, c.created_at AT TIME ZONE $3) = p)::int AS new_customers,
        (SELECT count(DISTINCT customer_id) FROM work_orders w WHERE date_trunc($4, w.created_at AT TIME ZONE $3) = p)::int AS active_customers,
        (SELECT count(*) FROM customers c WHERE c.created_at AT TIME ZONE $3 < p + ('1 ' || $4)::interval)::int AS total
      FROM generate_series(date_trunc($4, $1::date::timestamp), date_trunc($4, $2::date::timestamp), ('1 ' || $4)::interval) p ORDER BY p`, [f.from, f.to, tz, f.groupBy]) }) },
  service_category: { title: 'Service categories', description: 'Demand and value by service category.', financial: false, advanced: false,
    columns: [{ key: 'category', label: 'Category' }, { key: 'requests', label: 'Requests', type: 'number' }, { key: 'jobs', label: 'Jobs', type: 'number' },
      { key: 'completed', label: 'Completed', type: 'number' }, { key: 'invoiced', label: 'Invoiced', type: 'money' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT sc.name AS category,
        (SELECT count(*) FROM service_requests r WHERE r.service_category_id = sc.id AND r.created_at BETWEEN ${range})::int AS requests,
        (SELECT count(*) FROM work_orders w WHERE w.service_category_id = sc.id AND w.created_at BETWEEN ${range})::int AS jobs,
        (SELECT count(*) FROM work_orders w WHERE w.service_category_id = sc.id AND w.status IN ('completed','invoiced','paid') AND w.actual_end BETWEEN ${range})::int AS completed,
        (SELECT COALESCE(sum(i.total),0) FROM invoices i JOIN work_orders w ON w.id = i.work_order_id WHERE w.service_category_id = sc.id AND i.status NOT IN ('draft','cancelled') AND i.issued_at BETWEEN ${range}) AS invoiced
      FROM service_categories sc ORDER BY jobs DESC`, [f.from, f.to, tz]) }) },
  equipment_history: { title: 'Equipment service history', description: 'Service frequency and last condition per asset.', financial: false, advanced: true,
    columns: [{ key: 'asset', label: 'Asset' }, { key: 'customer', label: 'Customer' }, { key: 'model', label: 'Model' }, { key: 'services', label: 'Services', type: 'number' },
      { key: 'last_service', label: 'Last service', type: 'date' }, { key: 'next_due', label: 'Next due', type: 'date' }, { key: 'last_condition', label: 'Last condition' }, { key: 'warranty_expiry', label: 'Warranty until', type: 'date' }],
    run: async (db, f) => ({ rows: await db.many(`SELECT a.number || ' ' || a.name AS asset, c.full_name AS customer, concat_ws(' ', a.manufacturer, a.model) AS model,
        (SELECT count(*) FROM work_orders w WHERE w.asset_id = a.id AND w.status IN ('completed','invoiced','paid'))::int AS services, a.last_service_date AS last_service, a.next_service_due AS next_due,
        (SELECT sr.equipment_condition FROM service_reports sr JOIN work_orders w ON w.id = sr.work_order_id WHERE w.asset_id = a.id ORDER BY w.actual_end DESC NULLS LAST LIMIT 1) AS last_condition, a.warranty_expiry
      FROM assets a JOIN customers c ON c.id = a.customer_id WHERE ($1::uuid IS NULL OR a.customer_id = $1) ORDER BY services DESC, a.number LIMIT 2000`, [f.customerId ?? null]) }) },
  amc_renewals: { title: 'AMC renewals', description: 'Contracts expiring in the period and their renewal status.', financial: false, advanced: false,
    columns: [{ key: 'number', label: 'Contract' }, { key: 'customer', label: 'Customer' }, { key: 'end_date', label: 'Ends', type: 'date' }, { key: 'value', label: 'Value', type: 'money' },
      { key: 'visits', label: 'Visits done', type: 'text' }, { key: 'renewal', label: 'Renewal' }],
    run: async (db, f) => ({ rows: await db.many(`SELECT m.number, c.full_name AS customer, m.end_date, m.contract_value AS value,
        (SELECT count(*) FROM scheduled_visits v WHERE v.contract_id = m.id AND v.status = 'completed') || '/' || m.visits_included AS visits,
        COALESCE((SELECT r.number || ' (' || r.status || ')' FROM amc_contracts r WHERE r.renewed_from_id = m.id ORDER BY r.created_at DESC LIMIT 1), CASE WHEN m.auto_renew THEN 'Auto-renew' ELSE 'Not renewed' END) AS renewal
      FROM amc_contracts m JOIN customers c ON c.id = m.customer_id WHERE m.status IN ('active','expired','renewed') AND m.end_date BETWEEN $1 AND $2 ORDER BY m.end_date`, [f.from, f.to]) }) },
  parts_consumption: { title: 'Parts consumption', description: 'Parts used on jobs, with cost and billed value.', financial: true, advanced: true,
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Part' }, { key: 'quantity', label: 'Qty used', type: 'number' }, { key: 'jobs', label: 'Jobs', type: 'number' },
      { key: 'cost', label: 'Cost', type: 'money' }, { key: 'billed', label: 'Billed value', type: 'money' }],
    run: async (db, f, tz) => ({ rows: await db.many(`SELECT COALESCE(i.sku,'—') AS sku, p.description AS name, sum(p.quantity) AS quantity, count(DISTINCT p.work_order_id)::int AS jobs,
        sum(p.quantity * COALESCE(p.unit_cost,0)) AS cost, sum(p.quantity * p.unit_price) AS billed
      FROM work_order_parts p LEFT JOIN inventory_items i ON i.id = p.item_id JOIN work_orders w ON w.id = p.work_order_id
      WHERE p.created_at BETWEEN ${range} AND ($4::uuid IS NULL OR w.assigned_technician_id = $4) GROUP BY 1,2 ORDER BY quantity DESC`, [f.from, f.to, tz, f.technicianId ?? null]) }) },
  inventory: { title: 'Inventory valuation', description: 'Stock on hand by item and location, at purchase cost.', financial: true, advanced: true,
    columns: [{ key: 'sku', label: 'SKU' }, { key: 'name', label: 'Item' }, { key: 'location', label: 'Location' }, { key: 'quantity', label: 'On hand', type: 'number' },
      { key: 'min_stock', label: 'Min', type: 'number' }, { key: 'unit_cost', label: 'Unit cost', type: 'money' }, { key: 'value', label: 'Value', type: 'money' }],
    run: async (db) => {
      const rows = await db.many(`SELECT i.sku, i.name, l.name AS location, s.quantity, i.min_stock, i.purchase_price AS unit_cost, s.quantity * i.purchase_price AS value
        FROM inventory_stock s JOIN inventory_items i ON i.id = s.item_id JOIN stock_locations l ON l.id = s.location_id WHERE s.quantity <> 0 ORDER BY i.name, l.name`);
      return { rows, summary: { total_value: rows.reduce((a, r) => a + Number(r.value), 0) } };
    } },
  profitability: { title: 'Job profitability (estimate)', description: 'Invoiced value minus recorded parts cost and technician labour cost, for jobs with costs recorded.', financial: true, advanced: true,
    columns: [{ key: 'number', label: 'Job' }, { key: 'customer', label: 'Customer' }, { key: 'technician', label: 'Technician' }, { key: 'revenue', label: 'Invoiced (net of tax)', type: 'money' },
      { key: 'parts_cost', label: 'Parts cost', type: 'money' }, { key: 'labour_cost', label: 'Labour cost', type: 'money' }, { key: 'margin', label: 'Est. margin', type: 'money' }, { key: 'margin_pct', label: 'Margin', type: 'percent' }],
    run: async (db, f, tz) => {
      const rows = await db.many(`SELECT w.number, c.full_name AS customer, u.full_name AS technician,
          COALESCE((SELECT sum(i.subtotal - i.discount_total) FROM invoices i WHERE i.work_order_id = w.id AND i.status NOT IN ('draft','cancelled')),0) AS revenue,
          COALESCE((SELECT sum(p.quantity * COALESCE(p.unit_cost,0)) FROM work_order_parts p WHERE p.work_order_id = w.id),0) AS parts_cost,
          COALESCE(round(extract(epoch FROM w.actual_end - w.actual_start)/3600 * COALESCE(tp.hourly_cost,0), 2),0) AS labour_cost
        FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
        WHERE w.status IN ('invoiced','paid') AND w.actual_end BETWEEN ${range} AND ($4::uuid IS NULL OR w.assigned_technician_id = $4) ORDER BY w.actual_end DESC LIMIT 2000`,
        [f.from, f.to, tz, f.technicianId ?? null]);
      for (const r of rows) { r.margin = Number(r.revenue) - Number(r.parts_cost) - Number(r.labour_cost); r.margin_pct = Number(r.revenue) ? Math.round((r.margin / Number(r.revenue)) * 100) : null; }
      return { rows, notes: 'An estimate: uses parts cost recorded on the job and technician hourly cost × time on site. Overheads and travel are not included.' };
    } },
};

reportsRouter.get('/', ah(async (req, res) => {
  const ent = await getEntitlements(req.auth!.tenantId!);
  res.json({ data: Object.entries(REPORTS).map(([key, r]) => ({ key, title: r.title, description: r.description, financial: r.financial,
    available: (!r.advanced || !!ent.features.advanced_reports) && req.auth!.permissions.has(r.financial ? 'reports.financial' : 'reports.operational'), requiresUpgrade: r.advanced && !ent.features.advanced_reports })) });
}));

async function runReport(req: Request) {
  const def = REPORTS[req.params.key];
  if (!def) throw notFound('Report');
  if (!req.auth!.permissions.has(def.financial ? 'reports.financial' : 'reports.operational')) throw forbidden();
  const ent = await getEntitlements(req.auth!.tenantId!);
  if (def.advanced && !ent.features.advanced_reports) throw new AppError(403, 'FEATURE_NOT_IN_PLAN', 'This report is available on plans with advanced reports');
  const today = new Date().toISOString().slice(0, 10);
  const monthAgo = new Date(Date.now() - 30 * 86400000).toISOString().slice(0, 10);
  const f = parse(z.object({ from: dateStr.default(monthAgo), to: dateStr.default(today), technicianId: z.string().uuid().optional(), customerId: z.string().uuid().optional(),
    categoryId: z.string().uuid().optional(), branchId: z.string().uuid().optional(), groupBy: z.enum(['day', 'week', 'month']).default('month') }), req.query);
  return tx(req, async (db) => {
    const s = await tenantSettings(db);
    const out = await def.run(db, f, s.timezone);
    return { key: req.params.key, title: def.title, description: def.description, columns: def.columns, filters: f, currency: s.currency, locale: s.locale, generatedAt: new Date().toISOString(), business: s.business_name, ...out };
  });
}

reportsRouter.get('/:key', ah(async (req, res) => {
  const r = await runReport(req);
  const format = String(req.query.format ?? 'json');
  if (format === 'csv') {
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r.key}-${r.filters.from}-${r.filters.to}.csv"`);
    return res.send(toCsv(r.rows, r.columns.map((c) => c.key)).replace(/^[^\n]*/, r.columns.map((c) => `"${c.label}"`).join(',')));
  }
  if (format === 'pdf') {
    const fmt = (v: any, t?: string) => v === null || v === undefined ? '—' : t === 'money' ? `${Number(v).toLocaleString(r.locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
      : t === 'percent' ? `${v}%` : String(v);
    const cols = r.columns.slice(0, 7);
    const pdf = await renderSheetPdf({ signatures: false, title: r.title, number: `${r.filters.from} – ${r.filters.to}`, seller: { name: r.business, lines: [`Generated ${new Date(r.generatedAt).toLocaleString(r.locale)}`, `Amounts in ${r.currency}`] },
      sections: [...(r.summary ? [{ heading: 'Summary', rows: Object.entries(r.summary).map(([k, v]) => [k.replace(/_/g, ' '), typeof v === 'number' ? v.toLocaleString(r.locale) : String(v)] as [string, string]) }] : []),
        { heading: 'Detail', table: { head: cols.map((c) => c.label), rows: r.rows.slice(0, 1000).map((row: any) => cols.map((c) => fmt(row[c.key], c.type))) } },
        ...(r.notes ? [{ heading: 'Notes', text: r.notes }] : [])] });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${r.key}.pdf"`);
    return res.send(pdf);
  }
  res.json({ data: r });
}));

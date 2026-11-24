import { Router } from 'express';
import { z } from 'zod';
import { ah, dateStr, parse } from '../../lib/http.js';
import { tx, branchScope } from '../common.js';
import { suggestTechnicians } from './service.js';
import { requireFeature } from '../../auth/middleware.js';

export const dispatchRouter = Router();

/** Day board: every active technician with their timeline, plus the unassigned queue and detected conflicts. */
dispatchRouter.get('/board', ah(async (req, res) => {
  const q = parse(z.object({ date: dateStr.optional(), days: z.coerce.number().int().min(1).max(7).default(1) }), req.query);
  const b = branchScope(req);
  const data = await tx(req, async (db) => {
    const s = await db.one(`SELECT timezone, working_hours_start, working_hours_end, prevent_double_booking FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
    const date = q.date ?? (await db.one(`SELECT (now() AT TIME ZONE $1)::date::text AS d`, [s.timezone])).d;
    const range = await db.one(`SELECT ($1::date::timestamp AT TIME ZONE $2) AS from_ts, (($1::date + $3::int)::timestamp AT TIME ZONE $2) AS to_ts`, [date, s.timezone, q.days]);
    const technicians = await db.many(`SELECT tp.id, u.full_name, tp.max_jobs_per_day, tp.employment_status,
        COALESCE((SELECT json_agg(sc.name) FROM technician_skills ts JOIN service_categories sc ON sc.id = ts.service_category_id WHERE ts.technician_id = tp.id), '[]') AS skills,
        EXISTS (SELECT 1 FROM technician_time_off o WHERE o.technician_id = tp.id AND tstzrange(o.starts_at, o.ends_at) && tstzrange($1, $2)) AS on_leave
      FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE u.is_active AND tp.employment_status IN ('active','on_leave') AND ($3::uuid IS NULL OR tp.branch_id = $3)
      ORDER BY u.full_name`, [range.from_ts, range.to_ts, b]);
    const assignments = await db.many(`SELECT ja.technician_id, lower(ja.time_window) AS starts_at, upper(ja.time_window) AS ends_at, w.id, w.number, w.title, w.status, w.priority, w.version,
        c.full_name AS customer_name, a.city, a.line1, sc.name AS category_name
      FROM job_assignments ja JOIN work_orders w ON w.id = ja.work_order_id JOIN customers c ON c.id = w.customer_id
      LEFT JOIN customer_addresses a ON a.id = w.address_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
      WHERE ja.is_current AND ja.time_window && tstzrange($1, $2) ORDER BY lower(ja.time_window)`, [range.from_ts, range.to_ts]);
    const unassigned = await db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.expected_duration_minutes, w.created_at,
        c.full_name AS customer_name, a.city, sc.name AS category_name
      FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN customer_addresses a ON a.id = w.address_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
      WHERE w.assigned_technician_id IS NULL AND w.status IN ('new','approved','scheduled','on_hold') AND ($1::uuid IS NULL OR w.branch_id = $1)
      ORDER BY array_position(ARRAY['urgent','high','normal','low'], w.priority), w.scheduled_start NULLS LAST, w.created_at LIMIT 200`, [b]);
    // Overlaps can only exist if the business allows double booking; surface them for review.
    const conflicts = await db.many(`SELECT a1.technician_id, w1.number AS job_a, w2.number AS job_b FROM job_assignments a1 JOIN job_assignments a2
        ON a1.technician_id = a2.technician_id AND a1.id < a2.id AND a1.time_window && a2.time_window
      JOIN work_orders w1 ON w1.id = a1.work_order_id JOIN work_orders w2 ON w2.id = a2.work_order_id
      WHERE a1.is_current AND a2.is_current AND a1.time_window && tstzrange($1, $2)`, [range.from_ts, range.to_ts]);
    return { date, days: q.days, timezone: s.timezone, workingHours: { start: s.working_hours_start, end: s.working_hours_end }, preventDoubleBooking: s.prevent_double_booking,
      technicians: technicians.map((t) => ({ ...t, assignments: assignments.filter((a) => a.technician_id === t.id) })), unassigned, conflicts };
  });
  res.json({ data });
}));

dispatchRouter.get('/suggestions/:workOrderId', requireFeature('dispatch_optimizer'), ah(async (req, res) => {
  const q = parse(z.object({ start: z.string().datetime({ offset: true }).optional() }), req.query);
  res.json({ data: await tx(req, (db) => suggestTechnicians(db, req.params.workOrderId, q.start)) });
}));

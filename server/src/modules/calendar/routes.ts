import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { tx, branchScope } from '../common.js';

export const calendarRouter = Router();

/** Calendar feed: scheduled jobs, AMC visits (due dates), technician leave. Technicians only see their own jobs. */
calendarRouter.get('/', requirePermission('calendar.view', 'work_orders.read_own'), ah(async (req, res) => {
  const q = parse(z.object({ from: z.string().datetime({ offset: true }), to: z.string().datetime({ offset: true }), technicianId: z.string().uuid().optional(),
    include: z.string().default('jobs,visits,leave') }), req.query);
  const own = !req.auth!.permissions.has('work_orders.read');
  const tech = own ? req.auth!.technicianId : q.technicianId ?? null;
  const inc = new Set(q.include.split(','));
  const b = branchScope(req);
  const data = await tx(req, async (db) => {
    const jobs = inc.has('jobs') ? await db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start AS start,
        w.scheduled_start + (w.expected_duration_minutes || ' minutes')::interval AS end, w.assigned_technician_id AS technician_id, u.full_name AS technician_name,
        c.full_name AS customer_name, a.city, w.amc_visit_id IS NOT NULL AS is_amc, w.reschedule_count > 0 AS rescheduled,
        (w.scheduled_start < now() AND w.status IN ('new','approved','scheduled','assigned','en_route')) AS overdue
      FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
      LEFT JOIN customer_addresses a ON a.id = w.address_id
      WHERE w.scheduled_start < $2 AND w.scheduled_start + (w.expected_duration_minutes || ' minutes')::interval > $1 AND w.status NOT IN ('cancelled','rejected')
        AND ($3::uuid IS NULL OR w.assigned_technician_id = $3) AND ($4::boolean = false OR w.assigned_technician_id IS NOT NULL) AND ($5::uuid IS NULL OR w.branch_id = $5)
      ORDER BY w.scheduled_start`, [q.from, q.to, tech, own, b]) : [];
    const visits = inc.has('visits') && !own ? await db.many(`SELECT v.id, v.visit_number, v.due_date, v.status, m.id AS contract_id, m.number AS contract_number, m.title, c.full_name AS customer_name
      FROM scheduled_visits v JOIN amc_contracts m ON m.id = v.contract_id JOIN customers c ON c.id = m.customer_id
      WHERE m.status = 'active' AND v.status = 'scheduled' AND v.due_date BETWEEN $1::timestamptz::date AND $2::timestamptz::date ORDER BY v.due_date`, [q.from, q.to]) : [];
    const leave = inc.has('leave') ? await db.many(`SELECT o.id, o.starts_at AS start, o.ends_at AS end, o.reason, o.technician_id, u.full_name AS technician_name
      FROM technician_time_off o JOIN technician_profiles tp ON tp.id = o.technician_id JOIN users u ON u.id = tp.user_id
      WHERE o.starts_at < $2 AND o.ends_at > $1 AND ($3::uuid IS NULL OR o.technician_id = $3)`, [q.from, q.to, tech]) : [];
    const holidays = await db.many(`SELECT date, name FROM holidays WHERE date BETWEEN $1::timestamptz::date AND $2::timestamptz::date`, [q.from, q.to]);
    return { jobs, visits, leave, holidays };
  });
  res.json({ data });
}));

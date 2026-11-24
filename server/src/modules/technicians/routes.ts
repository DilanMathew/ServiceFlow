import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, dateStr, parse } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict, notFound } from '../../lib/errors.js';
import { tx, branchScope, mustFind } from '../common.js';
import { assertLimit } from '../subscriptions/entitlements.js';
import { inviteStaff } from '../users/routes.js';
import { invalidateAuthCache } from '../../auth/context.js';

export const techniciansRouter = Router();
const read = requirePermission('technicians.read', 'dispatch.manage');
const manage = requirePermission('technicians.manage');

const profileSchema = z.object({
  employeeId: z.string().trim().max(30).nullish(), employmentType: z.enum(['full_time', 'part_time', 'contractor']).default('full_time'),
  hourlyCost: z.number().min(0).nullish(), maxJobsPerDay: z.number().int().min(1).max(30).default(6), branchId: z.string().uuid().nullish(),
  homeLatitude: z.number().min(-90).max(90).nullish(), homeLongitude: z.number().min(-180).max(180).nullish(), bio: z.string().max(1000).nullish(),
});

techniciansRouter.get('/', read, ah(async (req, res) => {
  const q = parse(z.object({ status: z.string().optional(), categoryId: z.string().uuid().optional(), areaId: z.string().uuid().optional(), q: z.string().optional(),
    date: dateStr.optional() }), req.query);
  const b = branchScope(req);
  const rows = await tx(req, async (db) => {
    const tz = (await db.one(`SELECT timezone FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId])).timezone;
    return db.many(
      `SELECT tp.id, tp.user_id, tp.employee_id, tp.employment_status, tp.employment_type, tp.max_jobs_per_day, tp.branch_id, u.full_name, u.email, u.phone, u.is_active,
         (u.password_hash IS NULL) AS invitation_pending,
         COALESCE((SELECT json_agg(json_build_object('id', sc.id, 'name', sc.name, 'proficiency', ts.proficiency)) FROM technician_skills ts JOIN service_categories sc ON sc.id = ts.service_category_id WHERE ts.technician_id = tp.id), '[]') AS skills,
         COALESCE((SELECT json_agg(json_build_object('id', sa.id, 'name', sa.name)) FROM technician_service_areas x JOIN service_areas sa ON sa.id = x.service_area_id WHERE x.technician_id = tp.id), '[]') AS areas,
         (SELECT count(*) FROM work_orders w WHERE w.assigned_technician_id = tp.id AND w.status IN ('assigned','en_route','in_progress','on_hold'))::int AS open_jobs,
         (SELECT count(*) FROM job_assignments ja WHERE ja.technician_id = tp.id AND ja.is_current AND (lower(ja.time_window) AT TIME ZONE $1)::date = COALESCE($2::date, (now() AT TIME ZONE $1)::date))::int AS jobs_on_date,
         (SELECT count(*) FROM work_orders w WHERE w.assigned_technician_id = tp.id AND w.status IN ('completed','invoiced','paid') AND w.actual_end > now() - interval '30 days')::int AS completed_30d,
         (SELECT round(avg(f.technician_rating),1) FROM customer_feedback f WHERE f.technician_id = tp.id AND f.technician_rating IS NOT NULL) AS avg_rating
       FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
       WHERE ($3::text IS NULL OR tp.employment_status = $3) AND ($4::uuid IS NULL OR EXISTS (SELECT 1 FROM technician_skills s WHERE s.technician_id = tp.id AND s.service_category_id = $4))
         AND ($5::uuid IS NULL OR EXISTS (SELECT 1 FROM technician_service_areas s WHERE s.technician_id = tp.id AND s.service_area_id = $5))
         AND ($6::text IS NULL OR u.full_name ILIKE '%' || $6 || '%' OR tp.employee_id ILIKE '%' || $6 || '%')
         AND ($7::uuid IS NULL OR tp.branch_id = $7)
       ORDER BY u.is_active DESC, u.full_name`, [tz, q.date ?? null, q.status ?? null, q.categoryId ?? null, q.areaId ?? null, q.q ?? null, b]);
  });
  res.json({ data: rows });
}));

techniciansRouter.post('/', manage, ah(async (req, res) => {
  const b = parse(profileSchema.extend({ email: z.string().trim().toLowerCase().email(), fullName: z.string().trim().min(2).max(120), phone: z.string().max(30).nullish(),
    skillIds: z.array(z.string().uuid()).max(50).default([]), serviceAreaIds: z.array(z.string().uuid()).max(100).default([]) }), req.body);
  const out = await tx(req, async (db) => {
    await assertLimit(db, 'technicians');
    const role = await db.one(`SELECT id FROM roles WHERE key = 'technician' AND tenant_id IS NULL`);
    const user = await inviteStaff(req, db, { email: b.email, fullName: b.fullName, phone: b.phone, roleIds: [role.id], branchId: b.branchId });
    const tp = await db.one(`INSERT INTO technician_profiles (tenant_id, user_id, branch_id, employee_id, employment_type, hourly_cost, max_jobs_per_day, home_latitude, home_longitude, bio)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`, [db.tenantId, user.id, b.branchId ?? null, b.employeeId ?? null, b.employmentType, b.hourlyCost ?? null,
      b.maxJobsPerDay, b.homeLatitude ?? null, b.homeLongitude ?? null, b.bio ?? null]);
    for (const s of b.skillIds) await db.query(`INSERT INTO technician_skills (tenant_id, technician_id, service_category_id) VALUES ($1,$2,$3)`, [db.tenantId, tp.id, s]);
    for (const a of b.serviceAreaIds) await db.query(`INSERT INTO technician_service_areas (tenant_id, technician_id, service_area_id) VALUES ($1,$2,$3)`, [db.tenantId, tp.id, a]);
    const s = await db.one(`SELECT working_days, working_hours_start, working_hours_end FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
    for (const d of s.working_days) await db.query(`INSERT INTO technician_availability (tenant_id, technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`,
      [db.tenantId, tp.id, d, s.working_hours_start, s.working_hours_end]);
    await audit(db, req, { action: 'technician.created', entityType: 'technician', entityId: tp.id, after: { name: b.fullName, email: b.email } });
    return tp;
  });
  res.status(201).json({ data: out });
}));

techniciansRouter.get('/:id', read, ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const tp = await db.maybeOne(`SELECT tp.*, u.full_name, u.email, u.phone, u.is_active, u.last_login_at, b.name AS branch_name FROM technician_profiles tp
      JOIN users u ON u.id = tp.user_id LEFT JOIN branches b ON b.id = tp.branch_id WHERE tp.id = $1`, [req.params.id]);
    if (!tp) throw notFound('Technician');
    const [skills, areas, availability, timeOff, upcoming, recent, stats, attendance] = await Promise.all([
      db.many(`SELECT ts.*, sc.name FROM technician_skills ts JOIN service_categories sc ON sc.id = ts.service_category_id WHERE ts.technician_id = $1`, [tp.id]),
      db.many(`SELECT sa.id, sa.name FROM technician_service_areas x JOIN service_areas sa ON sa.id = x.service_area_id WHERE x.technician_id = $1`, [tp.id]),
      db.many(`SELECT * FROM technician_availability WHERE technician_id = $1 ORDER BY weekday, start_time`, [tp.id]),
      db.many(`SELECT * FROM technician_time_off WHERE technician_id = $1 AND ends_at > now() - interval '30 days' ORDER BY starts_at`, [tp.id]),
      db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.expected_duration_minutes, c.full_name AS customer_name, a.city
               FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN customer_addresses a ON a.id = w.address_id
               WHERE w.assigned_technician_id = $1 AND w.status IN ('assigned','en_route','in_progress','on_hold') ORDER BY w.scheduled_start LIMIT 50`, [tp.id]),
      db.many(`SELECT w.id, w.number, w.title, w.status, w.actual_start, w.actual_end, c.full_name AS customer_name, f.rating, f.technician_rating
               FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN customer_feedback f ON f.work_order_id = w.id
               WHERE w.assigned_technician_id = $1 AND w.status IN ('completed','invoiced','paid') ORDER BY w.actual_end DESC NULLS LAST LIMIT 30`, [tp.id]),
      db.one(`SELECT count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid'))::int AS completed,
                     count(*) FILTER (WHERE w.status IN ('completed','invoiced','paid') AND w.actual_end > now() - interval '30 days')::int AS completed_30d,
                     round(avg(extract(epoch FROM (w.actual_end - w.actual_start)) / 60) FILTER (WHERE w.actual_end IS NOT NULL AND w.actual_start IS NOT NULL))::int AS avg_job_minutes,
                     round(100.0 * count(*) FILTER (WHERE w.actual_start <= w.scheduled_start + interval '15 minutes') / NULLIF(count(*) FILTER (WHERE w.actual_start IS NOT NULL AND w.scheduled_start IS NOT NULL),0))::int AS on_time_pct,
                     (SELECT round(avg(technician_rating),2) FROM customer_feedback WHERE technician_id = $1) AS avg_rating,
                     (SELECT count(*) FROM work_orders x WHERE x.assigned_technician_id = $1 AND x.reschedule_count > 0)::int AS rescheduled
              FROM work_orders w WHERE w.assigned_technician_id = $1`, [tp.id]),
      db.many(`SELECT * FROM technician_attendance WHERE technician_id = $1 ORDER BY work_date DESC LIMIT 30`, [tp.id]),
    ]);
    return { ...tp, hourly_cost: req.auth!.permissions.has('reports.financial') ? tp.hourly_cost : undefined, skills, areas, availability, timeOff, upcoming, recent, stats, attendance };
  });
  res.json({ data });
}));

techniciansRouter.patch('/:id', manage, ah(async (req, res) => {
  const b = parse(profileSchema.partial().extend({ employmentStatus: z.enum(['active', 'on_leave', 'inactive', 'terminated']).optional() }), req.body);
  const out = await tx(req, async (db) => {
    const before = await mustFind(db, 'technician_profiles', req.params.id, 'Technician');
    if (b.employmentStatus === 'active' && before.employment_status === 'terminated') await assertLimit(db, 'technicians');
    if (b.employmentStatus && ['inactive', 'terminated'].includes(b.employmentStatus)) {
      const open = await db.one(`SELECT count(*)::int n FROM work_orders WHERE assigned_technician_id = $1 AND status IN ('assigned','en_route','in_progress')`, [before.id]);
      if (open.n) throw conflict(`Reassign this technician's ${open.n} open job(s) first`);
    }
    const m: Record<string, string> = { employeeId: 'employee_id', employmentType: 'employment_type', hourlyCost: 'hourly_cost', maxJobsPerDay: 'max_jobs_per_day',
      branchId: 'branch_id', homeLatitude: 'home_latitude', homeLongitude: 'home_longitude', bio: 'bio', employmentStatus: 'employment_status' };
    const keys = Object.keys(m).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await db.one(`UPDATE technician_profiles SET ${keys.map((k, i) => `${m[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (b as any)[k])]);
    if (b.employmentStatus === 'terminated') {
      await db.query(`UPDATE users SET is_active = false WHERE id = $1`, [before.user_id]);
      await db.query(`UPDATE sessions SET revoked_at = now() WHERE user_id = $1 AND revoked_at IS NULL`, [before.user_id]);
      invalidateAuthCache(before.user_id);
    }
    await audit(db, req, { action: 'technician.updated', entityType: 'technician', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

techniciansRouter.put('/:id/skills', manage, ah(async (req, res) => {
  const b = parse(z.object({ skills: z.array(z.object({ serviceCategoryId: z.string().uuid(), proficiency: z.number().int().min(1).max(5).default(3), certifiedUntil: dateStr.nullish() })).max(50) }), req.body);
  await tx(req, async (db) => {
    const tp = await mustFind(db, 'technician_profiles', req.params.id, 'Technician');
    await db.query(`DELETE FROM technician_skills WHERE technician_id = $1`, [tp.id]);
    for (const s of b.skills) await db.query(`INSERT INTO technician_skills (tenant_id, technician_id, service_category_id, proficiency, certified_until) VALUES ($1,$2,$3,$4,$5)`,
      [db.tenantId, tp.id, s.serviceCategoryId, s.proficiency, s.certifiedUntil ?? null]);
    await audit(db, req, { action: 'technician.skills_updated', entityType: 'technician', entityId: tp.id, after: b });
  });
  res.json({ data: { ok: true } });
}));

techniciansRouter.put('/:id/areas', manage, ah(async (req, res) => {
  const b = parse(z.object({ serviceAreaIds: z.array(z.string().uuid()).max(100) }), req.body);
  await tx(req, async (db) => {
    const tp = await mustFind(db, 'technician_profiles', req.params.id, 'Technician');
    await db.query(`DELETE FROM technician_service_areas WHERE technician_id = $1`, [tp.id]);
    for (const a of b.serviceAreaIds) await db.query(`INSERT INTO technician_service_areas (tenant_id, technician_id, service_area_id) VALUES ($1,$2,$3)`, [db.tenantId, tp.id, a]);
    await audit(db, req, { action: 'technician.areas_updated', entityType: 'technician', entityId: tp.id, after: b });
  });
  res.json({ data: { ok: true } });
}));

techniciansRouter.put('/:id/availability', manage, ah(async (req, res) => {
  const b = parse(z.object({ slots: z.array(z.object({ weekday: z.number().int().min(1).max(7), startTime: z.string().regex(/^\d{2}:\d{2}$/), endTime: z.string().regex(/^\d{2}:\d{2}$/) })).max(28) }), req.body);
  if (b.slots.some((s) => s.endTime <= s.startTime)) throw badRequest('End time must be after start time');
  await tx(req, async (db) => {
    const tp = await mustFind(db, 'technician_profiles', req.params.id, 'Technician');
    await db.query(`DELETE FROM technician_availability WHERE technician_id = $1`, [tp.id]);
    for (const s of b.slots) await db.query(`INSERT INTO technician_availability (tenant_id, technician_id, weekday, start_time, end_time) VALUES ($1,$2,$3,$4,$5)`,
      [db.tenantId, tp.id, s.weekday, s.startTime, s.endTime]);
    await audit(db, req, { action: 'technician.availability_updated', entityType: 'technician', entityId: tp.id, after: b });
  });
  res.json({ data: { ok: true } });
}));

techniciansRouter.post('/:id/time-off', manage, ah(async (req, res) => {
  const b = parse(z.object({ startsAt: z.string().datetime({ offset: true }), endsAt: z.string().datetime({ offset: true }), reason: z.string().max(200).nullish() }), req.body);
  if (new Date(b.endsAt) <= new Date(b.startsAt)) throw badRequest('End must be after start');
  const out = await tx(req, async (db) => {
    const tp = await mustFind(db, 'technician_profiles', req.params.id, 'Technician');
    const clash = await db.many(`SELECT w.number FROM job_assignments ja JOIN work_orders w ON w.id = ja.work_order_id WHERE ja.technician_id = $1 AND ja.is_current
      AND w.status IN ('assigned','en_route') AND ja.time_window && tstzrange($2,$3)`, [tp.id, b.startsAt, b.endsAt]);
    const r = await db.one(`INSERT INTO technician_time_off (tenant_id, technician_id, starts_at, ends_at, reason) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [db.tenantId, tp.id, b.startsAt, b.endsAt, b.reason ?? null]);
    await audit(db, req, { action: 'technician.time_off_added', entityType: 'technician', entityId: tp.id, after: b });
    return { ...r, conflictingJobs: clash.map((c) => c.number) };
  });
  res.status(201).json({ data: out });
}));

techniciansRouter.delete('/:id/time-off/:offId', manage, ah(async (req, res) => {
  await tx(req, (db) => db.query(`DELETE FROM technician_time_off WHERE id = $1 AND technician_id = $2`, [req.params.offId, req.params.id]));
  res.json({ data: { ok: true } });
}));

techniciansRouter.get('/:id/schedule', read, ah(async (req, res) => {
  const q = parse(z.object({ from: z.string(), to: z.string() }), req.query);
  const rows = await tx(req, (db) => db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, lower(ja.time_window) AS starts_at, upper(ja.time_window) AS ends_at, c.full_name AS customer_name, a.city
    FROM job_assignments ja JOIN work_orders w ON w.id = ja.work_order_id JOIN customers c ON c.id = w.customer_id LEFT JOIN customer_addresses a ON a.id = w.address_id
    WHERE ja.technician_id = $1 AND ja.is_current AND ja.time_window && tstzrange($2::timestamptz, $3::timestamptz) ORDER BY lower(ja.time_window)`, [req.params.id, q.from, q.to]));
  res.json({ data: rows });
}));

// ---------------------------------------------------------------- self-service for the logged-in technician
techniciansRouter.get('/me/dashboard', requirePermission('work_orders.read_own'), ah(async (req, res) => {
  const techId = req.auth!.technicianId;
  if (!techId) throw notFound('Technician profile');
  const data = await tx(req, async (db) => {
    const tz = (await db.one(`SELECT timezone FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId])).timezone;
    const jobs = await db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.expected_duration_minutes, w.accepted_at,
        c.full_name AS customer_name, c.phone AS customer_phone, a.line1, a.city, a.postal_code, a.latitude, a.longitude, sc.name AS category_name,
        ((w.scheduled_start AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date) AS is_today
      FROM work_orders w JOIN customers c ON c.id = w.customer_id LEFT JOIN customer_addresses a ON a.id = w.address_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
      WHERE w.assigned_technician_id = $1 AND w.status IN ('assigned','en_route','in_progress','on_hold') ORDER BY w.scheduled_start NULLS LAST`, [techId, tz]);
    const stats = await db.one(`SELECT count(*) FILTER (WHERE status IN ('completed','invoiced','paid') AND (actual_end AT TIME ZONE $2)::date = (now() AT TIME ZONE $2)::date)::int AS completed_today,
        count(*) FILTER (WHERE status IN ('completed','invoiced','paid') AND actual_end > now() - interval '7 days')::int AS completed_week
      FROM work_orders WHERE assigned_technician_id = $1`, [techId, tz]);
    const attendance = await db.maybeOne(`SELECT * FROM technician_attendance WHERE technician_id = $1 AND work_date = (now() AT TIME ZONE $2)::date`, [techId, tz]);
    return { today: jobs.filter((j) => j.is_today || j.status === 'in_progress'), upcoming: jobs.filter((j) => !j.is_today && j.status !== 'in_progress'), stats, attendance };
  });
  res.json({ data });
}));

techniciansRouter.get('/me/history', requirePermission('work_orders.read_own'), ah(async (req, res) => {
  const rows = await tx(req, (db) => db.many(`SELECT w.id, w.number, w.title, w.status, w.actual_end, c.full_name AS customer_name FROM work_orders w JOIN customers c ON c.id = w.customer_id
    WHERE w.assigned_technician_id = $1 AND w.status IN ('completed','invoiced','paid','cancelled') ORDER BY COALESCE(w.actual_end, w.updated_at) DESC LIMIT 100`, [req.auth!.technicianId]));
  res.json({ data: rows });
}));

techniciansRouter.post('/me/attendance', requirePermission('work_orders.read_own'), ah(async (req, res) => {
  const b = parse(z.object({ action: z.enum(['check_in', 'check_out']), notes: z.string().max(500).nullish() }), req.body);
  const techId = req.auth!.technicianId;
  if (!techId) throw notFound('Technician profile');
  const out = await tx(req, async (db) => {
    const tz = (await db.one(`SELECT timezone FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId])).timezone;
    if (b.action === 'check_in') {
      return db.one(`INSERT INTO technician_attendance (tenant_id, technician_id, work_date, check_in_at, notes) VALUES ($1,$2,(now() AT TIME ZONE $3)::date, now(), $4)
        ON CONFLICT (technician_id, work_date) DO UPDATE SET check_in_at = COALESCE(technician_attendance.check_in_at, now()) RETURNING *`, [db.tenantId, techId, tz, b.notes ?? null]);
    }
    const r = await db.maybeOne(`UPDATE technician_attendance SET check_out_at = now(), notes = COALESCE($3, notes) WHERE technician_id = $1 AND work_date = (now() AT TIME ZONE $2)::date RETURNING *`,
      [techId, tz, b.notes ?? null]);
    if (!r) throw badRequest('Check in first');
    return r;
  });
  res.json({ data: out });
}));

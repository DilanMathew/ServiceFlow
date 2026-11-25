import type { Request } from 'express';
import type { Db } from '../../db/pool.js';
import { AppError, badRequest, conflict, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { audit } from '../../lib/audit.js';
import { nextNumber } from '../../lib/numbering.js';
import { notify } from '../notifications/service.js';
import { fmtDateTime } from '../common.js';
import { config } from '../../config.js';

export type WoStatus = 'new' | 'approved' | 'scheduled' | 'assigned' | 'en_route' | 'in_progress' | 'on_hold' | 'completed' | 'invoiced' | 'paid' | 'cancelled' | 'rejected';
export const OPEN_STATUSES: WoStatus[] = ['new', 'approved', 'scheduled', 'assigned', 'en_route', 'in_progress', 'on_hold'];
export const DONE_STATUSES: WoStatus[] = ['completed', 'invoiced', 'paid'];

/** Allowed manual transitions. 'invoiced' and 'paid' are set only by the billing module. */
export const TRANSITIONS: Record<WoStatus, WoStatus[]> = {
  new: ['approved', 'scheduled', 'cancelled', 'rejected'],
  approved: ['scheduled', 'cancelled'],
  scheduled: ['approved', 'cancelled', 'on_hold'],
  assigned: ['en_route', 'in_progress', 'on_hold', 'scheduled', 'cancelled'],
  en_route: ['in_progress', 'on_hold', 'assigned', 'cancelled'],
  in_progress: ['on_hold', 'completed'],
  on_hold: ['assigned', 'in_progress', 'scheduled', 'cancelled'],
  completed: ['in_progress'],
  invoiced: [], paid: [], cancelled: [], rejected: [],
};
/** Statuses a technician may move their own job into. */
const TECH_ALLOWED: WoStatus[] = ['en_route', 'in_progress', 'on_hold', 'completed'];

export interface CreateWo {
  customerId: string; addressId?: string | null; assetId?: string | null; serviceCategoryId?: string | null; serviceRequestId?: string | null;
  amcVisitId?: string | null; title: string; description?: string | null; priority?: string; scheduledStart?: string | null;
  expectedDurationMinutes?: number | null; internalNotes?: string | null; customerNotes?: string | null; estimatedCost?: number | null;
  branchId?: string | null; status?: 'new' | 'approved';
}

export async function createWorkOrder(db: Db, req: Request | null, w: CreateWo) {
  const customer = await db.maybeOne(`SELECT id, branch_id, archived_at FROM customers WHERE id = $1`, [w.customerId]);
  if (!customer) throw badRequest('Customer not found');
  if (customer.archived_at) throw unprocessable('Cannot create work for an archived customer');
  if (w.addressId && !(await db.maybeOne(`SELECT 1 FROM customer_addresses WHERE id = $1 AND customer_id = $2 AND deleted_at IS NULL`, [w.addressId, w.customerId])))
    throw badRequest('Service address does not belong to this customer');
  if (w.assetId && !(await db.maybeOne(`SELECT 1 FROM assets WHERE id = $1 AND customer_id = $2`, [w.assetId, w.customerId])))
    throw badRequest('Equipment does not belong to this customer');
  let duration = w.expectedDurationMinutes ?? null;
  if (!duration && w.serviceCategoryId) duration = (await db.maybeOne(`SELECT default_duration_minutes d FROM service_categories WHERE id = $1`, [w.serviceCategoryId]))?.d ?? null;
  const addressId = w.addressId ?? (await db.maybeOne(`SELECT id FROM customer_addresses WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC LIMIT 1`, [w.customerId]))?.id ?? null;
  const status = w.scheduledStart ? 'scheduled' : (w.status ?? 'new');
  const wo = await db.one(
    `INSERT INTO work_orders (tenant_id, branch_id, number, customer_id, address_id, asset_id, service_category_id, service_request_id, amc_visit_id, title, description,
       priority, status, scheduled_start, expected_duration_minutes, internal_notes, customer_notes, estimated_cost, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19) RETURNING *`,
    [db.tenantId, w.branchId ?? customer.branch_id ?? null, await nextNumber(db, 'job'), w.customerId, addressId, w.assetId ?? null, w.serviceCategoryId ?? null,
      w.serviceRequestId ?? null, w.amcVisitId ?? null, w.title, w.description ?? null, w.priority ?? 'normal', status, w.scheduledStart ?? null,
      duration ?? 60, w.internalNotes ?? null, w.customerNotes ?? null, w.estimatedCost ?? null, req?.auth?.userId ?? null]);
  await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by) VALUES ($1,$2,NULL,$3,'Created',$4)`,
    [db.tenantId, wo.id, status, req?.auth?.userId ?? null]);
  await audit(db, req, { action: 'work_order.created', entityType: 'work_order', entityId: wo.id, after: { number: wo.number, status, customer_id: wo.customer_id } });
  return wo;
}

async function lockWo(db: Db, id: string) {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound('Work order');
  const wo = await db.maybeOne(`SELECT * FROM work_orders WHERE id = $1 FOR UPDATE`, [id]);
  if (!wo) throw notFound('Work order');
  return wo;
}

export function assertOwnJob(req: Request, wo: { assigned_technician_id: string | null }) {
  if (req.auth!.permissions.has('work_orders.read')) return;
  if (!req.auth!.technicianId || wo.assigned_technician_id !== req.auth!.technicianId) throw notFound('Work order');
}

async function jobVars(db: Db, woId: string) {
  const r = await db.one(`SELECT w.number, w.scheduled_start, w.customer_id, u.full_name AS tech_name, u.id AS tech_user_id, s.timezone, s.locale
      FROM work_orders w LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
      JOIN tenant_settings s ON s.tenant_id = w.tenant_id WHERE w.id = $1`, [woId]);
  return { r, vars: { job: { number: r.number, scheduled: fmtDateTime(r.scheduled_start, r.timezone, r.locale) }, technician: { name: r.tech_name ?? 'our technician' },
    links: { feedback: `${config.APP_URL}/portal` } } };
}

export interface TransitionOpts { note?: string | null; holdReason?: string | null; cancellationReason?: string | null; expectedVersion?: number; system?: boolean;
  /** When the change really happened (offline replay). Clamped to [last change, now] and at most 72h back. */
  occurredAt?: string | null }

export async function transition(db: Db, req: Request | null, id: string, to: WoStatus, o: TransitionOpts = {}) {
  const wo = await lockWo(db, id);
  if (o.expectedVersion !== undefined && o.expectedVersion !== wo.version) throw conflict('This job was changed by someone else. Refresh and try again.');
  const from = wo.status as WoStatus;
  if (from === to) return wo;
  const isTech = req && !req.auth!.permissions.has('work_orders.status') && req.auth!.permissions.has('work_orders.execute');
  if (req && !o.system) {
    if (isTech) {
      assertOwnJob(req, wo);
      if (!TECH_ALLOWED.includes(to)) throw forbidden('Technicians cannot set this status');
    } else if (!req.auth!.permissions.has('work_orders.status') && !(to === 'cancelled' && req.auth!.permissions.has('work_orders.cancel'))) {
      throw forbidden();
    }
    if (['invoiced', 'paid'].includes(to)) throw unprocessable('Invoiced and paid statuses are set automatically by billing');
  }
  const allowed = o.system ? [...TRANSITIONS[from], 'invoiced', 'paid'] : TRANSITIONS[from];
  if (!allowed.includes(to)) throw new AppError(422, 'INVALID_TRANSITION', `A job cannot move from "${from.replace('_', ' ')}" to "${to.replace('_', ' ')}"`);
  if (to === 'scheduled' && !wo.scheduled_start) throw unprocessable('Set a scheduled date before marking the job as scheduled');
  if (['en_route', 'in_progress', 'completed'].includes(to) && !wo.assigned_technician_id) throw unprocessable('Assign a technician first');
  if (to === 'on_hold' && !o.holdReason && !o.note) throw badRequest('A reason is required to put a job on hold');
  if (to === 'cancelled' && !o.cancellationReason && !o.note) throw badRequest('A cancellation reason is required');
  if (to === 'completed') {
    const report = await db.maybeOne(`SELECT work_performed FROM service_reports WHERE work_order_id = $1`, [id]);
    if (!report?.work_performed && !o.note) throw unprocessable('Add the work performed (service report) before completing the job');
  }

  let at: Date | null = null;
  if (o.occurredAt) {
    const last = await db.maybeOne(`SELECT max(changed_at) AS t FROM work_order_status_history WHERE work_order_id = $1`, [id]);
    const floor = Math.max(Date.now() - 72 * 3600_000, last?.t ? new Date(last.t).getTime() : 0);
    at = new Date(Math.min(Date.now(), Math.max(floor, new Date(o.occurredAt).getTime())));
  }
  const sets: string[] = ['status = $2', 'version = version + 1'];
  const vals: unknown[] = [id, to];
  const push = (sql: string, v: unknown) => { vals.push(v); sets.push(sql.replace('?', `$${vals.length}`)); };
  if (to === 'in_progress' && !wo.actual_start) push('actual_start = COALESCE(?::timestamptz, now())', at);
  if (to === 'completed') { push('actual_end = COALESCE(?::timestamptz, now())', at); push('completed_by = ?', req?.auth?.userId ?? null); }
  if (to === 'in_progress' && from === 'completed') sets.push('actual_end = NULL');
  if (to === 'on_hold') push('hold_reason = ?', o.holdReason ?? o.note);
  if (to === 'cancelled' || to === 'rejected') push('cancellation_reason = ?', o.cancellationReason ?? o.note);
  if (['cancelled', 'rejected', 'approved', 'scheduled'].includes(to) && wo.assigned_technician_id) sets.push('assigned_technician_id = NULL');
  const updated = await db.one(`UPDATE work_orders SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, vals);

  // Free the technician's calendar when the job is no longer active
  if (['cancelled', 'rejected', 'completed', 'scheduled'].includes(to)) {
    await db.query(`UPDATE job_assignments SET is_current = (CASE WHEN $2 = 'completed' THEN is_current ELSE false END),
        ended_at = CASE WHEN $2 = 'completed' THEN ended_at ELSE now() END, end_reason = $2,
        time_window = CASE WHEN $2 = 'completed' THEN tstzrange(lower(time_window), GREATEST(lower(time_window), now()) + interval '1 second') ELSE time_window END
      WHERE work_order_id = $1 AND is_current`, [id, to]);
  }
  await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by, changed_at) VALUES ($1,$2,$3,$4,$5,$6,COALESCE($7::timestamptz, now()))`,
    [db.tenantId, id, from, to, o.note ?? o.holdReason ?? o.cancellationReason ?? null, req?.auth?.userId ?? null, at]);
  await audit(db, req, { action: 'work_order.status_changed', entityType: 'work_order', entityId: id, before: { status: from }, after: { status: to, note: o.note } });

  if (to === 'completed') await onCompleted(db, updated);
  if (to === 'cancelled' && wo.amc_visit_id) await db.query(`UPDATE scheduled_visits SET status = 'scheduled', work_order_id = NULL WHERE id = $1`, [wo.amc_visit_id]);
  if (to === 'cancelled' && wo.service_request_id) await db.query(`UPDATE service_requests SET status = 'cancelled' WHERE id = $1 AND status = 'converted'`, [wo.service_request_id]);

  const { vars } = await jobVars(db, id);
  if (to === 'en_route') await notify(db, { event: 'job.dispatched', customerId: wo.customer_id, entityType: 'work_order', entityId: id, vars, dedupeKey: `dispatch:${id}:${wo.version}` });
  if (to === 'completed') await notify(db, { event: 'job.completed', customerId: wo.customer_id, entityType: 'work_order', entityId: id, vars, dedupeKey: `complete:${id}` });
  return updated;
}

async function onCompleted(db: Db, wo: any) {
  if (wo.asset_id) {
    await db.query(`UPDATE assets a SET last_service_date = current_date, status = CASE WHEN status = 'under_repair' THEN 'active' ELSE status END,
        next_service_due = COALESCE(current_date + (SELECT e.maintenance_interval_days FROM equipment_categories e WHERE e.id = a.equipment_category_id), a.next_service_due)
      WHERE a.id = $1`, [wo.asset_id]);
  }
  if (wo.amc_visit_id) await db.query(`UPDATE scheduled_visits SET status = 'completed', completed_at = now() WHERE id = $1`, [wo.amc_visit_id]);
  // actual cost = labour + parts recorded on the job
  await db.query(`UPDATE work_orders SET actual_cost = (
      SELECT COALESCE((SELECT sum(hours * rate) FROM work_order_labour WHERE work_order_id = $1),0) + COALESCE((SELECT sum(quantity * unit_price) FROM work_order_parts WHERE work_order_id = $1),0))
    WHERE id = $1`, [wo.id]);
}

export interface AssignOpts { technicianId: string; scheduledStart?: string | null; durationMinutes?: number | null; source?: 'manual' | 'suggestion' | 'ai_suggestion'; force?: boolean; note?: string | null }

/** Returns non-blocking warnings (skill/area/working-hours) and enforces hard rules (overlap, time off, inactive). */
export async function assignmentChecks(db: Db, technicianId: string, wo: any, start: Date, end: Date) {
  const warnings: string[] = [];
  const tech = await db.maybeOne(`SELECT tp.*, u.is_active, u.full_name FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.id = $1`, [technicianId]);
  if (!tech) throw badRequest('Technician not found');
  if (!tech.is_active || tech.employment_status !== 'active') throw unprocessable(`${tech.full_name} is not available for assignments (${tech.employment_status})`);
  const off = await db.maybeOne(`SELECT reason FROM technician_time_off WHERE technician_id = $1 AND tstzrange(starts_at, ends_at) && tstzrange($2, $3)`, [technicianId, start, end]);
  if (off) throw new AppError(409, 'TECHNICIAN_UNAVAILABLE', `${tech.full_name} is on leave at that time${off.reason ? ` (${off.reason})` : ''}`);
  if (wo.service_category_id) {
    const skill = await db.maybeOne(`SELECT 1 FROM technician_skills WHERE technician_id = $1 AND service_category_id = $2`, [technicianId, wo.service_category_id]);
    if (!skill) warnings.push(`${tech.full_name} does not have the required skill for this service category`);
  }
  if (wo.address_id) {
    const area = await db.maybeOne(`SELECT a.service_area_id, (SELECT count(*) FROM technician_service_areas WHERE technician_id = $1)::int AS n,
        EXISTS (SELECT 1 FROM technician_service_areas WHERE technician_id = $1 AND service_area_id = a.service_area_id) AS covers
      FROM customer_addresses a WHERE a.id = $2`, [technicianId, wo.address_id]);
    if (area?.service_area_id && area.n > 0 && !area.covers) warnings.push(`The job location is outside ${tech.full_name}'s service areas`);
  }
  const s = await db.one(`SELECT timezone, working_days, working_hours_start, working_hours_end FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
  const local = await db.one(`SELECT extract(isodow FROM $1::timestamptz AT TIME ZONE $3)::int AS dow, ($1::timestamptz AT TIME ZONE $3)::time AS st,
      ($2::timestamptz AT TIME ZONE $3)::time AS et, ($1::timestamptz AT TIME ZONE $3)::date AS d`, [start, end, s.timezone]);
  const avail = await db.many(`SELECT start_time, end_time FROM technician_availability WHERE technician_id = $1 AND weekday = $2`, [technicianId, local.dow]);
  if (avail.length) {
    if (!avail.some((a) => a.start_time <= local.st && a.end_time >= local.et)) warnings.push(`Outside ${tech.full_name}'s working hours`);
  } else if (!s.working_days.includes(local.dow) || local.st < s.working_hours_start || local.et > s.working_hours_end) {
    warnings.push('Outside business working hours');
  }
  const holiday = await db.maybeOne(`SELECT name FROM holidays WHERE date = $1`, [local.d]);
  if (holiday) warnings.push(`The date is a holiday (${holiday.name})`);
  const load = await db.one(`SELECT count(*)::int n FROM job_assignments ja WHERE ja.technician_id = $1 AND ja.is_current
      AND (lower(ja.time_window) AT TIME ZONE $3)::date = $2 AND ja.work_order_id <> $4`, [technicianId, local.d, s.timezone, wo.id]);
  if (load.n >= tech.max_jobs_per_day) warnings.push(`${tech.full_name} already has ${load.n} jobs that day (limit ${tech.max_jobs_per_day})`);
  return { tech, warnings };
}

export async function assign(db: Db, req: Request | null, id: string, o: AssignOpts) {
  const wo = await lockWo(db, id);
  if (!['new', 'approved', 'scheduled', 'assigned', 'on_hold', 'en_route'].includes(wo.status)) throw unprocessable(`A ${wo.status.replace('_', ' ')} job cannot be (re)assigned`);
  const startIso = o.scheduledStart ?? wo.scheduled_start;
  if (!startIso) throw badRequest('A scheduled start time is required to assign a technician');
  const start = new Date(startIso);
  const duration = o.durationMinutes ?? wo.expected_duration_minutes;
  const end = new Date(start.getTime() + duration * 60_000);
  const { tech, warnings } = await assignmentChecks(db, o.technicianId, wo, start, end);
  if (warnings.length && !o.force) throw new AppError(409, 'ASSIGNMENT_WARNINGS', 'Please review the assignment warnings', { warnings });
  const settings = await db.one(`SELECT prevent_double_booking FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
  const previous = await db.maybeOne(`SELECT technician_id FROM job_assignments WHERE work_order_id = $1 AND is_current`, [id]);
  await db.query(`UPDATE job_assignments SET is_current = false, ended_at = now(), end_reason = 'reassigned' WHERE work_order_id = $1 AND is_current`, [id]);
  // The GiST exclusion constraint rejects overlapping windows atomically (raises 23P01 -> 409 SCHEDULE_CONFLICT)
  await db.query(`INSERT INTO job_assignments (tenant_id, work_order_id, technician_id, time_window, enforce_no_overlap, assigned_by, assignment_source)
      VALUES ($1,$2,$3,tstzrange($4,$5,'[)'),$6,$7,$8)`,
    [db.tenantId, id, o.technicianId, start, end, settings.prevent_double_booking, req?.auth?.userId ?? null, o.source ?? 'manual']);
  const newStatus = ['new', 'approved', 'scheduled', 'on_hold'].includes(wo.status) ? 'assigned' : wo.status;
  const updated = await db.one(`UPDATE work_orders SET assigned_technician_id = $2, scheduled_start = $3, expected_duration_minutes = $4, status = $5,
      accepted_at = NULL, version = version + 1 WHERE id = $1 RETURNING *`, [id, o.technicianId, start, duration, newStatus]);
  if (newStatus !== wo.status) await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [db.tenantId, id, wo.status, newStatus, `Assigned to ${tech.full_name}`, req?.auth?.userId ?? null]);
  await audit(db, req, { action: previous ? 'work_order.reassigned' : 'work_order.assigned', entityType: 'work_order', entityId: id,
    before: { technician_id: previous?.technician_id ?? null, scheduled_start: wo.scheduled_start }, after: { technician_id: o.technicianId, scheduled_start: start, warnings_acknowledged: warnings } });
  const { vars } = await jobVars(db, id);
  await notify(db, { event: 'job.assigned', customerId: wo.customer_id, entityType: 'work_order', entityId: id, vars,
    staffUserIds: [tech.user_id], inApp: { title: `New job assigned: ${wo.number}`, body: wo.title, link: `/tech/jobs/${id}` }, dedupeKey: `assign:${id}:${updated.version}` });
  return { workOrder: updated, warnings };
}

export async function unassign(db: Db, req: Request, id: string, reason?: string | null) {
  const wo = await lockWo(db, id);
  if (!wo.assigned_technician_id) return wo;
  if (['in_progress', 'completed', 'invoiced', 'paid'].includes(wo.status)) throw unprocessable('Cannot unassign a job that has started');
  await db.query(`UPDATE job_assignments SET is_current = false, ended_at = now(), end_reason = 'unassigned' WHERE work_order_id = $1 AND is_current`, [id]);
  const to = wo.scheduled_start ? 'scheduled' : 'approved';
  const updated = await db.one(`UPDATE work_orders SET assigned_technician_id = NULL, status = $2, version = version + 1 WHERE id = $1 RETURNING *`, [id, to]);
  await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [db.tenantId, id, wo.status, to, reason ?? 'Technician unassigned', req.auth!.userId]);
  await audit(db, req, { action: 'work_order.unassigned', entityType: 'work_order', entityId: id, before: { technician_id: wo.assigned_technician_id } });
  return updated;
}

export async function reschedule(db: Db, req: Request | null, id: string, scheduledStart: string, durationMinutes?: number | null, reason?: string | null, force = false) {
  const wo = await lockWo(db, id);
  if (!OPEN_STATUSES.includes(wo.status) || wo.status === 'in_progress') throw unprocessable(`A ${wo.status.replace('_', ' ')} job cannot be rescheduled`);
  const start = new Date(scheduledStart);
  if (isNaN(start.getTime())) throw badRequest('Invalid date');
  const duration = durationMinutes ?? wo.expected_duration_minutes;
  const end = new Date(start.getTime() + duration * 60_000);
  if (wo.assigned_technician_id) {
    const { warnings } = await assignmentChecks(db, wo.assigned_technician_id, wo, start, end);
    if (warnings.length && !force) throw new AppError(409, 'ASSIGNMENT_WARNINGS', 'Please review the scheduling warnings', { warnings });
    await db.query(`UPDATE job_assignments SET time_window = tstzrange($2,$3,'[)') WHERE work_order_id = $1 AND is_current`, [id, start, end]);
  }
  const status = wo.status === 'new' || wo.status === 'approved' ? 'scheduled' : wo.status === 'en_route' ? 'assigned' : wo.status;
  const updated = await db.one(`UPDATE work_orders SET scheduled_start = $2, expected_duration_minutes = $3, status = $4, reschedule_count = reschedule_count + $5,
      version = version + 1 WHERE id = $1 RETURNING *`, [id, start, duration, status, wo.scheduled_start ? 1 : 0]);
  await db.query(`INSERT INTO work_order_status_history (tenant_id, work_order_id, from_status, to_status, note, changed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [db.tenantId, id, wo.status, status, `${wo.scheduled_start ? 'Rescheduled' : 'Scheduled'} for ${start.toISOString()}${reason ? ` — ${reason}` : ''}`, req?.auth?.userId ?? null]);
  await audit(db, req, { action: wo.scheduled_start ? 'work_order.rescheduled' : 'work_order.scheduled', entityType: 'work_order', entityId: id,
    before: { scheduled_start: wo.scheduled_start }, after: { scheduled_start: start, reason } });
  if (wo.scheduled_start) {
    const { vars, r } = await jobVars(db, id);
    await notify(db, { event: 'job.rescheduled', customerId: wo.customer_id, entityType: 'work_order', entityId: id, vars, dedupeKey: `resched:${id}:${updated.version}`,
      staffUserIds: r.tech_user_id ? [r.tech_user_id] : [], inApp: { title: `Job ${wo.number} rescheduled`, link: `/tech/jobs/${id}` } });
  }
  return updated;
}

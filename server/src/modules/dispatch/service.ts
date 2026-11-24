import type { Db } from '../../db/pool.js';
import { notFound } from '../../lib/errors.js';
import { travelEstimate } from '../../integrations/maps.js';
import { getIntegration } from '../../integrations/registry.js';

export interface Suggestion {
  technicianId: string; name: string; score: number; available: boolean; reasons: string[]; blockers: string[];
  slotStart: string | null; travelMinutes: number | null; jobsThatDay: number;
}

/**
 * Rule-based technician ranking. Hard blockers (leave, overlapping job, inactive, daily cap) make a
 * technician unavailable; soft factors (skill, area, travel, workload, priority fit) produce the score.
 * Suggestions are advisory only: assignment always requires a human action.
 */
export async function suggestTechnicians(db: Db, workOrderId: string, desiredStart?: string | null): Promise<{ suggestions: Suggestion[]; start: string | null; durationMinutes: number }> {
  const wo = await db.maybeOne(`SELECT w.*, a.latitude, a.longitude, a.service_area_id FROM work_orders w LEFT JOIN customer_addresses a ON a.id = w.address_id WHERE w.id = $1`, [workOrderId]);
  if (!wo) throw notFound('Work order');
  const s = await db.one(`SELECT timezone, working_hours_start, working_hours_end, working_days FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
  const duration = wo.expected_duration_minutes;
  const startIso = desiredStart ?? (wo.scheduled_start ? new Date(wo.scheduled_start).toISOString() : null);
  const maps = await getIntegration(db.tenantId!, 'maps');

  const techs = await db.many(`SELECT tp.id, tp.max_jobs_per_day, tp.home_latitude, tp.home_longitude, tp.branch_id, u.full_name
    FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE u.is_active AND tp.employment_status = 'active'`);
  const out: Suggestion[] = [];
  for (const t of techs) {
    const reasons: string[] = []; const blockers: string[] = []; let score = 50;
    if (wo.service_category_id) {
      const skill = await db.maybeOne(`SELECT proficiency FROM technician_skills WHERE technician_id = $1 AND service_category_id = $2`, [t.id, wo.service_category_id]);
      if (skill) { score += 20 + skill.proficiency * 3; reasons.push(`Skilled in this service (level ${skill.proficiency}/5)`); }
      else { score -= 25; reasons.push('No recorded skill for this service'); }
    }
    if (wo.service_area_id) {
      const area = await db.maybeOne(`SELECT 1 FROM technician_service_areas WHERE technician_id = $1 AND service_area_id = $2`, [t.id, wo.service_area_id]);
      if (area) { score += 15; reasons.push('Covers this service area'); } else score -= 5;
    }
    if (wo.branch_id && t.branch_id && wo.branch_id !== t.branch_id) { score -= 10; reasons.push('Belongs to another branch'); }
    let slotStart: string | null = startIso; let jobsThatDay = 0; let travelMinutes: number | null = null;
    const day = startIso ?? new Date().toISOString();
    const dayRow = await db.one(`SELECT count(*)::int n FROM job_assignments WHERE technician_id = $1 AND is_current AND work_order_id <> $4
      AND (lower(time_window) AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date`, [t.id, day, s.timezone, wo.id]);
    jobsThatDay = dayRow.n;
    if (jobsThatDay >= t.max_jobs_per_day) blockers.push(`Daily limit reached (${jobsThatDay}/${t.max_jobs_per_day})`);
    score -= jobsThatDay * 6;
    if (startIso) {
      const end = new Date(new Date(startIso).getTime() + duration * 60_000).toISOString();
      const clash = await db.maybeOne(`SELECT w.number FROM job_assignments ja JOIN work_orders w ON w.id = ja.work_order_id WHERE ja.technician_id = $1 AND ja.is_current
        AND ja.work_order_id <> $4 AND ja.time_window && tstzrange($2::timestamptz, $3::timestamptz)`, [t.id, startIso, end, wo.id]);
      if (clash) blockers.push(`Busy with ${clash.number} at that time`);
      const off = await db.maybeOne(`SELECT 1 FROM technician_time_off WHERE technician_id = $1 AND tstzrange(starts_at, ends_at) && tstzrange($2::timestamptz, $3::timestamptz)`, [t.id, startIso, end]);
      if (off) blockers.push('On leave');
    } else {
      // Find the first free slot today/tomorrow within business hours
      const slot = await db.maybeOne(`WITH days AS (SELECT d::date FROM generate_series((now() AT TIME ZONE $2)::date, (now() AT TIME ZONE $2)::date + 6, interval '1 day') d
            WHERE extract(isodow FROM d)::int = ANY($5)),
          candidates AS (SELECT ((d + $3::time + (n * interval '30 minutes')) AT TIME ZONE $2) AS st FROM days, generate_series(0, 40) n
            WHERE (d + $3::time + (n * interval '30 minutes') + ($6 || ' minutes')::interval)::time <= $4::time AND (d + $3::time + (n * interval '30 minutes')) AT TIME ZONE $2 > now())
        SELECT st FROM candidates c WHERE NOT EXISTS (SELECT 1 FROM job_assignments ja WHERE ja.technician_id = $1 AND ja.is_current
            AND ja.time_window && tstzrange(c.st, c.st + ($6 || ' minutes')::interval))
          AND NOT EXISTS (SELECT 1 FROM technician_time_off o WHERE o.technician_id = $1 AND tstzrange(o.starts_at, o.ends_at) && tstzrange(c.st, c.st + ($6 || ' minutes')::interval))
        ORDER BY st LIMIT 1`, [t.id, s.timezone, s.working_hours_start, s.working_hours_end, s.working_days, String(duration)]);
      slotStart = slot ? new Date(slot.st).toISOString() : null;
      if (!slotStart) blockers.push('No free slot in the next 7 days');
      else reasons.push('Earliest free slot found');
    }
    if (wo.latitude && wo.longitude) {
      // origin: previous job location that day, else technician home base
      const prev = slotStart ? await db.maybeOne(`SELECT a.latitude, a.longitude FROM job_assignments ja JOIN work_orders w ON w.id = ja.work_order_id
          JOIN customer_addresses a ON a.id = w.address_id WHERE ja.technician_id = $1 AND ja.is_current AND upper(ja.time_window) <= $2::timestamptz
          AND (lower(ja.time_window) AT TIME ZONE $3)::date = ($2::timestamptz AT TIME ZONE $3)::date AND a.latitude IS NOT NULL ORDER BY upper(ja.time_window) DESC LIMIT 1`, [t.id, slotStart, s.timezone]) : null;
      const origin = prev ?? (t.home_latitude ? { latitude: t.home_latitude, longitude: t.home_longitude } : null);
      if (origin) {
        const est = await travelEstimate({ lat: Number(origin.latitude), lng: Number(origin.longitude) }, { lat: Number(wo.latitude), lng: Number(wo.longitude) }, maps);
        travelMinutes = est.minutes;
        score += Math.max(-20, 20 - Math.round(est.minutes / 3));
        reasons.push(`~${est.minutes} min travel (${est.km} km${est.source === 'estimate' ? ', estimated' : ''})`);
      }
    }
    if (wo.priority === 'urgent' && jobsThatDay === 0) { score += 10; reasons.push('Free for an urgent job'); }
    out.push({ technicianId: t.id, name: t.full_name, score: Math.max(0, Math.min(100, score)), available: blockers.length === 0, reasons, blockers, slotStart, travelMinutes, jobsThatDay });
  }
  out.sort((a, b) => Number(b.available) - Number(a.available) || b.score - a.score);
  return { suggestions: out, start: startIso, durationMinutes: duration };
}

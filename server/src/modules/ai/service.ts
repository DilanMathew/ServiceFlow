import type { Db } from '../../db/pool.js';
import { aiJson, aiProviderName, type AiResult } from '../../integrations/ai.js';
import { getEntitlements } from '../subscriptions/entitlements.js';
import { AppError } from '../../lib/errors.js';
import { suggestTechnicians } from '../dispatch/service.js';

type Feature = 'request_interpretation' | 'report_generation' | 'scheduling' | 'insights' | 'support_assistant';

/** Enforces the plan quota and records every AI call (provider, tokens, latency, outcome). */
async function run<T>(db: Db, userId: string | null, feature: Feature, call: (useLlm: boolean) => Promise<AiResult<T>>): Promise<AiResult<T> & { quotaExceeded?: boolean }> {
  const ent = await getEntitlements(db.tenantId!);
  if (!ent.features.ai) throw new AppError(403, 'FEATURE_NOT_IN_PLAN', 'AI features are not included in your plan');
  const used = await db.one(`SELECT count(*)::int n FROM ai_usage_logs WHERE status = 'success' AND provider <> 'rules' AND created_at >= date_trunc('month', now())`);
  const overQuota = aiProviderName() !== 'rules' && used.n >= ent.limits.aiRequestsPerMonth;
  const started = Date.now();
  const r = await call(!overQuota);
  await db.query(`INSERT INTO ai_usage_logs (tenant_id, user_id, feature, provider, model, input_tokens, output_tokens, latency_ms, status, error) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [db.tenantId, userId, feature, r.provider, r.model, r.inputTokens, r.outputTokens, Date.now() - started, overQuota ? 'rate_limited' : 'success', r.fallback ? 'provider error; rules fallback used' : null]);
  return { ...r, quotaExceeded: overQuota };
}
const rulesOnly = <T>(data: T): AiResult<T> => ({ data, provider: 'rules', model: null, inputTokens: 0, outputTokens: 0, fallback: false });

// ------------------------------------------------------------------ 1. request interpretation
const EQUIPMENT_WORDS: [RegExp, string][] = [
  [/\b(ac|a\/c|air ?con\w*|split|window unit|hvac|cooling)\b/i, 'Air conditioner'], [/\b(generator|genset|dg set|diesel gen)\b/i, 'Generator'],
  [/\b(inverter|solar|panel|pv)\b/i, 'Solar / inverter'], [/\b(cctv|camera|dvr|nvr)\b/i, 'CCTV system'], [/\b(fridge|refrigerator)\b/i, 'Refrigerator'],
  [/\b(washing machine|washer)\b/i, 'Washing machine'], [/\b(purifier|ro\b|water filter)\b/i, 'Water purifier'], [/\b(geyser|water heater|boiler)\b/i, 'Water heater'],
  [/\b(pipe|tap|leak(ing)? pipe|drain|toilet|plumb\w*)\b/i, 'Plumbing'], [/\b(wiring|switch|socket|mcb|breaker|short circuit|electric\w*)\b/i, 'Electrical'],
];
const URGENT = /\b(fire|smoke|sparks?|burning|shock|flood\w*|gas leak|no power|emergency|urgent|immediately|dangerous)\b/i;
const HIGH = /\b(not working|stopped|dead|won'?t (start|turn on)|no cooling|leak\w*|broken|tripping|elderly|baby|hospital)\b/i;

export function interpretRules(text: string, categories: { id: string; name: string }[]) {
  const equipment = EQUIPMENT_WORDS.find(([re]) => re.test(text))?.[1] ?? null;
  const words = text.toLowerCase();
  const scored = categories.map((c) => {
    const tokens = c.name.toLowerCase().split(/[^a-z0-9]+/).filter((t) => t.length > 1);
    let s = tokens.reduce((a, t) => a + (words.includes(t) ? 2 : 0), 0);
    if (equipment && c.name.toLowerCase().includes(equipment.split(' ')[0].toLowerCase().slice(0, 4))) s += 2;
    if (/repair|not working|leak|noise|broken|fault|issue|problem/.test(words) && /repair/i.test(c.name)) s += 3;
    if (/install|new|fit|mount/.test(words) && /install/i.test(c.name)) s += 3;
    if (/service|clean|maintenance|check/.test(words) && /servic|clean|mainten/i.test(c.name)) s += 2;
    return { c, s };
  }).sort((a, b) => b.s - a.s);
  const category = scored[0]?.s > 0 ? scored[0].c : null;
  const priority = URGENT.test(text) ? 'urgent' : HIGH.test(text) ? 'high' : 'normal';
  const missing: string[] = [];
  if (!/\b(model|brand|make|lg|samsung|daikin|voltas|blue ?star|carrier|hitachi|panasonic|bosch|whirlpool|honeywell|kirloskar|cummins)\b/i.test(text)) missing.push('Equipment brand and model');
  if (!/\b(today|tomorrow|morning|afternoon|evening|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(:\d{2})?\s?(am|pm))\b/i.test(text)) missing.push('Preferred date and time');
  if (!/\b(since|days?|weeks?|yesterday|hours?)\b/i.test(text)) missing.push('How long the problem has been happening');
  if (text.length < 40) missing.push('A more detailed description of the problem');
  const summary = text.replace(/\s+/g, ' ').trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 200);
  return { serviceCategoryId: category?.id ?? null, serviceCategory: category?.name ?? null, equipmentType: equipment, summary, priority,
    priorityReason: priority === 'urgent' ? 'Possible safety risk mentioned' : priority === 'high' ? 'Equipment not working / active fault' : 'No urgency indicators',
    missingInformation: missing, confidence: category ? 0.6 : 0.3 };
}

export async function interpretRequest(db: Db, userId: string | null, text: string) {
  const categories = await db.many(`SELECT id, name FROM service_categories WHERE is_active ORDER BY name`);
  return run(db, userId, 'request_interpretation', (llm) => llm ? aiJson({
    system: 'You triage incoming field-service requests for a service business. Choose the best matching service category ONLY from the provided list (or null). Be concise and factual. Do not invent details the customer did not state.',
    prompt: `Service categories: ${JSON.stringify(categories.map((c) => c.name))}\n\nCustomer message:\n"""${text.slice(0, 4000)}"""`,
    schema: { type: 'object', additionalProperties: false, required: ['serviceCategory', 'equipmentType', 'summary', 'priority', 'priorityReason', 'missingInformation', 'confidence'],
      properties: { serviceCategory: { type: ['string', 'null'] }, equipmentType: { type: ['string', 'null'] }, summary: { type: 'string' },
        priority: { type: 'string', enum: ['low', 'normal', 'high', 'urgent'] }, priorityReason: { type: 'string' }, missingInformation: { type: 'array', items: { type: 'string' } },
        confidence: { type: 'number' } } },
    fallback: () => interpretRules(text, categories),
  }).then((r) => ({ ...r, data: { ...r.data, serviceCategoryId: categories.find((c) => c.name === (r.data as any).serviceCategory)?.id ?? (r.data as any).serviceCategoryId ?? null } as any }))
    : Promise.resolve(rulesOnly(interpretRules(text, categories))));
}

// ------------------------------------------------------------------ 2. service report generation
export function reportRules(notes: string, ctx: { issue: string | null; parts: string[]; equipment: string | null }) {
  const sentences = notes.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
  const pick = (re: RegExp) => sentences.filter((s) => re.test(s));
  const findings = pick(/found|observ|noticed|check(ed)?|inspect|low|dirty|clog|worn|damag|fault|leak|loose|burnt|corrod/i);
  const work = pick(/replac|clean|fix|repair|refill|tighten|install|adjust|serviced|flush|test(ed)?|reset|changed|recharg|charged/i);
  const recs = pick(/recommend|suggest|should|advise|next|need(s)? to|consider|replace soon/i);
  const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
  return {
    reportedIssue: ctx.issue ?? 'As reported by the customer.',
    findings: (findings.length ? findings : sentences.slice(0, 2)).map(cap).join(' ') || 'Inspection completed.',
    workPerformed: (work.length ? work : sentences).map(cap).join(' ') || 'Service carried out as required.',
    partsUsed: ctx.parts.length ? ctx.parts.join(', ') : 'No parts used.',
    recommendations: recs.map(cap).join(' ') || `Schedule routine preventive maintenance${ctx.equipment ? ` for the ${ctx.equipment}` : ''}.`,
    followUpRequired: /follow[- ]?up|revisit|come back|order(ed)? part|awaiting/i.test(notes),
    followUpNotes: pick(/follow[- ]?up|revisit|come back|order|awaiting/i).join(' ') || null,
  };
}

export async function generateReport(db: Db, userId: string | null, workOrderId: string, notes: string) {
  const wo = await db.one(`SELECT w.description, w.title, ast.name AS equipment FROM work_orders w LEFT JOIN assets ast ON ast.id = w.asset_id WHERE w.id = $1`, [workOrderId]);
  const parts = (await db.many(`SELECT description, quantity FROM work_order_parts WHERE work_order_id = $1`, [workOrderId])).map((p) => `${p.description} × ${Number(p.quantity)}`);
  const ctx = { issue: wo.description ?? wo.title, parts, equipment: wo.equipment };
  return run(db, userId, 'report_generation', (llm) => llm ? aiJson({
    system: 'Convert a field technician\'s rough notes into a clear, professional customer-facing service report. Use only facts in the notes and context; never invent measurements, parts or work. Plain language, no markdown.',
    prompt: `Reported issue: ${ctx.issue ?? 'n/a'}\nEquipment: ${ctx.equipment ?? 'n/a'}\nParts recorded: ${parts.join('; ') || 'none'}\n\nTechnician notes:\n"""${notes.slice(0, 6000)}"""`,
    schema: { type: 'object', additionalProperties: false, required: ['reportedIssue', 'findings', 'workPerformed', 'partsUsed', 'recommendations', 'followUpRequired', 'followUpNotes'],
      properties: { reportedIssue: { type: 'string' }, findings: { type: 'string' }, workPerformed: { type: 'string' }, partsUsed: { type: 'string' }, recommendations: { type: 'string' },
        followUpRequired: { type: 'boolean' }, followUpNotes: { type: ['string', 'null'] } } },
    fallback: () => reportRules(notes, ctx),
  }) : Promise.resolve(rulesOnly(reportRules(notes, ctx))));
}

// ------------------------------------------------------------------ 3. scheduling assistant (advisory)
export async function schedulingAdvice(db: Db, userId: string | null, workOrderId: string, start?: string) {
  const s = await suggestTechnicians(db, workOrderId, start);
  const top = s.suggestions.filter((x) => x.available).slice(0, 3);
  const rulesText = top.length
    ? `Recommended: ${top[0].name} (score ${top[0].score}). ${top[0].reasons.slice(0, 3).join('; ')}.${top[1] ? ` Alternative: ${top[1].name} (score ${top[1].score}).` : ''}`
    : 'No technician is available for this slot. Try another time or adjust the duration.';
  const r = await run(db, userId, 'scheduling', (llm) => llm && top.length ? aiJson({
    system: 'You advise a human dispatcher. Explain briefly which technician to choose from the ranked candidates and why. You cannot assign jobs; the dispatcher decides.',
    prompt: `Candidates (pre-filtered for availability, highest score first): ${JSON.stringify(top.map((t) => ({ name: t.name, score: t.score, reasons: t.reasons, travelMinutes: t.travelMinutes, jobsThatDay: t.jobsThatDay })))}`,
    schema: { type: 'object', additionalProperties: false, required: ['recommendation', 'explanation'], properties: { recommendation: { type: 'string' }, explanation: { type: 'string' } } },
    fallback: () => ({ recommendation: top[0]?.name ?? '', explanation: rulesText }),
  }) : Promise.resolve(rulesOnly({ recommendation: top[0]?.name ?? '', explanation: rulesText })));
  return { ...s, advice: r.data, provider: r.provider, requiresApproval: true };
}

// ------------------------------------------------------------------ 4. business insights (aggregates only)
export async function businessInsights(db: Db, userId: string | null) {
  const m = await db.one(`SELECT
      (SELECT count(*) FROM work_orders WHERE status IN ('new','approved','scheduled'))::int AS pending_now,
      (SELECT count(*) FROM work_orders WHERE created_at > now() - interval '30 days')::int AS jobs_30d,
      (SELECT count(*) FROM work_orders WHERE created_at BETWEEN now() - interval '60 days' AND now() - interval '30 days')::int AS jobs_prev_30d,
      (SELECT COALESCE(sum(total),0) FROM invoices WHERE status NOT IN ('draft','cancelled') AND issued_at > now() - interval '30 days') AS invoiced_30d,
      (SELECT COALESCE(sum(total),0) FROM invoices WHERE status NOT IN ('draft','cancelled') AND issued_at BETWEEN now() - interval '60 days' AND now() - interval '30 days') AS invoiced_prev_30d,
      (SELECT COALESCE(sum(amount),0) FROM payments WHERE status = 'succeeded' AND received_at > now() - interval '30 days') AS collected_30d,
      (SELECT COALESCE(sum(balance_due),0) FROM invoices WHERE status IN ('issued','partially_paid','overdue')) AS outstanding,
      (SELECT count(*) FROM invoices WHERE status IN ('issued','partially_paid','overdue') AND due_date < current_date)::int AS overdue_invoices,
      (SELECT count(*) FROM amc_contracts WHERE status = 'active' AND end_date <= current_date + 60)::int AS amc_expiring_60d,
      (SELECT COALESCE(sum(contract_value),0) FROM amc_contracts WHERE status = 'active' AND end_date <= current_date + 60) AS amc_renewal_value,
      (SELECT currency FROM tenant_settings WHERE tenant_id = current_tenant_id()) AS currency`);
  const workload = await db.many(`SELECT u.full_name AS technician, count(w.id)::int AS open_jobs FROM technician_profiles tp JOIN users u ON u.id = tp.user_id
    LEFT JOIN work_orders w ON w.assigned_technician_id = tp.id AND w.status IN ('assigned','en_route','in_progress','on_hold') WHERE u.is_active GROUP BY 1 ORDER BY 2 DESC`);
  const equipment = await db.many(`SELECT COALESCE(e.name, a.name) AS equipment, count(*)::int AS services FROM work_orders w JOIN assets a ON a.id = w.asset_id
    LEFT JOIN equipment_categories e ON e.id = a.equipment_category_id WHERE w.created_at > now() - interval '180 days' GROUP BY 1 ORDER BY 2 DESC LIMIT 5`);
  const pct = (a: number, b: number) => (b ? Math.round(((a - b) / b) * 100) : null);
  const metrics = { ...m, job_trend_pct: pct(m.jobs_30d, m.jobs_prev_30d), revenue_trend_pct: pct(Number(m.invoiced_30d), Number(m.invoiced_prev_30d)), workload, equipment };
  const fallback = () => {
    const out: { title: string; detail: string; type: 'trend' | 'risk' | 'opportunity' | 'workload' }[] = [];
    out.push({ type: 'trend', title: `Jobs ${metrics.job_trend_pct === null ? 'this month' : metrics.job_trend_pct >= 0 ? `up ${metrics.job_trend_pct}%` : `down ${Math.abs(metrics.job_trend_pct)}%`}`,
      detail: `${m.jobs_30d} jobs in the last 30 days vs ${m.jobs_prev_30d} in the previous 30. ${m.pending_now} jobs are waiting to be scheduled or assigned.` });
    out.push({ type: 'trend', title: `Revenue ${metrics.revenue_trend_pct === null ? '' : metrics.revenue_trend_pct >= 0 ? `up ${metrics.revenue_trend_pct}%` : `down ${Math.abs(metrics.revenue_trend_pct)}%`}`.trim(),
      detail: `Invoiced ${m.currency} ${Number(m.invoiced_30d).toFixed(0)} and collected ${m.currency} ${Number(m.collected_30d).toFixed(0)} in the last 30 days.` });
    if (Number(m.outstanding) > 0) out.push({ type: 'risk', title: `${m.currency} ${Number(m.outstanding).toFixed(0)} outstanding`, detail: `${m.overdue_invoices} invoice(s) are past due. Prioritise follow-up on the oldest balances.` });
    if (m.amc_expiring_60d) out.push({ type: 'opportunity', title: `${m.amc_expiring_60d} AMC renewal(s) in 60 days`, detail: `Renewal value ${m.currency} ${Number(m.amc_renewal_value).toFixed(0)}. Send renewal quotations early.` });
    if (workload.length > 1 && workload[0].open_jobs >= 2 * Math.max(1, workload[workload.length - 1].open_jobs))
      out.push({ type: 'workload', title: 'Uneven technician workload', detail: `${workload[0].technician} has ${workload[0].open_jobs} open jobs while ${workload[workload.length - 1].technician} has ${workload[workload.length - 1].open_jobs}.` });
    if (equipment[0]) out.push({ type: 'opportunity', title: `Most serviced: ${equipment[0].equipment}`, detail: `${equipment[0].services} services in 6 months — a candidate for AMC packages.` });
    return { insights: out };
  };
  const r = await run(db, userId, 'insights', (llm) => llm ? aiJson({
    system: 'You are a business analyst for a field-service company. From the aggregate metrics, write 4-6 short, actionable insights. Use only the numbers given.',
    prompt: JSON.stringify(metrics),
    schema: { type: 'object', additionalProperties: false, required: ['insights'], properties: { insights: { type: 'array', items: { type: 'object', additionalProperties: false,
      required: ['title', 'detail', 'type'], properties: { title: { type: 'string' }, detail: { type: 'string' }, type: { type: 'string', enum: ['trend', 'risk', 'opportunity', 'workload'] } } } } } },
    fallback,
  }) : Promise.resolve(rulesOnly(fallback())));
  return { metrics, ...r.data, provider: r.provider };
}

// ------------------------------------------------------------------ 5. customer support assistant
/**
 * Answers a customer's question using ONLY that customer's records in this tenant (the db handle is
 * RLS-scoped to the tenant and every query filters by customer_id). It never executes actions:
 * it may propose one, which the portal UI asks the customer to confirm through the normal endpoints.
 */
export async function supportAssistant(db: Db, userId: string, customerId: string, message: string) {
  const [jobs, invoices, contracts, business] = await Promise.all([
    db.many(`SELECT w.id, w.number, w.title, w.status, w.scheduled_start, u.full_name AS technician FROM work_orders w LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id
      LEFT JOIN users u ON u.id = tp.user_id WHERE w.customer_id = $1 ORDER BY w.created_at DESC LIMIT 10`, [customerId]),
    db.many(`SELECT id, number, status, total, balance_due, currency, due_date FROM invoices WHERE customer_id = $1 AND status NOT IN ('draft') ORDER BY created_at DESC LIMIT 10`, [customerId]),
    db.many(`SELECT number, title, status, end_date, (SELECT min(due_date) FROM scheduled_visits v WHERE v.contract_id = m.id AND v.status = 'scheduled') AS next_visit FROM amc_contracts m WHERE customer_id = $1 AND status IN ('active','expired')`, [customerId]),
    db.one(`SELECT t.name, t.phone, t.email, s.cancellation_policy, s.cancellation_notice_hours FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`),
  ]);
  const ctx = { business: { name: business.name, phone: business.phone, email: business.email, cancellationPolicy: business.cancellation_policy, noticeHours: business.cancellation_notice_hours }, jobs, invoices, contracts };
  const fallback = () => {
    const t = message.toLowerCase();
    const openJob = jobs.find((j) => ['scheduled', 'assigned', 'en_route', 'in_progress', 'approved', 'new'].includes(j.status));
    if (/(invoice|bill|pay|due|outstanding|balance)/.test(t)) {
      const due = invoices.filter((i) => Number(i.balance_due) > 0);
      return { answer: due.length ? `You have ${due.length} invoice(s) with a balance: ${due.map((i) => `${i.number} — ${i.currency} ${Number(i.balance_due).toFixed(2)} due ${i.due_date}`).join('; ')}. You can pay from the Invoices page.`
        : 'You have no outstanding invoices. Thank you!', proposedAction: due[0] ? { type: 'pay_invoice', id: due[0].id, label: `Pay ${due[0].number}` } : null };
    }
    if (/(cancel|reschedul|change.*(time|date)|postpone)/.test(t) && openJob) {
      return { answer: `Your job ${openJob.number} is currently ${openJob.status.replace('_', ' ')}${openJob.scheduled_start ? ` for ${new Date(openJob.scheduled_start).toLocaleString()}` : ''}. ${business.cancellation_policy ?? `Please give at least ${business.cancellation_notice_hours} hours notice.`} I can send a request to ${business.name} for you — please confirm.`,
        proposedAction: { type: /cancel/.test(t) ? 'request_cancellation' : 'request_reschedule', id: openJob.id, label: /cancel/.test(t) ? `Request cancellation of ${openJob.number}` : `Request reschedule of ${openJob.number}` } };
    }
    if (/(when|status|technician|arriv|coming|visit)/.test(t) && openJob) {
      return { answer: `Job ${openJob.number} (${openJob.title}) is ${openJob.status.replace('_', ' ')}${openJob.scheduled_start ? `, scheduled for ${new Date(openJob.scheduled_start).toLocaleString()}` : ''}${openJob.technician ? ` with ${openJob.technician}` : ''}.`, proposedAction: null };
    }
    if (/(amc|contract|maintenance)/.test(t) && contracts.length) {
      return { answer: contracts.map((c) => `${c.number} (${c.title}) is ${c.status}, ends ${c.end_date}${c.next_visit ? `, next visit due ${c.next_visit}` : ''}.`).join(' '), proposedAction: null };
    }
    return { answer: `I can help with your jobs, invoices and maintenance contracts. For anything else, contact ${business.name}${business.phone ? ` at ${business.phone}` : ''}.`, proposedAction: null };
  };
  const r = await run(db, userId, 'support_assistant', (llm) => llm ? aiJson({
    system: `You are the customer support assistant for ${business.name}. Answer ONLY from the JSON context about this customer's own records. If the answer is not in the context, say so and give the business contact details. Never reveal internal notes or other customers. You cannot perform actions: if the customer wants to pay, cancel or reschedule, propose exactly one action with the id from the context; the customer must confirm it in the app.`,
    prompt: `Context: ${JSON.stringify(ctx)}\n\nCustomer question: """${message.slice(0, 2000)}"""`,
    schema: { type: 'object', additionalProperties: false, required: ['answer', 'proposedAction'], properties: { answer: { type: 'string' },
      proposedAction: { anyOf: [{ type: 'null' }, { type: 'object', additionalProperties: false, required: ['type', 'id', 'label'], properties: {
        type: { type: 'string', enum: ['pay_invoice', 'request_cancellation', 'request_reschedule'] }, id: { type: 'string' }, label: { type: 'string' } } }] } } },
    fallback,
  }) : Promise.resolve(rulesOnly(fallback())));
  // Never trust model-proposed ids: they must belong to this customer's records
  const a = (r.data as any).proposedAction;
  if (a && !(a.type === 'pay_invoice' ? invoices.some((i) => i.id === a.id) : jobs.some((j) => j.id === a.id))) (r.data as any).proposedAction = null;
  return { ...(r.data as any), provider: r.provider, requiresConfirmation: !!(r.data as any).proposedAction };
}

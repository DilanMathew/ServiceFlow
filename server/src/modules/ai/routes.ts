import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { notFound } from '../../lib/errors.js';
import { tx } from '../common.js';
import { assertOwnJob } from '../workorders/service.js';
import { businessInsights, generateReport, interpretRequest, schedulingAdvice } from './service.js';
import { aiProviderName } from '../../integrations/ai.js';
import { getEntitlements } from '../subscriptions/entitlements.js';

export const aiRouter = Router();
aiRouter.use(requirePermission('ai.use'));

aiRouter.get('/status', ah(async (req, res) => {
  const ent = await getEntitlements(req.auth!.tenantId!);
  const used = await tx(req, (db) => db.one(`SELECT count(*) FILTER (WHERE provider <> 'rules' AND status = 'success')::int AS llm, count(*)::int AS total FROM ai_usage_logs WHERE created_at >= date_trunc('month', now())`));
  res.json({ data: { provider: aiProviderName(), quota: ent.limits.aiRequestsPerMonth, usedThisMonth: used.llm, totalRequests: used.total } });
}));

aiRouter.post('/interpret', ah(async (req, res) => {
  const b = parse(z.object({ text: z.string().trim().min(5).max(4000) }), req.body);
  const r = await tx(req, (db) => interpretRequest(db, req.auth!.userId, b.text));
  res.json({ data: { ...r.data, provider: r.provider, requiresConfirmation: true } });
}));

aiRouter.post('/service-report/:workOrderId', requirePermission('work_orders.update', 'work_orders.execute'), ah(async (req, res) => {
  const b = parse(z.object({ notes: z.string().trim().min(5).max(6000) }), req.body);
  const r = await tx(req, async (db) => {
    const wo = await db.maybeOne(`SELECT id, assigned_technician_id FROM work_orders WHERE id = $1`, [req.params.workOrderId]);
    if (!wo) throw notFound('Work order');
    assertOwnJob(req, wo);
    return generateReport(db, req.auth!.userId, wo.id, b.notes);
  });
  res.json({ data: { ...r.data, provider: r.provider, requiresReview: true } });
}));

aiRouter.get('/schedule/:workOrderId', requirePermission('work_orders.assign'), ah(async (req, res) => {
  const q = parse(z.object({ start: z.string().datetime({ offset: true }).optional() }), req.query);
  res.json({ data: await tx(req, (db) => schedulingAdvice(db, req.auth!.userId, req.params.workOrderId, q.start)) });
}));

aiRouter.get('/insights', requirePermission('dashboard.view'), ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => businessInsights(db, req.auth!.userId)) });
}));

aiRouter.get('/usage', requirePermission('settings.manage'), ah(async (req, res) => {
  res.json({ data: await tx(req, (db) => db.many(`SELECT feature, provider, status, count(*)::int AS requests, sum(input_tokens)::int AS input_tokens, sum(output_tokens)::int AS output_tokens
    FROM ai_usage_logs WHERE created_at >= date_trunc('month', now()) GROUP BY 1,2,3 ORDER BY 4 DESC`)) });
}));

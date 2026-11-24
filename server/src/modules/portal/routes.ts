import { Router, type Request, type Response, type NextFunction } from 'express';
import { z } from 'zod';
import { requireFeature } from '../../auth/middleware.js';
import { ah, dateStr, parse } from '../../lib/http.js';
import { AppError, badRequest, forbidden, notFound, unprocessable } from '../../lib/errors.js';
import { withTenant, type Db } from '../../db/pool.js';
import { audit } from '../../lib/audit.js';
import { createServiceRequest } from '../requests/routes.js';
import { decideQuotation, quotationDetail, quotationPdf } from '../quotations/routes.js';
import { invoiceDetail, invoicePdf } from '../invoices/routes.js';
import { receiptPdf } from '../payments/routes.js';
import { createPaymentLink } from '../payments/service.js';
import { createTicket } from '../support/routes.js';
import { upload, storeDocument, signFileToken } from '../documents/routes.js';
import { createAsset } from '../assets/routes.js';
import { supportAssistant } from '../ai/service.js';
import { notify, staffWithPermission } from '../notifications/service.js';
import { getEntitlements } from '../subscriptions/entitlements.js';

export const portalRouter = Router();

portalRouter.use((req: Request, _res: Response, next: NextFunction) => {
  const a = req.auth!;
  if (a.userType !== 'customer' || !a.permissions.has('portal.use') || !a.tenantId) return next(forbidden('Customer portal access only'));
  if (!a.customerId) return next(new AppError(403, 'PORTAL_NOT_LINKED', 'Your account is not yet linked to a customer record. Verify your email or contact the business.'));
  next();
});
portalRouter.use(requireFeature('customer_portal'));

/** Every portal query runs in the tenant's RLS transaction AND filters by the caller's own customer id. */
const ptx = <T>(req: Request, fn: (db: Db, customerId: string) => Promise<T>) => withTenant(req.auth!.tenantId!, (db) => fn(db, req.auth!.customerId!));

async function own(db: Db, table: string, id: string, customerId: string, what: string, extra = '') {
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw notFound(what);
  const r = await db.maybeOne(`SELECT * FROM ${table} WHERE id = $1 AND customer_id = $2 ${extra}`, [id, customerId]);
  if (!r) throw notFound(what);
  return r;
}

portalRouter.get('/me', ah(async (req, res) => {
  const data = await ptx(req, async (db, cid) => {
    const c = await db.one(`SELECT id, number, full_name, company_name, email, phone, alt_phone, customer_type, notification_opt_out, marketing_opt_in FROM customers WHERE id = $1`, [cid]);
    const business = await db.one(`SELECT t.name, t.phone, t.email, t.address_line1, t.city, s.currency, s.locale, s.timezone, s.cancellation_policy, s.cancellation_notice_hours
      FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.id = current_tenant_id()`);
    const addresses = await db.many(`SELECT * FROM customer_addresses WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC`, [cid]);
    const categories = await db.many(`SELECT id, name FROM service_categories WHERE is_active ORDER BY name`);
    const ent = await getEntitlements(db.tenantId!);
    const summary = await db.one(`SELECT (SELECT count(*) FROM work_orders WHERE customer_id = $1 AND status IN ('new','approved','scheduled','assigned','en_route','in_progress','on_hold'))::int AS open_jobs,
      (SELECT count(*) FROM quotations WHERE customer_id = $1 AND status IN ('sent','viewed'))::int AS pending_quotes,
      (SELECT COALESCE(sum(balance_due),0) FROM invoices WHERE customer_id = $1 AND status IN ('issued','partially_paid','overdue')) AS balance_due,
      (SELECT count(*) FROM amc_contracts WHERE customer_id = $1 AND status = 'active')::int AS active_contracts`, [cid]);
    return { customer: c, business, addresses, categories, summary, aiAssistant: !!ent.features.ai };
  });
  res.json({ data });
}));

portalRouter.patch('/me', ah(async (req, res) => {
  const b = parse(z.object({ fullName: z.string().trim().min(2).max(150).optional(), phone: z.string().max(30).nullish(), altPhone: z.string().max(30).nullish(),
    notificationOptOut: z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), sms: z.boolean().optional() }).optional(), marketingOptIn: z.boolean().optional() }), req.body);
  await ptx(req, async (db, cid) => {
    const before = await db.one(`SELECT full_name, phone, alt_phone, notification_opt_out, marketing_opt_in FROM customers WHERE id = $1`, [cid]);
    await db.query(`UPDATE customers SET full_name = COALESCE($2, full_name), phone = CASE WHEN $3 THEN $4 ELSE phone END, alt_phone = CASE WHEN $5 THEN $6 ELSE alt_phone END,
      notification_opt_out = COALESCE($7, notification_opt_out), marketing_opt_in = COALESCE($8, marketing_opt_in) WHERE id = $1`,
      [cid, b.fullName ?? null, b.phone !== undefined, b.phone ?? null, b.altPhone !== undefined, b.altPhone ?? null, b.notificationOptOut ? JSON.stringify(b.notificationOptOut) : null, b.marketingOptIn ?? null]);
    await audit(db, req, { action: 'portal.profile_updated', entityType: 'customer', entityId: cid, before, after: b });
  });
  res.json({ data: { ok: true } });
}));

const addr = z.object({ label: z.string().max(40).default('Home'), line1: z.string().trim().min(2).max(200), line2: z.string().max(200).nullish(), city: z.string().max(100).nullish(),
  state: z.string().max(100).nullish(), postalCode: z.string().max(20).nullish(), accessNotes: z.string().max(500).nullish(), isDefault: z.boolean().default(false) });
portalRouter.post('/addresses', ah(async (req, res) => {
  const b = parse(addr, req.body);
  const a = await ptx(req, async (db, cid) => {
    if (b.isDefault) await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [cid]);
    const area = b.postalCode ? await db.maybeOne(`SELECT id FROM service_areas WHERE $1 = ANY(postal_codes) LIMIT 1`, [b.postalCode]) : null;
    return db.one(`INSERT INTO customer_addresses (tenant_id, customer_id, label, line1, line2, city, state, postal_code, access_notes, is_default, service_area_id)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`, [db.tenantId, cid, b.label, b.line1, b.line2 ?? null, b.city ?? null, b.state ?? null, b.postalCode ?? null,
      b.accessNotes ?? null, b.isDefault, area?.id ?? null]);
  });
  res.status(201).json({ data: a });
}));
portalRouter.patch('/addresses/:id', ah(async (req, res) => {
  const b = parse(addr.partial(), req.body);
  const a = await ptx(req, async (db, cid) => {
    await own(db, 'customer_addresses', req.params.id, cid, 'Address', 'AND deleted_at IS NULL');
    if (b.isDefault) await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [cid]);
    return db.one(`UPDATE customer_addresses SET label = COALESCE($2,label), line1 = COALESCE($3,line1), line2 = COALESCE($4,line2), city = COALESCE($5,city), state = COALESCE($6,state),
      postal_code = COALESCE($7,postal_code), access_notes = COALESCE($8,access_notes), is_default = COALESCE($9,is_default) WHERE id = $1 RETURNING *`,
      [req.params.id, b.label ?? null, b.line1 ?? null, b.line2 ?? null, b.city ?? null, b.state ?? null, b.postalCode ?? null, b.accessNotes ?? null, b.isDefault ?? null]);
  });
  res.json({ data: a });
}));
portalRouter.delete('/addresses/:id', ah(async (req, res) => {
  await ptx(req, async (db, cid) => {
    await own(db, 'customer_addresses', req.params.id, cid, 'Address');
    await db.query(`UPDATE customer_addresses SET deleted_at = now(), is_default = false WHERE id = $1`, [req.params.id]);
  });
  res.json({ data: { ok: true } });
}));

// Equipment
portalRouter.get('/assets', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT a.id, a.number, a.name, a.manufacturer, a.model, a.serial_number, a.installation_date, a.warranty_expiry, a.last_service_date,
    a.next_service_due, a.status, e.name AS category_name FROM assets a LEFT JOIN equipment_categories e ON e.id = a.equipment_category_id WHERE a.customer_id = $1 ORDER BY a.created_at DESC`, [cid])) });
}));
portalRouter.post('/assets', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(120), manufacturer: z.string().max(80).nullish(), model: z.string().max(80).nullish(), serialNumber: z.string().max(80).nullish(),
    equipmentCategoryId: z.string().uuid().nullish(), addressId: z.string().uuid().nullish(), installationDate: dateStr.nullish(), warrantyExpiry: dateStr.nullish() }), req.body);
  const a = await ptx(req, async (db, cid) => {
    const a = await createAsset(db, { ...b, customerId: cid, status: 'active' });
    await audit(db, req, { action: 'portal.asset_registered', entityType: 'asset', entityId: a.id });
    return a;
  });
  res.status(201).json({ data: a });
}));

// Service requests
portalRouter.get('/requests', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT r.id, r.number, r.status, r.description, r.priority, r.preferred_date, r.preferred_time_slot, r.created_at, r.rejection_reason,
    sc.name AS category_name, w.number AS work_order_number, w.id AS work_order_id FROM service_requests r LEFT JOIN service_categories sc ON sc.id = r.service_category_id
    LEFT JOIN work_orders w ON w.id = r.work_order_id WHERE r.customer_id = $1 ORDER BY r.created_at DESC`, [cid])) });
}));
portalRouter.post('/requests', upload.array('photos', 5), ah(async (req, res) => {
  const b = parse(z.object({ description: z.string().trim().min(10).max(4000), serviceCategoryId: z.string().uuid().optional().or(z.literal('')), addressId: z.string().uuid().optional().or(z.literal('')),
    assetId: z.string().uuid().optional().or(z.literal('')), preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')),
    preferredTimeSlot: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(), priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal') }), req.body);
  const r = await ptx(req, async (db, cid) => {
    const r = await createServiceRequest(db, req, { customerId: cid, description: b.description, serviceCategoryId: b.serviceCategoryId || null, addressId: b.addressId || null,
      assetId: b.assetId || null, preferredDate: b.preferredDate || null, preferredTimeSlot: b.preferredTimeSlot ?? null, priority: b.priority, source: 'portal' } as any);
    for (const f of (req.files as Express.Multer.File[]) ?? []) await storeDocument(db, f, { entityType: 'service_request', entityId: r.id, category: 'customer_attachment', visibility: 'customer', userId: req.auth!.userId });
    return r;
  });
  res.status(201).json({ data: r });
}));

// Jobs & visits (customer-safe fields only; never internal notes or costs)
portalRouter.get('/jobs', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT w.id, w.number, w.title, w.status, w.scheduled_start, w.expected_duration_minutes, w.actual_end, u.full_name AS technician_name,
    sc.name AS category_name, a.line1, a.city, (SELECT rating FROM customer_feedback f WHERE f.work_order_id = w.id) AS my_rating
    FROM work_orders w LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id LEFT JOIN service_categories sc ON sc.id = w.service_category_id
    LEFT JOIN customer_addresses a ON a.id = w.address_id WHERE w.customer_id = $1 ORDER BY COALESCE(w.scheduled_start, w.created_at) DESC`, [cid])) });
}));
portalRouter.get('/jobs/:id', ah(async (req, res) => {
  const data = await ptx(req, async (db, cid) => {
    const w = await own(db, 'work_orders', req.params.id, cid, 'Job');
    const [tech, report, notes, history, documents, feedback] = await Promise.all([
      w.assigned_technician_id ? db.maybeOne(`SELECT u.full_name FROM technician_profiles tp JOIN users u ON u.id = tp.user_id WHERE tp.id = $1`, [w.assigned_technician_id]) : null,
      db.maybeOne(`SELECT reported_issue, findings, work_performed, recommendations, follow_up_required, equipment_condition, customer_signed_name, customer_approved_at FROM service_reports WHERE work_order_id = $1`, [w.id]),
      db.many(`SELECT body, created_at FROM work_order_notes WHERE work_order_id = $1 AND visibility = 'customer' ORDER BY created_at`, [w.id]),
      db.many(`SELECT to_status, changed_at FROM work_order_status_history WHERE work_order_id = $1 ORDER BY changed_at`, [w.id]),
      db.many(`SELECT id, file_name, mime_type, category, created_at FROM documents WHERE entity_type = 'work_order' AND entity_id = $1 AND visibility = 'customer' AND deleted_at IS NULL`, [w.id]),
      db.maybeOne(`SELECT rating, technician_rating, comment, created_at FROM customer_feedback WHERE work_order_id = $1`, [w.id]),
    ]);
    return { id: w.id, number: w.number, title: w.title, description: w.description, status: w.status, scheduled_start: w.scheduled_start, expected_duration_minutes: w.expected_duration_minutes,
      actual_start: w.actual_start, actual_end: w.actual_end, customer_notes: w.customer_notes, technician_name: tech?.full_name ?? null, report: report?.work_performed ? report : null,
      notes, history, documents: documents.map((d) => ({ ...d, url: `/api/public/files/${signFileToken(db.tenantId!, d.id, 600)}` })), feedback };
  });
  res.json({ data });
}));

/** Cancellation / reschedule requests go to the business for approval (never auto-applied). */
portalRouter.post('/jobs/:id/change-request', ah(async (req, res) => {
  const b = parse(z.object({ type: z.enum(['cancel', 'reschedule']), preferredDate: dateStr.optional(), reason: z.string().trim().min(3).max(2000), confirmed: z.literal(true) }), req.body);
  const t = await ptx(req, async (db, cid) => {
    const w = await own(db, 'work_orders', req.params.id, cid, 'Job');
    if (!['new', 'approved', 'scheduled', 'assigned'].includes(w.status)) throw unprocessable('This job can no longer be changed online. Please contact us.');
    const t = await createTicket(db, { customerId: cid, workOrderId: w.id, subject: `${b.type === 'cancel' ? 'Cancellation' : 'Reschedule'} request for ${w.number}`, category: 'scheduling',
      priority: 'high', message: `${b.reason}${b.preferredDate ? `\nPreferred new date: ${b.preferredDate}` : ''}` }, { id: req.auth!.userId, type: 'customer' });
    await notify(db, { event: 'request.created', staffUserIds: await staffWithPermission(db, 'work_orders.update'), vars: {},
      inApp: { title: `Customer requested ${b.type} of ${w.number}`, body: b.reason.slice(0, 140), link: `/app/support/${t.id}` } });
    await audit(db, req, { action: `portal.${b.type}_requested`, entityType: 'work_order', entityId: w.id, after: { ticket: t.number, reason: b.reason } });
    return t;
  });
  res.status(201).json({ data: { ticketNumber: t.number, message: 'Your request has been sent. We will confirm shortly.' } });
}));

portalRouter.post('/jobs/:id/feedback', ah(async (req, res) => {
  const b = parse(z.object({ rating: z.number().int().min(1).max(5), technicianRating: z.number().int().min(1).max(5).optional(), comment: z.string().max(3000).nullish(),
    complaintCategory: z.string().max(60).nullish() }), req.body);
  const f = await ptx(req, async (db, cid) => {
    const w = await own(db, 'work_orders', req.params.id, cid, 'Job');
    if (!['completed', 'invoiced', 'paid'].includes(w.status)) throw unprocessable('Feedback can be left once the job is completed');
    const f = await db.one(`INSERT INTO customer_feedback (tenant_id, customer_id, work_order_id, technician_id, rating, technician_rating, comment, is_complaint, complaint_category)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`, [db.tenantId, cid, w.id, w.assigned_technician_id, b.rating, b.technicianRating ?? null, b.comment ?? null,
        b.rating <= 2 || !!b.complaintCategory, b.complaintCategory ?? null]);
    if (b.rating <= 2) await notify(db, { event: 'request.created', staffUserIds: await staffWithPermission(db, 'support.manage'), vars: {},
      inApp: { title: `${b.rating}★ feedback on ${w.number}`, body: b.comment?.slice(0, 140) ?? 'Low rating received', link: '/app/support?tab=feedback' } });
    return f;
  });
  res.status(201).json({ data: f });
}));

// Quotations
portalRouter.get('/quotations', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT id, number, revision, status, title, total, currency, issue_date, valid_until FROM quotations
    WHERE customer_id = $1 AND status NOT IN ('draft','superseded') ORDER BY created_at DESC`, [cid])) });
}));
portalRouter.get('/quotations/:id', ah(async (req, res) => {
  const data = await ptx(req, async (db, cid) => {
    const q0 = await own(db, 'quotations', req.params.id, cid, 'Quotation', `AND status NOT IN ('draft')`);
    if (q0.status === 'sent') await db.query(`UPDATE quotations SET status = 'viewed', viewed_at = now() WHERE id = $1`, [q0.id]);
    const q = await quotationDetail(db, q0.id);
    return { id: q.id, number: q.number, revision: q.revision, status: q.status, title: q.title, currency: q.currency, issue_date: q.issue_date, valid_until: q.valid_until,
      subtotal: q.subtotal, discount_total: q.discount_total, tax_total: q.tax_total, total: q.total, notes: q.notes, terms: q.terms, tax_breakdown: q.tax_breakdown,
      items: q.items.map((i: any) => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price, discount_percent: i.discount_percent, tax_rate: i.tax_rate, line_total: i.line_total })) };
  });
  res.json({ data });
}));
portalRouter.post('/quotations/:id/approve', ah(async (req, res) => {
  const b = parse(z.object({ accept: z.literal(true) }), req.body);
  void b;
  await ptx(req, async (db, cid) => { await own(db, 'quotations', req.params.id, cid, 'Quotation'); await decideQuotation(db, req, req.params.id, 'approved', `${req.auth!.fullName} (portal)`); });
  res.json({ data: { ok: true } });
}));
portalRouter.post('/quotations/:id/reject', ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2).max(1000) }), req.body);
  await ptx(req, async (db, cid) => { await own(db, 'quotations', req.params.id, cid, 'Quotation'); await decideQuotation(db, req, req.params.id, 'rejected', req.auth!.fullName, b.reason); });
  res.json({ data: { ok: true } });
}));
portalRouter.get('/quotations/:id/pdf', ah(async (req, res) => {
  const { number, pdf } = await ptx(req, async (db, cid) => { await own(db, 'quotations', req.params.id, cid, 'Quotation', `AND status <> 'draft'`); return quotationPdf(db, req.params.id); });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`); res.send(pdf);
}));

// Invoices & payments
portalRouter.get('/invoices', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT id, number, status, total, amount_paid, balance_due, currency, issue_date, due_date FROM invoices
    WHERE customer_id = $1 AND status <> 'draft' ORDER BY issue_date DESC NULLS LAST`, [cid])) });
}));
portalRouter.get('/invoices/:id', ah(async (req, res) => {
  const data = await ptx(req, async (db, cid) => {
    await own(db, 'invoices', req.params.id, cid, 'Invoice', `AND status <> 'draft'`);
    const i = await invoiceDetail(db, req.params.id);
    const pay = await db.maybeOne(`SELECT provider, mode FROM integrations WHERE kind = 'payment' AND is_enabled`);
    return { id: i.id, number: i.number, status: i.status, currency: i.currency, issue_date: i.issue_date, due_date: i.due_date, subtotal: i.subtotal, tax_total: i.tax_total,
      discount_total: i.discount_total, total: i.total, amount_paid: i.amount_paid, amount_refunded: i.amount_refunded, balance_due: i.balance_due, tax_breakdown: i.tax_breakdown, seller: i.seller,
      items: i.items.map((x: any) => ({ description: x.description, quantity: x.quantity, unit_price: x.unit_price, tax_rate: x.tax_rate, line_total: x.line_total })),
      payments: i.payments.filter((p: any) => p.status === 'succeeded').map((p: any) => ({ id: p.id, amount: p.amount, method: p.method, received_at: p.received_at, receipt_number: p.receipt_number })),
      onlinePayment: pay ? { provider: pay.provider, mode: pay.mode } : null };
  });
  res.json({ data });
}));
portalRouter.post('/invoices/:id/pay', ah(async (req, res) => {
  const out = await ptx(req, async (db, cid) => { await own(db, 'invoices', req.params.id, cid, 'Invoice'); return createPaymentLink(db, req.params.id); });
  res.json({ data: out });
}));
portalRouter.get('/invoices/:id/pdf', ah(async (req, res) => {
  const { number, pdf } = await ptx(req, async (db, cid) => { await own(db, 'invoices', req.params.id, cid, 'Invoice', `AND status <> 'draft'`); return invoicePdf(db, req.params.id); });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`); res.send(pdf);
}));
portalRouter.get('/payments/:id/receipt.pdf', ah(async (req, res) => {
  const { number, pdf } = await ptx(req, async (db, cid) => { await own(db, 'payments', req.params.id, cid, 'Payment'); return receiptPdf(db, req.params.id); });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`); res.send(pdf);
}));

// AMC
portalRouter.get('/contracts', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT m.id, m.number, m.title, m.status, m.start_date, m.end_date, m.frequency, m.visits_included, m.coverage, m.exclusions,
    (SELECT count(*) FROM scheduled_visits v WHERE v.contract_id = m.id AND v.status = 'completed')::int AS visits_completed,
    (SELECT json_agg(json_build_object('visit_number', v.visit_number, 'due_date', v.due_date, 'status', v.status) ORDER BY v.visit_number) FROM scheduled_visits v WHERE v.contract_id = m.id) AS visits
    FROM amc_contracts m WHERE m.customer_id = $1 AND m.status <> 'draft' ORDER BY m.start_date DESC`, [cid])) });
}));

// Support tickets
portalRouter.get('/tickets', ah(async (req, res) => {
  res.json({ data: await ptx(req, (db, cid) => db.many(`SELECT t.id, t.number, t.subject, t.status, t.category, t.created_at, t.updated_at,
    (SELECT json_agg(json_build_object('body', m.body, 'author_type', m.author_type, 'created_at', m.created_at) ORDER BY m.created_at) FROM ticket_messages m WHERE m.ticket_id = t.id AND NOT m.is_internal) AS messages
    FROM support_tickets t WHERE t.customer_id = $1 ORDER BY t.updated_at DESC`, [cid])) });
}));
portalRouter.post('/tickets', ah(async (req, res) => {
  const b = parse(z.object({ subject: z.string().trim().min(3).max(200), message: z.string().trim().min(5).max(5000),
    category: z.enum(['general', 'complaint', 'billing', 'service_quality', 'technician', 'scheduling', 'other']).default('general'), workOrderId: z.string().uuid().optional() }), req.body);
  const t = await ptx(req, async (db, cid) => {
    if (b.workOrderId) await own(db, 'work_orders', b.workOrderId, cid, 'Job');
    const t = await createTicket(db, { ...b, customerId: cid, priority: b.category === 'complaint' ? 'high' : 'normal' }, { id: req.auth!.userId, type: 'customer' });
    await notify(db, { event: 'request.created', staffUserIds: await staffWithPermission(db, 'support.manage'), vars: {}, inApp: { title: `New support ticket ${t.number}`, body: b.subject, link: `/app/support/${t.id}` } });
    return t;
  });
  res.status(201).json({ data: t });
}));
portalRouter.post('/tickets/:id/messages', ah(async (req, res) => {
  const b = parse(z.object({ body: z.string().trim().min(1).max(5000) }), req.body);
  await ptx(req, async (db, cid) => {
    const t = await own(db, 'support_tickets', req.params.id, cid, 'Ticket');
    if (t.status === 'closed') throw unprocessable('This ticket is closed. Open a new one.');
    await db.query(`INSERT INTO ticket_messages (tenant_id, ticket_id, author_id, author_type, body) VALUES ($1,$2,$3,'customer',$4)`, [db.tenantId, t.id, req.auth!.userId, b.body]);
    await db.query(`UPDATE support_tickets SET status = CASE WHEN status IN ('waiting_for_customer','resolved') THEN 'open' ELSE status END WHERE id = $1`, [t.id]);
  });
  res.status(201).json({ data: { ok: true } });
}));

// AI support assistant (tenant + customer scoped; proposes actions, never executes them)
portalRouter.post('/assistant', requireFeature('ai'), ah(async (req, res) => {
  const b = parse(z.object({ message: z.string().trim().min(2).max(2000) }), req.body);
  res.json({ data: await ptx(req, (db, cid) => supportAssistant(db, req.auth!.userId, cid, b.message)) });
}));

export { badRequest };

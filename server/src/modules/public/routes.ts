import { Router } from 'express';
import { z } from 'zod';
import { ah, parse } from '../../lib/http.js';
import { badRequest, notFound, unprocessable } from '../../lib/errors.js';
import { systemDb, withSystem, withTenant } from '../../db/pool.js';
import { config } from '../../config.js';
import { hmacSha256Hex, safeEqual } from '../../lib/crypto.js';
import { storage } from '../../integrations/storage.js';
import { testGatewaySecret, testProvider } from '../../integrations/payments.js';
import { createServiceRequest } from '../requests/routes.js';
import { decideQuotation, quotationDetail, quotationPdf } from '../quotations/routes.js';
import { invoiceDetail, invoicePdf } from '../invoices/routes.js';
import { createPaymentLink } from '../payments/service.js';
import { processPaymentWebhook } from '../payments/webhooks.js';
import { upload, storeDocument } from '../documents/routes.js';
import { audit } from '../../lib/audit.js';
import { markSubscriptionInvoicePaid, markSubscriptionInvoiceFailed } from '../subscriptions/billing.js';

export const publicRouter = Router();

publicRouter.get('/plans', ah(async (_req, res) => {
  res.json({ data: await systemDb.many(`SELECT code, name, description, currency, monthly_price, annual_price, trial_days, max_users, max_technicians, max_storage_mb, max_branches,
    ai_requests_per_month, features FROM subscription_plans WHERE is_active AND is_public ORDER BY sort_order`) });
}));

async function tenantBySlug(slug: string) {
  const t = await systemDb.maybeOne(`SELECT t.id, t.name, t.slug, t.phone, t.email, t.city, t.country, t.status, s.public_request_form_enabled, s.brand_color
    FROM tenants t JOIN tenant_settings s ON s.tenant_id = t.id WHERE t.slug = $1`, [slug.toLowerCase()]);
  if (!t || t.status !== 'active') throw notFound('Business');
  return t;
}

publicRouter.get('/tenants/:slug', ah(async (req, res) => {
  const t = await tenantBySlug(req.params.slug);
  const categories = await withTenant(t.id, (db) => db.many(`SELECT id, name FROM service_categories WHERE is_active ORDER BY name`));
  res.json({ data: { name: t.name, slug: t.slug, phone: t.phone, email: t.email, city: t.city, brandColor: t.brand_color, requestFormEnabled: t.public_request_form_enabled, categories } });
}));

/** Public service request form (no login). Honeypot + rate limiting + strict validation; photos are content-sniffed. */
publicRouter.post('/tenants/:slug/requests', upload.array('photos', 5), ah(async (req, res) => {
  const t = await tenantBySlug(req.params.slug);
  if (!t.public_request_form_enabled) throw unprocessable('Online requests are not enabled for this business');
  const b = parse(z.object({ contactName: z.string().trim().min(2).max(120), contactPhone: z.string().trim().min(6).max(30), contactEmail: z.string().trim().toLowerCase().email().optional().or(z.literal('')),
    addressText: z.string().trim().min(5).max(500), description: z.string().trim().min(10).max(4000), serviceCategoryId: z.string().uuid().optional().or(z.literal('')),
    preferredDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')), preferredTimeSlot: z.enum(['morning', 'afternoon', 'evening', 'any']).optional(),
    website: z.string().max(0).optional(), consent: z.union([z.literal('true'), z.literal(true)]) }), req.body);
  const r = await withTenant(t.id, async (db) => {
    if (b.serviceCategoryId && !(await db.maybeOne(`SELECT 1 FROM service_categories WHERE id = $1`, [b.serviceCategoryId]))) throw badRequest('Invalid category');
    const r = await createServiceRequest(db, req, { contactName: b.contactName, contactPhone: b.contactPhone, contactEmail: b.contactEmail || null, addressText: b.addressText,
      description: b.description, serviceCategoryId: b.serviceCategoryId || null, preferredDate: b.preferredDate || null, preferredTimeSlot: b.preferredTimeSlot ?? null,
      priority: 'normal', source: 'public_form' } as any);
    for (const f of (req.files as Express.Multer.File[]) ?? []) {
      await storeDocument(db, f, { entityType: 'service_request', entityId: r.id, category: 'customer_attachment', visibility: 'customer', userId: null });
    }
    return r;
  });
  res.status(201).json({ data: { number: r.number, message: `Thank you. Your request ${r.number} has been received.` } });
}));

// ---------------------------------------------------------------- quotations by public token
async function byToken(table: 'quotations' | 'invoices', token: string) {
  if (!/^[0-9a-f]{48}$/.test(token)) throw notFound('Document');
  const r = await systemDb.maybeOne(`SELECT id, tenant_id FROM ${table} WHERE public_token = $1`, [token]);
  if (!r) throw notFound('Document');
  return r as { id: string; tenant_id: string };
}

const publicQuote = (q: any) => ({ number: q.number, revision: q.revision, status: q.status, title: q.title, currency: q.currency, issue_date: q.issue_date, valid_until: q.valid_until,
  subtotal: q.subtotal, discount_total: q.discount_total, tax_total: q.tax_total, total: q.total, tax_breakdown: q.tax_breakdown, notes: q.notes, terms: q.terms,
  customer_name: q.company_name || q.customer_name, approved_at: q.approved_at, approved_by_name: q.approved_by_name, rejected_at: q.rejected_at,
  items: q.items.map((i: any) => ({ description: i.description, quantity: i.quantity, unit_price: i.unit_price, discount_percent: i.discount_percent, tax_rate: i.tax_rate, line_total: i.line_total })) });

publicRouter.get('/quotations/:token', ah(async (req, res) => {
  const { id, tenant_id } = await byToken('quotations', req.params.token);
  const data = await withTenant(tenant_id, async (db) => {
    await db.query(`UPDATE quotations SET status = 'viewed', viewed_at = COALESCE(viewed_at, now()) WHERE id = $1 AND status = 'sent'`, [id]);
    await db.query(`UPDATE quotations SET status = 'expired' WHERE id = $1 AND status IN ('sent','viewed') AND valid_until < current_date`, [id]);
    const q = await quotationDetail(db, id);
    const b = await db.one(`SELECT name, phone, email FROM tenants WHERE id = $1`, [tenant_id]);
    return { ...publicQuote(q), business: b };
  });
  res.json({ data });
}));
publicRouter.post('/quotations/:token/approve', ah(async (req, res) => {
  const b = parse(z.object({ name: z.string().trim().min(2).max(120), accept: z.literal(true) }), req.body);
  const { id, tenant_id } = await byToken('quotations', req.params.token);
  await withTenant(tenant_id, (db) => decideQuotation(db, req, id, 'approved', `${b.name} (online)`));
  res.json({ data: { ok: true } });
}));
publicRouter.post('/quotations/:token/reject', ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(2).max(1000) }), req.body);
  const { id, tenant_id } = await byToken('quotations', req.params.token);
  await withTenant(tenant_id, (db) => decideQuotation(db, req, id, 'rejected', 'Customer (online)', b.reason));
  res.json({ data: { ok: true } });
}));
publicRouter.get('/quotations/:token/pdf', ah(async (req, res) => {
  const { id, tenant_id } = await byToken('quotations', req.params.token);
  const { number, pdf } = await withTenant(tenant_id, (db) => quotationPdf(db, id));
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`); res.send(pdf);
}));

// ---------------------------------------------------------------- invoices by public token
publicRouter.get('/invoices/:token', ah(async (req, res) => {
  const { id, tenant_id } = await byToken('invoices', req.params.token);
  const data = await withTenant(tenant_id, async (db) => {
    const i = await invoiceDetail(db, id);
    if (i.status === 'draft') throw notFound('Invoice');
    const pay = await db.maybeOne(`SELECT provider, mode FROM integrations WHERE kind = 'payment' AND is_enabled`);
    return { number: i.number, status: i.status, currency: i.currency, issue_date: i.issue_date, due_date: i.due_date, bill_to: i.bill_to, seller: i.seller,
      subtotal: i.subtotal, discount_total: i.discount_total, tax_total: i.tax_total, total: i.total, amount_paid: i.amount_paid, amount_refunded: i.amount_refunded,
      balance_due: i.balance_due, tax_breakdown: i.tax_breakdown, notes: i.notes, onlinePayment: pay ? { provider: pay.provider, mode: pay.mode } : null,
      items: i.items.map((x: any) => ({ description: x.description, quantity: x.quantity, unit_price: x.unit_price, tax_rate: x.tax_rate, line_total: x.line_total })),
      payments: i.payments.filter((p: any) => p.status === 'succeeded').map((p: any) => ({ amount: p.amount, method: p.method, received_at: p.received_at, receipt_number: p.receipt_number })) };
  });
  res.json({ data });
}));
publicRouter.get('/invoices/:token/pdf', ah(async (req, res) => {
  const { id, tenant_id } = await byToken('invoices', req.params.token);
  const { number, pdf } = await withTenant(tenant_id, async (db) => {
    const s = await db.one(`SELECT status FROM invoices WHERE id = $1`, [id]);
    if (s.status === 'draft') throw notFound('Invoice');
    return invoicePdf(db, id);
  });
  res.setHeader('Content-Type', 'application/pdf'); res.setHeader('Content-Disposition', `inline; filename="${number}.pdf"`); res.send(pdf);
}));
publicRouter.post('/invoices/:token/pay', ah(async (req, res) => {
  const { id, tenant_id } = await byToken('invoices', req.params.token);
  res.json({ data: await withTenant(tenant_id, (db) => createPaymentLink(db, id)) });
}));

// ---------------------------------------------------------------- sandbox (test) gateway checkout
publicRouter.get('/pay/test/:intentId', ah(async (req, res) => {
  const intent = await systemDb.maybeOne(`SELECT pi.id, pi.amount, pi.currency, pi.status, pi.provider, i.number, i.public_token, t.name AS business FROM payment_intents pi
    JOIN invoices i ON i.id = pi.invoice_id JOIN tenants t ON t.id = pi.tenant_id WHERE pi.id::text = $1 AND pi.provider = 'test'`, [req.params.intentId]);
  if (!intent) throw notFound('Checkout');
  res.json({ data: { ...intent, sandbox: true } });
}));
/** Simulates the provider: builds a signed webhook and sends it through the SAME verified pipeline as real gateways. */
publicRouter.post('/pay/test/:intentId', ah(async (req, res) => {
  const b = parse(z.object({ outcome: z.enum(['success', 'failure']) }), req.body);
  const intent = await systemDb.maybeOne(`SELECT * FROM payment_intents WHERE id::text = $1 AND provider = 'test'`, [req.params.intentId]);
  if (!intent) throw notFound('Checkout');
  const integ = await systemDb.maybeOne(`SELECT provider, mode FROM integrations WHERE tenant_id = $1 AND kind = 'payment' AND is_enabled`, [intent.tenant_id]);
  if (integ?.provider !== 'test') throw unprocessable('The sandbox gateway is not active for this business');
  const body = Buffer.from(JSON.stringify({ id: `evt_test_${intent.id}_${b.outcome}_${Date.now()}`, type: b.outcome === 'success' ? 'payment.succeeded' : 'payment.failed',
    intentId: intent.id, orderId: intent.provider_order_id, paymentId: `pay_test_${intent.id}`, amount: Number(intent.amount), currency: intent.currency,
    failureReason: b.outcome === 'failure' ? 'Card declined (sandbox)' : null }));
  const out = await processPaymentWebhook(intent.tenant_id, testProvider, body, { 'x-test-signature': hmacSha256Hex(testGatewaySecret(), body) });
  const inv = await systemDb.one(`SELECT public_token FROM invoices WHERE id = $1`, [intent.invoice_id]);
  res.status(out.status).json({ data: { ...out.body, returnUrl: `/i/${inv.public_token}?payment=${b.outcome}` } });
}));
publicRouter.post('/pay/test/billing/:invoiceId', ah(async (req, res) => {
  if (config.BILLING_PROVIDER !== 'test') throw notFound('Checkout');
  const b = parse(z.object({ outcome: z.enum(['success', 'failure']) }), req.body);
  await withSystem((db) => b.outcome === 'success' ? markSubscriptionInvoicePaid(db, req.params.invoiceId, `test_${Date.now()}`) : markSubscriptionInvoiceFailed(db, req.params.invoiceId, 'Card declined (sandbox)'));
  res.json({ data: { ok: true, returnUrl: '/app/subscription' } });
}));

// ---------------------------------------------------------------- signed, expiring file access
publicRouter.get('/files/:token', ah(async (req, res) => {
  const [p, sig] = req.params.token.split('.');
  if (!p || !sig) throw notFound('File');
  const payload = Buffer.from(p, 'base64url').toString('utf8');
  if (!safeEqual(sig, hmacSha256Hex(config.JWT_SECRET, `file:${payload}`))) throw notFound('File');
  const [tenantId, docId, exp] = payload.split('.');
  if (Number(exp) < Date.now() / 1000) return res.status(410).json({ error: { code: 'EXPIRED', message: 'Link expired' } });
  const doc = await withTenant(tenantId, (db) => db.maybeOne(`SELECT storage_key, mime_type, file_name FROM documents WHERE id = $1 AND deleted_at IS NULL`, [docId]));
  if (!doc) throw notFound('File');
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Cache-Control', 'private, max-age=300');
  res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; sandbox");
  res.setHeader('Content-Disposition', `${/^(image\/|application\/pdf)/.test(doc.mime_type) ? 'inline' : 'attachment'}; filename="${encodeURIComponent(doc.file_name)}"`);
  (await storage.get(doc.storage_key)).pipe(res);
}));

/** Asset QR scan: minimal non-personal info, plus where to request service. */
publicRouter.get('/assets/:qrToken', ah(async (req, res) => {
  if (!/^[0-9a-f]{24}$/.test(req.params.qrToken)) throw notFound('Asset');
  const a = await systemDb.maybeOne(`SELECT a.id, a.tenant_id, a.number, a.name, a.manufacturer, a.model, a.warranty_expiry, a.last_service_date, t.name AS business, t.slug, t.phone
    FROM assets a JOIN tenants t ON t.id = a.tenant_id WHERE a.qr_token = $1`, [req.params.qrToken]);
  if (!a) throw notFound('Asset');
  await withTenant(a.tenant_id, (db) => audit(db, req, { action: 'asset.qr_scanned', entityType: 'asset', entityId: a.id }, { userId: null, email: null }));
  res.json({ data: { assetId: a.id, number: a.number, name: a.name, manufacturer: a.manufacturer, model: a.model, warrantyActive: a.warranty_expiry ? new Date(a.warranty_expiry) >= new Date() : null,
    lastService: a.last_service_date, business: { name: a.business, slug: a.slug, phone: a.phone } } });
}));

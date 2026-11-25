import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, listQuery, orderBy, paged, parse, toCsv, Where } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { nextNumber } from '../../lib/numbering.js';
import { tx, mustFind, normalizePhone, branchScope, can } from '../common.js';
import type { Db } from '../../db/pool.js';

export const customersRouter = Router();
const read = requirePermission('customers.read');

const addressSchema = z.object({
  label: z.string().trim().max(40).default('Primary'), line1: z.string().trim().min(2).max(200), line2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(), state: z.string().max(100).nullish(), postalCode: z.string().max(20).nullish(), country: z.string().length(2).toUpperCase().nullish(),
  latitude: z.number().min(-90).max(90).nullish(), longitude: z.number().min(-180).max(180).nullish(), accessNotes: z.string().max(500).nullish(),
  serviceAreaId: z.string().uuid().nullish(), isDefault: z.boolean().default(false),
});

const customerSchema = z.object({
  customerType: z.enum(['individual', 'business']).default('individual'),
  fullName: z.string().trim().min(2).max(150), companyName: z.string().trim().max(150).nullish(),
  email: z.string().trim().toLowerCase().email().nullish().or(z.literal('').transform(() => null)),
  phone: z.string().trim().max(30).nullish(), altPhone: z.string().trim().max(30).nullish(), taxId: z.string().max(40).nullish(),
  billingLine1: z.string().max(200).nullish(), billingLine2: z.string().max(200).nullish(), billingCity: z.string().max(100).nullish(),
  billingState: z.string().max(100).nullish(), billingPostalCode: z.string().max(20).nullish(), billingCountry: z.string().length(2).toUpperCase().nullish(),
  notes: z.string().max(5000).nullish(), status: z.enum(['active', 'inactive']).default('active'), source: z.string().max(40).nullish(),
  branchId: z.string().uuid().nullish(), marketingOptIn: z.boolean().default(false),
  notificationOptOut: z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), sms: z.boolean().optional() }).default({}),
  // E-invoicing: Peppol participant id ("scheme:identifier") and buyer reference (e.g. German Leitweg-ID)
  peppolId: z.string().trim().toUpperCase().regex(/^[0-9A-Z]{2,4}:\S{1,200}$/, 'Use scheme:identifier, e.g. 0204:991-01234-56').nullish().or(z.literal('').transform(() => null)),
  buyerReference: z.string().trim().max(100).nullish(),
  addresses: z.array(addressSchema).max(20).optional(),
  force: z.boolean().optional(), // bypass soft (name-based) duplicate warning
});

const cols: Record<string, string> = {
  customerType: 'customer_type', fullName: 'full_name', companyName: 'company_name', email: 'email', phone: 'phone', altPhone: 'alt_phone', taxId: 'tax_id',
  billingLine1: 'billing_line1', billingLine2: 'billing_line2', billingCity: 'billing_city', billingState: 'billing_state',
  billingPostalCode: 'billing_postal_code', billingCountry: 'billing_country', notes: 'notes', status: 'status', source: 'source',
  branchId: 'branch_id', marketingOptIn: 'marketing_opt_in', notificationOptOut: 'notification_opt_out',
  peppolId: 'peppol_id', buyerReference: 'buyer_reference',
};

/** Exact (email/phone) matches block creation; similar names in the same postcode return a warning the user can override. */
export async function findDuplicates(db: Db, c: { email?: string | null; phone?: string | null; fullName?: string; postalCode?: string | null }, excludeId?: string) {
  const phoneN = normalizePhone(c.phone);
  const exact = await db.many(
    `SELECT id, number, full_name, email, phone FROM customers WHERE archived_at IS NULL AND ($3::uuid IS NULL OR id <> $3)
       AND ((email IS NOT NULL AND email = $1) OR (phone_normalized IS NOT NULL AND phone_normalized = $2)) LIMIT 5`,
    [c.email ?? null, phoneN, excludeId ?? null]);
  const similar = c.fullName ? await db.many(
    `SELECT DISTINCT c.id, c.number, c.full_name, c.email, c.phone FROM customers c LEFT JOIN customer_addresses a ON a.customer_id = c.id
      WHERE c.archived_at IS NULL AND ($3::uuid IS NULL OR c.id <> $3) AND lower(c.full_name) = lower($1)
        AND ($2::text IS NULL OR a.postal_code = $2 OR c.billing_postal_code = $2) LIMIT 5`,
    [c.fullName, c.postalCode ?? null, excludeId ?? null]) : [];
  return { exact, similar: similar.filter((s) => !exact.some((e) => e.id === s.id)) };
}

export async function createCustomer(db: Db, b: z.infer<typeof customerSchema>, userId: string | null) {
  const dup = await findDuplicates(db, { email: b.email, phone: b.phone, fullName: b.fullName, postalCode: b.addresses?.[0]?.postalCode ?? b.billingPostalCode });
  if (dup.exact.length) throw conflict('A customer with the same email or phone number already exists.', { duplicates: dup.exact });
  if (dup.similar.length && !b.force) throw conflict('A customer with a similar name already exists at this postcode. Confirm to create anyway.', { similar: dup.similar, canForce: true });
  const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
  const c = await db.one(
    `INSERT INTO customers (tenant_id, number, phone_normalized, created_by, ${keys.map((k) => cols[k]).join(',')})
     VALUES ($1,$2,$3,$4, ${keys.map((_, i) => `$${i + 5}`).join(',')}) RETURNING *`,
    [db.tenantId, await nextNumber(db, 'customer'), normalizePhone(b.phone), userId,
      ...keys.map((k) => (k === 'notificationOptOut' ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
  const addrs = b.addresses ?? [];
  for (let i = 0; i < addrs.length; i++) await insertAddress(db, c.id, { ...addrs[i], isDefault: addrs[i].isDefault || i === 0 });
  return c;
}

async function insertAddress(db: Db, customerId: string, a: z.infer<typeof addressSchema>) {
  if (a.isDefault) await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [customerId]);
  let serviceAreaId = a.serviceAreaId ?? null;
  if (!serviceAreaId && a.postalCode) {
    serviceAreaId = (await db.maybeOne(`SELECT id FROM service_areas WHERE is_active AND $1 = ANY(postal_codes) LIMIT 1`, [a.postalCode]))?.id ?? null;
  }
  return db.one(
    `INSERT INTO customer_addresses (tenant_id, customer_id, label, line1, line2, city, state, postal_code, country, latitude, longitude, access_notes, service_area_id, is_default)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *`,
    [db.tenantId, customerId, a.label, a.line1, a.line2 ?? null, a.city ?? null, a.state ?? null, a.postalCode ?? null, a.country ?? null,
      a.latitude ?? null, a.longitude ?? null, a.accessNotes ?? null, serviceAreaId, a.isDefault]);
}

// ---------------------------------------------------------------- list / export
const filters = listQuery.extend({ status: z.enum(['active', 'inactive', 'archived', 'all']).default('active'), type: z.enum(['individual', 'business']).optional(),
  city: z.string().max(100).optional(), hasAmc: z.coerce.boolean().optional() });

function buildWhere(req: any, q: z.infer<typeof filters>) {
  const w = new Where();
  if (q.status === 'archived') w.add('c.archived_at IS NOT NULL');
  else if (q.status !== 'all') w.add('c.archived_at IS NULL AND c.status = ?', q.status);
  w.addIf(q.type, 'c.customer_type = ?', q.type);
  w.addIf(q.city, '(c.billing_city ILIKE ? OR EXISTS (SELECT 1 FROM customer_addresses a WHERE a.customer_id = c.id AND a.city ILIKE ?))', q.city, q.city);
  if (q.q) w.add(`(c.full_name ILIKE ? OR c.company_name ILIKE ? OR c.email ILIKE ? OR c.phone ILIKE ? OR c.number ILIKE ?)`, ...Array(5).fill(`%${q.q}%`));
  if (q.hasAmc) w.add(`EXISTS (SELECT 1 FROM amc_contracts m WHERE m.customer_id = c.id AND m.status = 'active')`);
  const b = branchScope(req);
  if (b) w.add('(c.branch_id = ? OR c.branch_id IS NULL)', b);
  return w;
}

customersRouter.get('/', read, ah(async (req, res) => {
  const q = parse(filters, req.query);
  const w = buildWhere(req, q);
  const order = orderBy(q, { name: 'c.full_name', number: 'c.number', created: 'c.created_at', jobs: 'job_count' }, 'c.created_at');
  const rows = await tx(req, (db) => db.many(
    `SELECT c.id, c.number, c.customer_type, c.full_name, c.company_name, c.email, c.phone, c.status, c.archived_at, c.created_at, c.billing_city,
       (SELECT count(*) FROM work_orders w WHERE w.customer_id = c.id)::int AS job_count,
       (SELECT COALESCE(sum(balance_due),0) FROM invoices i WHERE i.customer_id = c.id AND i.status IN ('issued','partially_paid','overdue')) AS outstanding,
       (SELECT city FROM customer_addresses a WHERE a.customer_id = c.id AND a.is_default AND a.deleted_at IS NULL LIMIT 1) AS city,
       count(*) OVER() AS _total
     FROM customers c ${w.sql} ORDER BY ${order} LIMIT ${q.pageSize} OFFSET ${(q.page - 1) * q.pageSize}`, w.params));
  res.json(paged(rows, q));
}));

customersRouter.get('/export', requirePermission('customers.export'), ah(async (req, res) => {
  const q = parse(filters.extend({ pageSize: z.coerce.number().default(10000) }), req.query);
  const w = buildWhere(req, q);
  const rows = await tx(req, async (db) => {
    const r = await db.many(`SELECT c.number, c.customer_type, c.full_name, c.company_name, c.email, c.phone, c.alt_phone, c.tax_id, c.billing_line1, c.billing_city,
      c.billing_state, c.billing_postal_code, c.billing_country, c.status, c.created_at FROM customers c ${w.sql} ORDER BY c.number LIMIT 50000`, w.params);
    await audit(db, req, { action: 'customers.exported', entityType: 'customer', after: { count: r.length } });
    return r;
  });
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="customers-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(toCsv(rows, ['number', 'customer_type', 'full_name', 'company_name', 'email', 'phone', 'alt_phone', 'tax_id', 'billing_line1', 'billing_city', 'billing_state', 'billing_postal_code', 'billing_country', 'status', 'created_at']));
}));

customersRouter.post('/check-duplicates', read, ah(async (req, res) => {
  const b = parse(z.object({ email: z.string().nullish(), phone: z.string().nullish(), fullName: z.string().optional(), postalCode: z.string().nullish(), excludeId: z.string().uuid().optional() }), req.body);
  res.json({ data: await tx(req, (db) => findDuplicates(db, { ...b, email: b.email?.toLowerCase() || null }, b.excludeId)) });
}));

// ---------------------------------------------------------------- import (CSV)
export function parseCsv(text: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) {
      if (ch === '"' && text[i + 1] === '"') { field += '"'; i++; } else if (ch === '"') q = false; else field += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(field); rows.push(row); row = []; field = ''; }
    else field += ch;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows.filter((r) => r.some((c) => c.trim() !== ''));
}

customersRouter.post('/import', requirePermission('customers.import'), ah(async (req, res) => {
  const b = parse(z.object({ csv: z.string().min(1).max(5_000_000), dryRun: z.boolean().default(false), skipDuplicates: z.boolean().default(true) }), req.body);
  const rows = parseCsv(b.csv.replace(/^﻿/, ''));
  if (rows.length < 2) throw badRequest('The file must contain a header row and at least one customer');
  if (rows.length > 5001) throw badRequest('Import up to 5,000 customers at a time');
  const header = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_'));
  const idx = (...names: string[]) => header.findIndex((h) => names.includes(h));
  const map = { name: idx('full_name', 'name', 'customer_name'), company: idx('company_name', 'company'), email: idx('email', 'email_address'),
    phone: idx('phone', 'mobile', 'phone_number'), alt: idx('alt_phone', 'alternate_phone'), line1: idx('address', 'address_line1', 'line1', 'billing_line1'),
    city: idx('city', 'billing_city'), state: idx('state', 'billing_state'), postal: idx('postal_code', 'pincode', 'zip', 'postcode', 'billing_postal_code'),
    country: idx('country', 'billing_country'), type: idx('customer_type', 'type'), notes: idx('notes') };
  if (map.name < 0) throw badRequest('A "full_name" (or "name") column is required');
  const report = { created: 0, skipped: 0, errors: [] as { row: number; message: string }[] };
  await tx(req, async (db) => {
    for (let i = 1; i < rows.length; i++) {
      const r = rows[i]; const get = (k: number) => (k >= 0 ? r[k]?.trim() || null : null);
      const parsed = customerSchema.safeParse({
        fullName: get(map.name), companyName: get(map.company), email: get(map.email), phone: get(map.phone), altPhone: get(map.alt),
        customerType: get(map.type) === 'business' ? 'business' : 'individual', notes: get(map.notes), source: 'import',
        billingLine1: get(map.line1), billingCity: get(map.city), billingState: get(map.state), billingPostalCode: get(map.postal),
        billingCountry: get(map.country)?.slice(0, 2) ?? null,
        addresses: get(map.line1) ? [{ line1: get(map.line1), city: get(map.city), state: get(map.state), postalCode: get(map.postal), isDefault: true }] : undefined,
        force: true,
      });
      if (!parsed.success) { report.errors.push({ row: i + 1, message: Object.values(parsed.error.flatten().fieldErrors).flat().join('; ') }); continue; }
      await db.query('SAVEPOINT imp');
      try {
        await createCustomer(db, parsed.data, req.auth!.userId);
        report.created++;
        await db.query('RELEASE SAVEPOINT imp');
      } catch (e: any) {
        await db.query('ROLLBACK TO SAVEPOINT imp');
        if (e.status === 409 && b.skipDuplicates) report.skipped++;
        else report.errors.push({ row: i + 1, message: e.message });
      }
    }
    if (b.dryRun) throw Object.assign(new Error('dry-run'), { dryRunReport: report });
    await audit(db, req, { action: 'customers.imported', entityType: 'customer', after: { created: report.created, skipped: report.skipped, errors: report.errors.length } });
  }).catch((e) => { if (!e.dryRunReport) throw e; });
  res.json({ data: { ...report, dryRun: b.dryRun } });
}));

// ---------------------------------------------------------------- CRUD
customersRouter.post('/', requirePermission('customers.create'), ah(async (req, res) => {
  const b = parse(customerSchema, req.body);
  const c = await tx(req, async (db) => {
    const c = await createCustomer(db, { ...b, branchId: b.branchId ?? branchScope(req) }, req.auth!.userId);
    await audit(db, req, { action: 'customer.created', entityType: 'customer', entityId: c.id, after: c });
    return c;
  });
  res.status(201).json({ data: c });
}));

customersRouter.get('/:id', read, ah(async (req, res) => {
  const showMoney = can(req, 'invoices.read') || can(req, 'payments.read');
  const data = await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    const id = c.id;
    const [addresses, assets, workOrders, quotations, invoices, payments, contracts, documents, communications, requests, feedback, stats] = await Promise.all([
      db.many(`SELECT * FROM customer_addresses WHERE customer_id = $1 AND deleted_at IS NULL ORDER BY is_default DESC, created_at`, [id]),
      db.many(`SELECT a.*, e.name AS category_name FROM assets a LEFT JOIN equipment_categories e ON e.id = a.equipment_category_id WHERE a.customer_id = $1 ORDER BY a.created_at DESC`, [id]),
      db.many(`SELECT w.id, w.number, w.title, w.status, w.priority, w.scheduled_start, w.created_at, u.full_name AS technician_name
               FROM work_orders w LEFT JOIN technician_profiles tp ON tp.id = w.assigned_technician_id LEFT JOIN users u ON u.id = tp.user_id
               WHERE w.customer_id = $1 ORDER BY w.created_at DESC LIMIT 100`, [id]),
      can(req, 'quotations.read') ? db.many(`SELECT id, number, revision, status, total, currency, issue_date, valid_until FROM quotations WHERE customer_id = $1 ORDER BY created_at DESC`, [id]) : [],
      showMoney ? db.many(`SELECT id, number, status, total, balance_due, currency, issue_date, due_date FROM invoices WHERE customer_id = $1 ORDER BY created_at DESC`, [id]) : [],
      showMoney ? db.many(`SELECT p.id, p.receipt_number, p.amount, p.currency, p.method, p.status, p.received_at, i.number AS invoice_number FROM payments p JOIN invoices i ON i.id = p.invoice_id WHERE p.customer_id = $1 ORDER BY p.received_at DESC`, [id]) : [],
      db.many(`SELECT id, number, title, status, start_date, end_date, frequency, visits_included FROM amc_contracts WHERE customer_id = $1 ORDER BY start_date DESC`, [id]),
      db.many(`SELECT id, file_name, mime_type, size_bytes, category, created_at FROM documents WHERE entity_type = 'customer' AND entity_id = $1 AND deleted_at IS NULL ORDER BY created_at DESC`, [id]),
      db.many(`SELECT cm.*, u.full_name AS user_name FROM communications cm LEFT JOIN users u ON u.id = cm.user_id WHERE cm.customer_id = $1 ORDER BY cm.created_at DESC LIMIT 100`, [id]),
      db.many(`SELECT id, number, status, description, created_at, source FROM service_requests WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50`, [id]),
      db.many(`SELECT id, rating, comment, created_at, is_complaint FROM customer_feedback WHERE customer_id = $1 ORDER BY created_at DESC`, [id]),
      db.one(`SELECT (SELECT count(*) FROM work_orders WHERE customer_id = $1)::int AS total_jobs,
                     (SELECT count(*) FROM work_orders WHERE customer_id = $1 AND status NOT IN ('completed','invoiced','paid','cancelled','rejected'))::int AS open_jobs,
                     (SELECT COALESCE(sum(amount),0) FROM payments WHERE customer_id = $1 AND status = 'succeeded') AS lifetime_paid,
                     (SELECT COALESCE(sum(balance_due),0) FROM invoices WHERE customer_id = $1 AND status IN ('issued','partially_paid','overdue')) AS outstanding,
                     (SELECT round(avg(rating),1) FROM customer_feedback WHERE customer_id = $1) AS avg_rating`, [id]),
    ]);
    return { ...c, addresses, assets, workOrders, quotations, invoices, payments, contracts, documents, communications, requests, feedback,
      stats: showMoney ? stats : { ...stats, lifetime_paid: null, outstanding: null } };
  });
  res.json({ data });
}));

customersRouter.patch('/:id', requirePermission('customers.update'), ah(async (req, res) => {
  const b = parse(customerSchema.omit({ addresses: true, force: true }).partial(), req.body);
  const out = await tx(req, async (db) => {
    const before = await mustFind(db, 'customers', req.params.id, 'Customer');
    if (before.anonymized_at) throw conflict('This customer record has been anonymised');
    if (b.email !== undefined || b.phone !== undefined) {
      const dup = await findDuplicates(db, { email: b.email ?? before.email, phone: b.phone ?? before.phone }, before.id);
      if (dup.exact.length) throw conflict('Another customer already uses this email or phone number.', { duplicates: dup.exact });
    }
    const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const vals = keys.map((k) => (k === 'notificationOptOut' ? JSON.stringify((b as any)[k]) : (b as any)[k]));
    const after = await db.one(`UPDATE customers SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')}, phone_normalized = $${keys.length + 2} WHERE id = $1 RETURNING *`,
      [before.id, ...vals, normalizePhone(b.phone !== undefined ? b.phone : before.phone)]);
    await audit(db, req, { action: 'customer.updated', entityType: 'customer', entityId: before.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

customersRouter.post('/:id/archive', requirePermission('customers.delete'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    const open = await db.one(`SELECT count(*)::int n FROM work_orders WHERE customer_id = $1 AND status NOT IN ('completed','invoiced','paid','cancelled','rejected')`, [c.id]);
    if (open.n) throw conflict(`This customer has ${open.n} open work order(s). Complete or cancel them first.`);
    await db.query(`UPDATE customers SET archived_at = now(), status = 'archived' WHERE id = $1`, [c.id]);
    await audit(db, req, { action: 'customer.archived', entityType: 'customer', entityId: c.id });
  });
  res.json({ data: { ok: true } });
}));

customersRouter.post('/:id/restore', requirePermission('customers.delete'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    const dup = await findDuplicates(db, { email: c.email, phone: c.phone }, c.id);
    if (dup.exact.length) throw conflict('An active customer with the same email or phone exists. Merge or edit before restoring.');
    await db.query(`UPDATE customers SET archived_at = NULL, status = 'active' WHERE id = $1`, [c.id]);
    await audit(db, req, { action: 'customer.restored', entityType: 'customer', entityId: c.id });
  });
  res.json({ data: { ok: true } });
}));

/** Hard delete is allowed only for customers with no business history (retention rules). Otherwise archive or anonymise. */
customersRouter.delete('/:id', requirePermission('customers.delete'), ah(async (req, res) => {
  await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    const h = await db.one(`SELECT (SELECT count(*) FROM work_orders WHERE customer_id = $1) + (SELECT count(*) FROM invoices WHERE customer_id = $1)
      + (SELECT count(*) FROM quotations WHERE customer_id = $1) + (SELECT count(*) FROM assets WHERE customer_id = $1)
      + (SELECT count(*) FROM service_requests WHERE customer_id = $1) + (SELECT count(*) FROM amc_contracts WHERE customer_id = $1) AS n`, [c.id]);
    if (Number(h.n) > 0) throw conflict('This customer has business history and cannot be deleted. Archive the customer instead.');
    await db.query(`DELETE FROM customers WHERE id = $1`, [c.id]);
    await audit(db, req, { action: 'customer.deleted', entityType: 'customer', entityId: c.id, before: c });
  });
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- addresses
customersRouter.post('/:id/addresses', requirePermission('customers.update'), ah(async (req, res) => {
  const b = parse(addressSchema, req.body);
  const a = await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    const a = await insertAddress(db, c.id, b);
    await audit(db, req, { action: 'customer.address_added', entityType: 'customer', entityId: c.id, after: a });
    return a;
  });
  res.status(201).json({ data: a });
}));

customersRouter.patch('/:id/addresses/:addressId', requirePermission('customers.update'), ah(async (req, res) => {
  const b = parse(addressSchema.partial(), req.body);
  const a = await tx(req, async (db) => {
    const before = await db.maybeOne(`SELECT * FROM customer_addresses WHERE id = $1 AND customer_id = $2`, [req.params.addressId, req.params.id]);
    if (!before) throw badRequest('Address not found');
    if (b.isDefault) await db.query(`UPDATE customer_addresses SET is_default = false WHERE customer_id = $1`, [req.params.id]);
    const m: Record<string, string> = { label: 'label', line1: 'line1', line2: 'line2', city: 'city', state: 'state', postalCode: 'postal_code', country: 'country',
      latitude: 'latitude', longitude: 'longitude', accessNotes: 'access_notes', serviceAreaId: 'service_area_id', isDefault: 'is_default' };
    const keys = Object.keys(m).filter((k) => (b as any)[k] !== undefined);
    if (!keys.length) return before;
    const after = await db.one(`UPDATE customer_addresses SET ${keys.map((k, i) => `${m[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`, [before.id, ...keys.map((k) => (b as any)[k])]);
    await audit(db, req, { action: 'customer.address_updated', entityType: 'customer', entityId: req.params.id, ...diff(before, after) });
    return after;
  });
  res.json({ data: a });
}));

customersRouter.delete('/:id/addresses/:addressId', requirePermission('customers.update'), ah(async (req, res) => {
  await tx(req, async (db) => {
    await db.query(`UPDATE customer_addresses SET deleted_at = now(), is_default = false WHERE id = $1 AND customer_id = $2`, [req.params.addressId, req.params.id]);
    await audit(db, req, { action: 'customer.address_removed', entityType: 'customer', entityId: req.params.id, before: { addressId: req.params.addressId } });
  });
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- communication log
customersRouter.post('/:id/communications', requirePermission('customers.update', 'communications.manage'), ah(async (req, res) => {
  const b = parse(z.object({ channel: z.enum(['phone', 'in_person', 'note', 'email', 'whatsapp', 'sms']), direction: z.enum(['inbound', 'outbound', 'internal']).default('internal'),
    subject: z.string().max(200).nullish(), body: z.string().trim().min(1).max(5000) }), req.body);
  const row = await tx(req, async (db) => {
    const c = await mustFind(db, 'customers', req.params.id, 'Customer');
    return db.one(`INSERT INTO communications (tenant_id, customer_id, channel, direction, subject, body, user_id) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [db.tenantId, c.id, b.channel, b.direction, b.subject ?? null, b.body, req.auth!.userId]);
  });
  res.status(201).json({ data: row });
}));

import { Router } from 'express';
import { z } from 'zod';
import { requirePermission } from '../../auth/middleware.js';
import { ah, parse } from '../../lib/http.js';
import { audit, diff } from '../../lib/audit.js';
import { badRequest, conflict } from '../../lib/errors.js';
import { tx, mustFind, tenantSettings } from '../common.js';
import { assertLimit, getEntitlements } from '../subscriptions/entitlements.js';
import { applyCategoryPreset, CATEGORY_PRESETS } from '../tenants/provision.js';

export const settingsRouter = Router();
const manage = requirePermission('settings.manage');

// ---------------------------------------------------------------- business profile & settings
settingsRouter.get('/', ah(async (req, res) => {
  const data = await tx(req, async (db) => {
    const s = await tenantSettings(db);
    const [branches, taxRates, serviceCategories, equipmentCategories, serviceAreas, holidays, stockLocations] = await Promise.all([
      db.many(`SELECT * FROM branches ORDER BY is_headquarters DESC, name`),
      db.many(`SELECT * FROM tax_rates ORDER BY is_default DESC, rate DESC, name`),
      db.many(`SELECT * FROM service_categories ORDER BY name`),
      db.many(`SELECT * FROM equipment_categories ORDER BY name`),
      db.many(`SELECT * FROM service_areas ORDER BY name`),
      db.many(`SELECT * FROM holidays WHERE date >= current_date - 30 ORDER BY date`),
      db.many(`SELECT * FROM stock_locations ORDER BY is_default DESC, name`),
    ]);
    return { settings: s, branches, taxRates, serviceCategories, equipmentCategories, serviceAreas, holidays, stockLocations };
  });
  res.json({ data });
}));

const profileSchema = z.object({
  name: z.string().trim().min(2).max(120), legalName: z.string().trim().max(200).nullish(), email: z.string().email().nullish(),
  phone: z.string().max(30).nullish(), addressLine1: z.string().max(200).nullish(), addressLine2: z.string().max(200).nullish(),
  city: z.string().max(100).nullish(), state: z.string().max(100).nullish(), postalCode: z.string().max(20).nullish(),
  country: z.string().length(2).toUpperCase(), businessCategory: z.string().max(60).nullish(),
  employeeCount: z.coerce.number().int().min(0).max(100000).nullish(), technicianCount: z.coerce.number().int().min(0).max(100000).nullish(),
}).partial({ country: true });

settingsRouter.patch('/profile', manage, ah(async (req, res) => {
  const b = parse(profileSchema, req.body);
  const out = await tx(req, async (db) => {
    const before = await db.one(`SELECT * FROM tenants WHERE id = $1`, [db.tenantId]);
    const after = await db.one(
      `UPDATE tenants SET name=$2, legal_name=$3, email=$4, phone=$5, address_line1=$6, address_line2=$7, city=$8, state=$9, postal_code=$10,
         country=COALESCE($11,country), business_category=$12, employee_count=$13, technician_count=$14 WHERE id=$1 RETURNING *`,
      [db.tenantId, b.name, b.legalName ?? null, b.email ?? null, b.phone ?? null, b.addressLine1 ?? null, b.addressLine2 ?? null, b.city ?? null,
        b.state ?? null, b.postalCode ?? null, b.country ?? null, b.businessCategory ?? null, b.employeeCount ?? null, b.technicianCount ?? null]);
    await audit(db, req, { action: 'settings.profile_updated', entityType: 'tenant', entityId: db.tenantId, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

const settingsSchema = z.object({
  currency: z.string().length(3).toUpperCase(), timezone: z.string().max(60), locale: z.string().max(10), dateFormat: z.string().max(30),
  taxRegime: z.enum(['GST', 'VAT', 'SALES_TAX', 'NONE']), taxRegistrationNumber: z.string().max(40).nullable(), taxRegistrationLabel: z.string().max(30),
  pricesIncludeTax: z.boolean(), workingDays: z.array(z.number().int().min(1).max(7)).max(7),
  workingHoursStart: z.string().regex(/^\d{2}:\d{2}$/), workingHoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
  jobNumberPrefix: z.string().max(10), invoiceNumberPrefix: z.string().max(10), quotationNumberPrefix: z.string().max(10),
  requestNumberPrefix: z.string().max(10), amcNumberPrefix: z.string().max(10), customerNumberPrefix: z.string().max(10),
  paymentTermsDays: z.number().int().min(0).max(365), quotationValidityDays: z.number().int().min(1).max(365),
  invoiceFooter: z.string().max(2000).nullable(), quotationTerms: z.string().max(4000).nullable(), cancellationPolicy: z.string().max(4000).nullable(),
  cancellationNoticeHours: z.number().int().min(0).max(720), preventDoubleBooking: z.boolean(), inventoryEnabled: z.boolean(),
  technicianCanSeePrices: z.boolean(), locationTrackingEnabled: z.boolean(), publicRequestFormEnabled: z.boolean(),
  notificationPreferences: z.record(z.string(), z.object({ email: z.boolean().optional(), whatsapp: z.boolean().optional(), sms: z.boolean().optional() })),
  documentRetentionDays: z.number().int().min(30).max(36500).nullable(), brandColor: z.string().regex(/^#[0-9a-f]{6}$/i).nullable(),
}).partial();

const colMap: Record<string, string> = {
  currency: 'currency', timezone: 'timezone', locale: 'locale', dateFormat: 'date_format', taxRegime: 'tax_regime',
  taxRegistrationNumber: 'tax_registration_number', taxRegistrationLabel: 'tax_registration_label', pricesIncludeTax: 'prices_include_tax',
  workingDays: 'working_days', workingHoursStart: 'working_hours_start', workingHoursEnd: 'working_hours_end', jobNumberPrefix: 'job_number_prefix',
  invoiceNumberPrefix: 'invoice_number_prefix', quotationNumberPrefix: 'quotation_number_prefix', requestNumberPrefix: 'request_number_prefix',
  amcNumberPrefix: 'amc_number_prefix', customerNumberPrefix: 'customer_number_prefix', paymentTermsDays: 'payment_terms_days',
  quotationValidityDays: 'quotation_validity_days', invoiceFooter: 'invoice_footer', quotationTerms: 'quotation_terms',
  cancellationPolicy: 'cancellation_policy', cancellationNoticeHours: 'cancellation_notice_hours', preventDoubleBooking: 'prevent_double_booking',
  inventoryEnabled: 'inventory_enabled', technicianCanSeePrices: 'technician_can_see_prices', locationTrackingEnabled: 'location_tracking_enabled',
  publicRequestFormEnabled: 'public_request_form_enabled', notificationPreferences: 'notification_preferences',
  documentRetentionDays: 'document_retention_days', brandColor: 'brand_color',
};

settingsRouter.patch('/', manage, ah(async (req, res) => {
  const b = parse(settingsSchema, req.body);
  if (b.timezone) { try { new Intl.DateTimeFormat('en', { timeZone: b.timezone }); } catch { throw badRequest('Unknown time zone'); } }
  const entries = Object.entries(b).filter(([k]) => colMap[k]);
  if (!entries.length) throw badRequest('Nothing to update');
  const out = await tx(req, async (db) => {
    if (b.currency) {
      const issued = await db.maybeOne(`SELECT 1 FROM invoices WHERE status <> 'draft' LIMIT 1`);
      const current = await db.one(`SELECT currency FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
      if (issued && current.currency !== b.currency) throw conflict('Currency cannot be changed after invoices have been issued.');
    }
    const before = await db.one(`SELECT * FROM tenant_settings WHERE tenant_id = $1`, [db.tenantId]);
    const sets = entries.map(([k], i) => `${colMap[k]} = $${i + 2}`).join(', ');
    const vals = entries.map(([k, v]) => (k === 'notificationPreferences' ? JSON.stringify(v) : v));
    const after = await db.one(`UPDATE tenant_settings SET ${sets} WHERE tenant_id = $1 RETURNING *`, [db.tenantId, ...vals]);
    await audit(db, req, { action: 'settings.updated', entityType: 'tenant_settings', entityId: db.tenantId, ...diff(before, after) });
    return after;
  });
  res.json({ data: out });
}));

// ---------------------------------------------------------------- onboarding wizard
settingsRouter.get('/onboarding/presets', ah(async (_req, res) => {
  res.json({ data: Object.entries(CATEGORY_PRESETS).map(([key, p]) => ({ key, services: p.services.map((s) => s[0]), equipment: p.equipment.map((e) => e[0]) })) });
}));

settingsRouter.post('/onboarding', manage, ah(async (req, res) => {
  const b = parse(z.object({
    step: z.number().int().min(0).max(10),
    preset: z.string().max(30).optional(),
    serviceCategories: z.array(z.string().trim().min(2).max(80)).max(50).optional(),
    serviceAreas: z.array(z.object({ name: z.string().trim().min(2).max(80), postalCodes: z.array(z.string().max(12)).max(200).default([]) })).max(100).optional(),
    holidays: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().max(80) })).max(100).optional(),
    complete: z.boolean().optional(),
    sampleData: z.boolean().optional(),
  }), req.body);
  if (b.preset) await applyCategoryPreset(req.auth!.tenantId!, b.preset);
  await tx(req, async (db) => {
    for (const name of b.serviceCategories ?? []) await db.query(`INSERT INTO service_categories (tenant_id, name) VALUES ($1,$2) ON CONFLICT DO NOTHING`, [db.tenantId, name]);
    for (const a of b.serviceAreas ?? []) await db.query(`INSERT INTO service_areas (tenant_id, name, postal_codes) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, name) DO UPDATE SET postal_codes = EXCLUDED.postal_codes`, [db.tenantId, a.name, a.postalCodes]);
    for (const h of b.holidays ?? []) await db.query(`INSERT INTO holidays (tenant_id, date, name) VALUES ($1,$2,$3) ON CONFLICT (tenant_id, date) DO UPDATE SET name = EXCLUDED.name`, [db.tenantId, h.date, h.name]);
    await db.query(`UPDATE tenant_settings SET onboarding_step = GREATEST(onboarding_step, $2), onboarding_completed_at = CASE WHEN $3 THEN COALESCE(onboarding_completed_at, now()) ELSE onboarding_completed_at END WHERE tenant_id = $1`,
      [db.tenantId, b.step, !!b.complete]);
    if (b.complete) await audit(db, req, { action: 'onboarding.completed', entityType: 'tenant', entityId: db.tenantId });
  });
  if (b.sampleData) {
    const { seedSampleData } = await import('../../seed/sample.js');
    await seedSampleData(req.auth!.tenantId!);
  }
  res.json({ data: { ok: true } });
}));

// ---------------------------------------------------------------- generic small reference tables
function crud(path: string, table: string, schema: z.ZodObject<any>, cols: Record<string, string>, opts: { before?: (db: any, body: any) => Promise<void> } = {}) {
  settingsRouter.post(`/${path}`, manage, ah(async (req, res) => {
    const b = parse(schema, req.body);
    const row = await tx(req, async (db) => {
      if (opts.before) await opts.before(db, b);
      const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
      const r = await db.one(`INSERT INTO ${table} (tenant_id, ${keys.map((k) => cols[k]).join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
        [db.tenantId, ...keys.map((k) => (typeof (b as any)[k] === 'object' && !Array.isArray((b as any)[k]) && (b as any)[k] !== null ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
      await audit(db, req, { action: `${path}.created`, entityType: table, entityId: r.id, after: r });
      return r;
    });
    res.status(201).json({ data: row });
  }));
  settingsRouter.patch(`/${path}/:id`, manage, ah(async (req, res) => {
    const b = parse(schema.partial(), req.body);
    const row = await tx(req, async (db) => {
      const before = await mustFind(db, table, req.params.id, path);
      const keys = Object.keys(cols).filter((k) => (b as any)[k] !== undefined);
      if (!keys.length) return before;
      const r = await db.one(`UPDATE ${table} SET ${keys.map((k, i) => `${cols[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
        [req.params.id, ...keys.map((k) => (typeof (b as any)[k] === 'object' && !Array.isArray((b as any)[k]) && (b as any)[k] !== null ? JSON.stringify((b as any)[k]) : (b as any)[k]))]);
      await audit(db, req, { action: `${path}.updated`, entityType: table, entityId: r.id, ...diff(before, r) });
      return r;
    });
    res.json({ data: row });
  }));
  settingsRouter.delete(`/${path}/:id`, manage, ah(async (req, res) => {
    await tx(req, async (db) => {
      const before = await mustFind(db, table, req.params.id, path);
      try {
        await db.query('SAVEPOINT del');
        await db.query(`DELETE FROM ${table} WHERE id = $1`, [req.params.id]);
      } catch (e: any) {
        if (e.code !== '23503') throw e;
        await db.query('ROLLBACK TO SAVEPOINT del');
        if ('is_active' in before) await db.query(`UPDATE ${table} SET is_active = false WHERE id = $1`, [req.params.id]);
        else throw conflict('This record is in use and cannot be deleted.');
      }
      await audit(db, req, { action: `${path}.deleted`, entityType: table, entityId: req.params.id, before });
    });
    res.json({ data: { ok: true } });
  }));
}

crud('tax-rates', 'tax_rates', z.object({ name: z.string().trim().min(1).max(60), rate: z.number().min(0).max(100),
  components: z.array(z.object({ name: z.string().max(20), rate: z.number().min(0).max(100) })).max(4).default([]),
  isDefault: z.boolean().default(false), isActive: z.boolean().default(true) }),
  { name: 'name', rate: 'rate', components: 'components', isDefault: 'is_default', isActive: 'is_active' },
  { before: async (db, b) => { if (b.isDefault) await db.query(`UPDATE tax_rates SET is_default = false`); } });

crud('service-categories', 'service_categories', z.object({ name: z.string().trim().min(2).max(80), description: z.string().max(500).nullish(),
  defaultDurationMinutes: z.number().int().min(5).max(1440).default(60), defaultPrice: z.number().min(0).nullish(), color: z.string().max(20).nullish(),
  isActive: z.boolean().default(true) }),
  { name: 'name', description: 'description', defaultDurationMinutes: 'default_duration_minutes', defaultPrice: 'default_price', color: 'color', isActive: 'is_active' });

crud('equipment-categories', 'equipment_categories', z.object({ name: z.string().trim().min(2).max(80), maintenanceIntervalDays: z.number().int().min(1).max(3650).nullish() }),
  { name: 'name', maintenanceIntervalDays: 'maintenance_interval_days' });

crud('service-areas', 'service_areas', z.object({ name: z.string().trim().min(2).max(80), postalCodes: z.array(z.string().trim().max(12)).max(500).default([]),
  description: z.string().max(500).nullish(), branchId: z.string().uuid().nullish(), isActive: z.boolean().default(true) }),
  { name: 'name', postalCodes: 'postal_codes', description: 'description', branchId: 'branch_id', isActive: 'is_active' });

crud('holidays', 'holidays', z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), name: z.string().trim().min(2).max(80) }), { date: 'date', name: 'name' });

crud('stock-locations', 'stock_locations', z.object({ name: z.string().trim().min(2).max(80), locationType: z.enum(['warehouse', 'van', 'store']).default('warehouse'),
  branchId: z.string().uuid().nullish(), technicianId: z.string().uuid().nullish() }),
  { name: 'name', locationType: 'location_type', branchId: 'branch_id', technicianId: 'technician_id' });

// Branches are gated by plan (multi-branch) and branches.manage permission
const branchSchema = z.object({ name: z.string().trim().min(2).max(80), code: z.string().trim().toUpperCase().regex(/^[A-Z0-9-]{2,10}$/),
  phone: z.string().max(30).nullish(), email: z.string().email().nullish(), addressLine1: z.string().max(200).nullish(), city: z.string().max(100).nullish(),
  state: z.string().max(100).nullish(), postalCode: z.string().max(20).nullish(), isActive: z.boolean().default(true) });
const branchCols = { name: 'name', code: 'code', phone: 'phone', email: 'email', addressLine1: 'address_line1', city: 'city', state: 'state', postalCode: 'postal_code', isActive: 'is_active' };

settingsRouter.post('/branches', requirePermission('branches.manage'), ah(async (req, res) => {
  const b = parse(branchSchema, req.body);
  const ent = await getEntitlements(req.auth!.tenantId!);
  if (!ent.features.multi_branch && ent.limits.branches <= 1) throw conflict('Multiple branches are available on plans that include multi-branch management.');
  const row = await tx(req, async (db) => {
    await assertLimit(db, 'branches');
    const keys = Object.keys(branchCols).filter((k) => (b as any)[k] !== undefined);
    const r = await db.one(`INSERT INTO branches (tenant_id, ${keys.map((k) => (branchCols as any)[k]).join(',')}) VALUES ($1, ${keys.map((_, i) => `$${i + 2}`).join(',')}) RETURNING *`,
      [db.tenantId, ...keys.map((k) => (b as any)[k])]);
    await db.query(`INSERT INTO stock_locations (tenant_id, branch_id, name) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [db.tenantId, r.id, `${r.name} Store`]);
    await audit(db, req, { action: 'branch.created', entityType: 'branch', entityId: r.id, after: r });
    return r;
  });
  res.status(201).json({ data: row });
}));

settingsRouter.patch('/branches/:id', requirePermission('branches.manage'), ah(async (req, res) => {
  const b = parse(branchSchema.partial(), req.body);
  const row = await tx(req, async (db) => {
    const before = await mustFind(db, 'branches', req.params.id, 'Branch');
    if (b.isActive === false && before.is_headquarters) throw conflict('The head office branch cannot be deactivated.');
    const keys = Object.keys(branchCols).filter((k) => (b as any)[k] !== undefined);
    const r = keys.length ? await db.one(`UPDATE branches SET ${keys.map((k, i) => `${(branchCols as any)[k]} = $${i + 2}`).join(', ')} WHERE id = $1 RETURNING *`,
      [req.params.id, ...keys.map((k) => (b as any)[k])]) : before;
    await audit(db, req, { action: 'branch.updated', entityType: 'branch', entityId: r.id, ...diff(before, r) });
    return r;
  });
  res.json({ data: row });
}));

// Support access: owner grants NEXUS staff time-boxed read-only access to this tenant
settingsRouter.get('/support-access', manage, ah(async (req, res) => {
  const { systemDb } = await import('../../db/pool.js');
  res.json({ data: await systemDb.many(`SELECT g.id, g.reason, g.expires_at, g.revoked_at, g.created_at, u.full_name AS granted_by
    FROM support_access_grants g JOIN users u ON u.id = g.granted_by WHERE g.tenant_id = $1 ORDER BY g.created_at DESC LIMIT 20`, [req.auth!.tenantId]) });
}));
settingsRouter.post('/support-access', requirePermission('subscription.manage', 'settings.manage'), ah(async (req, res) => {
  const b = parse(z.object({ reason: z.string().trim().min(5).max(500), hours: z.number().int().min(1).max(72) }), req.body);
  const { withSystem } = await import('../../db/pool.js');
  const g = await withSystem(async (db) => {
    const g = await db.one(`INSERT INTO support_access_grants (tenant_id, granted_by, reason, expires_at) VALUES ($1,$2,$3, now() + ($4 || ' hours')::interval) RETURNING *`,
      [req.auth!.tenantId, req.auth!.userId, b.reason, String(b.hours)]);
    await audit(db, req, { action: 'support_access.granted', entityType: 'support_access_grant', entityId: g.id, after: { hours: b.hours, reason: b.reason } }, { tenantId: req.auth!.tenantId });
    return g;
  });
  res.status(201).json({ data: g });
}));
settingsRouter.delete('/support-access/:id', manage, ah(async (req, res) => {
  const { withSystem } = await import('../../db/pool.js');
  const { invalidateAuthCache } = await import('../../auth/context.js');
  await withSystem(async (db) => {
    await db.query(`UPDATE support_access_grants SET revoked_at = now() WHERE id = $1 AND tenant_id = $2`, [req.params.id, req.auth!.tenantId]);
    await db.query(`UPDATE sessions SET revoked_at = now() WHERE support_access_grant_id = $1`, [req.params.id]);
    await audit(db, req, { action: 'support_access.revoked', entityType: 'support_access_grant', entityId: req.params.id }, { tenantId: req.auth!.tenantId });
  });
  invalidateAuthCache();
  res.json({ data: { ok: true } });
}));

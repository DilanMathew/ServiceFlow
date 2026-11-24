import type { Db } from '../../db/pool.js';
import { withTenant, systemDb } from '../../db/pool.js';
import { countryDefaults } from './countries.js';
import { conflict } from '../../lib/errors.js';

export interface ProvisionInput {
  businessName: string; slug: string; country: string; email: string; phone?: string | null;
  planCode?: string; billingCycle?: 'monthly' | 'annual'; isDemo?: boolean;
}

export const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'business';

export async function uniqueSlug(db: Db, base: string) {
  let slug = slugify(base); let i = 1;
  while (await db.maybeOne('SELECT 1 FROM tenants WHERE slug = $1', [slug])) slug = `${slugify(base).slice(0, 36)}-${++i}`;
  if (slug.length < 3) slug = `${slug}-co`;
  return slug;
}

/** Creates a tenant with settings, HQ branch, default tax rates, stock location and a trial subscription. */
export async function provisionTenant(db: Db, input: ProvisionInput) {
  const d = countryDefaults(input.country);
  if (await db.maybeOne('SELECT 1 FROM tenants WHERE slug = $1', [input.slug])) throw conflict('This workspace URL is already taken');
  const tenant = await db.one(
    `INSERT INTO tenants (name, slug, email, phone, country, is_demo) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [input.businessName, input.slug, input.email, input.phone ?? null, input.country.toUpperCase(), !!input.isDemo]);
  const t = tenant.id;
  await db.query(
    `INSERT INTO tenant_settings (tenant_id, currency, timezone, locale, tax_regime, tax_registration_label, working_days)
     VALUES ($1,$2,$3,$4,$5,$6,$7)`, [t, d.currency, d.timezone, d.locale, d.taxRegime, d.taxLabel, d.workingDays]);
  const branch = await db.one(`INSERT INTO branches (tenant_id, name, code, is_headquarters, country) VALUES ($1, 'Head Office', 'HQ', true, $2) RETURNING id`,
    [t, input.country.toUpperCase()]);
  for (const tax of d.taxes) {
    await db.query(`INSERT INTO tax_rates (tenant_id, name, rate, components, is_default) VALUES ($1,$2,$3,$4,$5)`,
      [t, tax.name, tax.rate, JSON.stringify(tax.components ?? []), !!tax.isDefault]);
  }
  await db.query(`INSERT INTO stock_locations (tenant_id, branch_id, name, is_default) VALUES ($1,$2,'Main Warehouse',true)`, [t, branch.id]);
  await db.query(`INSERT INTO integrations (tenant_id, kind, provider, mode, is_enabled, status) VALUES
     ($1,'email','platform','live',true,'ok'), ($1,'payment','test','test',true,'ok'), ($1,'maps','osm','live',true,'ok'), ($1,'ai','platform','live',true,'ok')`, [t]);

  const plan = await db.one(`SELECT * FROM subscription_plans WHERE code = $1 AND is_active`, [input.planCode ?? 'growth']);
  const cycle = input.billingCycle ?? 'monthly';
  const sub = await db.one(
    `INSERT INTO subscriptions (tenant_id, plan_id, status, billing_cycle, price, currency, trial_ends_at, current_period_start, current_period_end)
     VALUES ($1,$2,'trialing',$3,$4,$5, now() + ($6 || ' days')::interval, now(), now() + ($6 || ' days')::interval) RETURNING id`,
    [t, plan.id, cycle, cycle === 'annual' ? plan.annual_price : plan.monthly_price, plan.currency, String(plan.trial_days)]);
  await db.query(`INSERT INTO subscription_events (tenant_id, subscription_id, event_type, to_plan_id, details) VALUES ($1,$2,'trial_started',$3,$4)`,
    [t, sub.id, plan.id, JSON.stringify({ trial_days: plan.trial_days })]);
  return { tenant, branchId: branch.id };
}

export async function assignRole(db: Db, userId: string, tenantId: string | null, roleKey: string) {
  const role = await db.one(
    `SELECT id FROM roles WHERE key = $1 AND (tenant_id IS NULL OR tenant_id = $2) ORDER BY tenant_id NULLS LAST LIMIT 1`, [roleKey, tenantId]);
  await db.query(`INSERT INTO user_roles (user_id, role_id, tenant_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, role.id, tenantId]);
}

/** Default service and equipment categories for the chosen business type (used by onboarding / sample setup). */
export const CATEGORY_PRESETS: Record<string, { services: [string, number][]; equipment: [string, number | null][] }> = {
  hvac: { services: [['AC Installation', 180], ['AC Repair', 90], ['AC Servicing', 60], ['Gas Refilling', 60], ['AC Uninstallation', 60]],
    equipment: [['Split AC', 90], ['Window AC', 90], ['Cassette AC', 90], ['VRF System', 90]] },
  electrical: { services: [['Wiring', 120], ['Electrical Repair', 60], ['Panel Installation', 180], ['Inspection', 60]], equipment: [['Distribution Board', 365], ['Inverter', 180], ['Lighting System', null]] },
  plumbing: { services: [['Leak Repair', 60], ['Pipe Installation', 120], ['Drain Cleaning', 60], ['Water Heater Service', 90]], equipment: [['Water Heater', 180], ['Pump', 180], ['Water Purifier', 90]] },
  appliance: { services: [['Washing Machine Repair', 60], ['Refrigerator Repair', 90], ['Microwave Repair', 45], ['Installation', 60]], equipment: [['Washing Machine', 180], ['Refrigerator', 180], ['Microwave', null]] },
  cctv: { services: [['CCTV Installation', 240], ['CCTV Maintenance', 60], ['DVR/NVR Configuration', 60]], equipment: [['CCTV System', 180], ['DVR/NVR', 180], ['IP Camera', 180]] },
  solar: { services: [['Solar Installation', 480], ['Panel Cleaning', 60], ['Inverter Service', 90], ['Performance Audit', 120]], equipment: [['Solar Inverter', 180], ['Solar Panel Array', 90], ['Battery Bank', 180]] },
  generator: { services: [['Generator Service', 120], ['Generator Repair', 120], ['Load Testing', 90]], equipment: [['Diesel Generator', 90], ['Gas Generator', 90], ['UPS', 180]] },
  general: { services: [['General Service', 60], ['Repair', 90], ['Installation', 120], ['Inspection', 60]], equipment: [['General Equipment', null]] },
};

export async function applyCategoryPreset(tenantId: string, preset: string) {
  const p = CATEGORY_PRESETS[preset] ?? CATEGORY_PRESETS.general;
  await withTenant(tenantId, async (db) => {
    for (const [name, mins] of p.services) {
      await db.query(`INSERT INTO service_categories (tenant_id, name, default_duration_minutes) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, name, mins]);
    }
    for (const [name, interval] of p.equipment) {
      await db.query(`INSERT INTO equipment_categories (tenant_id, name, maintenance_interval_days) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [tenantId, name, interval]);
    }
  });
}
export { systemDb };

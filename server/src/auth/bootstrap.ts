import type { Db } from '../db/pool.js';
import { PERMISSIONS, SYSTEM_ROLES } from './permissions.js';
import { DEFAULT_TEMPLATES } from '../modules/notifications/templates.js';
import { DEFAULT_PLANS } from '../modules/subscriptions/plans.js';

/** Idempotent sync of reference data (permissions, system roles, default templates, plans). */
export async function bootstrapReferenceData(db: Db) {
  for (const [code, description] of Object.entries(PERMISSIONS)) {
    await db.query(
      `INSERT INTO permissions (code, module, description) VALUES ($1, split_part($1, '.', 1), $2)
       ON CONFLICT (code) DO UPDATE SET description = EXCLUDED.description`, [code, description]);
  }
  for (const r of SYSTEM_ROLES) {
    const role = await db.one(
      `INSERT INTO roles (tenant_id, key, name, description, scope, is_system) VALUES (NULL, $1, $2, $3, $4, true)
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), key)
       DO UPDATE SET name = EXCLUDED.name, description = EXCLUDED.description RETURNING id`,
      [r.key, r.name, r.description, r.scope]);
    await db.query('DELETE FROM role_permissions WHERE role_id = $1', [role.id]);
    await db.query(
      `INSERT INTO role_permissions (role_id, permission_code) SELECT $1, unnest($2::text[])`, [role.id, r.permissions]);
  }
  for (const t of DEFAULT_TEMPLATES) {
    await db.query(
      `INSERT INTO notification_templates (tenant_id, event, channel, subject, body, whatsapp_template_name)
       VALUES (NULL, $1, $2, $3, $4, $5)
       ON CONFLICT (COALESCE(tenant_id, '00000000-0000-0000-0000-000000000000'::uuid), event, channel) DO NOTHING`,
      [t.event, t.channel, t.subject ?? null, t.body, t.whatsappTemplate ?? null]);
  }
  for (const p of DEFAULT_PLANS) {
    await db.query(
      `INSERT INTO subscription_plans (code, name, description, currency, monthly_price, annual_price, trial_days, max_users,
         max_technicians, max_storage_mb, max_branches, ai_requests_per_month, features, sort_order, is_public)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) ON CONFLICT (code) DO NOTHING`,
      [p.code, p.name, p.description, p.currency, p.monthly, p.annual, p.trialDays, p.maxUsers, p.maxTechnicians, p.maxStorageMb,
        p.maxBranches, p.aiRequests, JSON.stringify(p.features), p.sort, p.isPublic]);
  }
}

import { config } from '../../config.js';
import { systemDb, withSystem } from '../../db/pool.js';
import { hashPassword } from '../../lib/crypto.js';
import { logger } from '../../logger.js';
import { assignRole } from '../tenants/provision.js';

/** Creates the first NEXUS Super Admin from env vars if none exists (idempotent). */
export async function ensurePlatformAdmin() {
  if (!config.PLATFORM_ADMIN_EMAIL || !config.PLATFORM_ADMIN_PASSWORD) return;
  const existing = await systemDb.maybeOne(`SELECT id FROM users WHERE user_type = 'platform' LIMIT 1`);
  if (existing) return;
  const hash = await hashPassword(config.PLATFORM_ADMIN_PASSWORD);
  await withSystem(async (db) => {
    const u = await db.one(`INSERT INTO users (tenant_id, email, password_hash, full_name, user_type, email_verified_at) VALUES (NULL,$1,$2,'NEXUS Super Admin','platform', now()) RETURNING id`,
      [config.PLATFORM_ADMIN_EMAIL!.toLowerCase(), hash]);
    await assignRole(db, u.id, null, 'super_admin');
  });
  logger.info({ email: config.PLATFORM_ADMIN_EMAIL }, 'platform super admin created');
}

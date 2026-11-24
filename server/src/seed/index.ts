import { pool, withSystem } from '../db/pool.js';
import { bootstrapReferenceData } from '../auth/bootstrap.js';
import { migrate } from '../db/migrate.js';
import { seedDemo, DEMO_PASSWORD } from './demo.js';
import { ensurePlatformAdmin } from '../modules/platform/bootstrap.js';

/** npm run seed — applies migrations and creates the CoolCare demo tenant (idempotent). */
(async () => {
  await migrate();
  await withSystem(bootstrapReferenceData);
  await ensurePlatformAdmin();
  const id = await seedDemo({ skipIfExists: true });
  console.log(`\nDemo tenant ready (${id}). Workspace: coolcare\n  owner@coolcare.example / ${DEMO_PASSWORD}\n  dispatch@coolcare.example, accounts@coolcare.example, tech@coolcare.example (same password)\n  customer portal: customer@coolcare.example\n`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

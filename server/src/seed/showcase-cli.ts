import { pool } from '../db/pool.js';
import { migrate } from '../db/migrate.js';
import { seedShowcase, SHOWCASE, SHOWCASE_PASSWORD } from './showcase.js';

/** npm run seed:showcase — creates the five sample companies (idempotent). */
(async () => {
  await migrate();
  await seedShowcase();
  for (const p of SHOWCASE) console.log(`${p.name.padEnd(28)} workspace ${p.slug.padEnd(20)} owner@${p.slug}.example / ${SHOWCASE_PASSWORD}`);
  await pool.end();
})().catch((e) => { console.error(e); process.exit(1); });

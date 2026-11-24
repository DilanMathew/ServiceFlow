import pg from 'pg';

/** Fresh schema for every test run: drop and re-apply all migrations + reference data. */
export default async function setup() {
  await import('./setupEnv.js');
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  await client.query('DROP SCHEMA IF EXISTS public CASCADE; CREATE SCHEMA public;');
  await client.end();
  const { migrate } = await import('../src/db/migrate.js');
  const { withSystem, pool } = await import('../src/db/pool.js');
  const { bootstrapReferenceData } = await import('../src/auth/bootstrap.js');
  await migrate();
  await withSystem(bootstrapReferenceData);
  await pool.end();
}

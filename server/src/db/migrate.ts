import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from './pool.js';
import { logger } from '../logger.js';

const dir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../migrations');
// works both from src (tsx) and dist/src (compiled)
const migrationsDir = fs.existsSync(dir) ? dir : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../migrations');

export async function migrate(): Promise<string[]> {
  const client = await pool.connect();
  const applied: string[] = [];
  try {
    // Serialize concurrent migrators (multiple replicas starting at once)
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Set((await client.query('SELECT name FROM schema_migrations')).rows.map((r) => r.name));
    const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
    for (const file of files) {
      if (done.has(file)) continue;
      const sql = fs.readFileSync(path.join(migrationsDir, file), 'utf8');
      logger.info({ file }, 'applying migration');
      await client.query('BEGIN');
      try {
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations(name) VALUES ($1)', [file]);
        await client.query('COMMIT');
        applied.push(file);
      } catch (err) {
        await client.query('ROLLBACK');
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
  }
  return applied;
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  migrate()
    .then((a) => { console.log(a.length ? `Applied: ${a.join(', ')}` : 'Database up to date'); return pool.end(); })
    .catch((e) => { console.error(e.message); process.exit(1); });
}

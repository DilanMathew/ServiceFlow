import pg from 'pg';
import { config } from '../config.js';
import { logger } from '../logger.js';

// Return numerics as strings (exact money) but parse int8 counts as numbers.
pg.types.setTypeParser(20, (v) => parseInt(v, 10));
pg.types.setTypeParser(1082, (v) => v); // date -> 'YYYY-MM-DD' string, no TZ shifting

export const pool = new pg.Pool({
  connectionString: config.DATABASE_URL,
  ssl: config.DATABASE_SSL ? { rejectUnauthorized: false } : undefined,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000,
});
pool.on('error', (err) => logger.error({ err }, 'postgres pool error'));

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<pg.QueryResult<T & pg.QueryResultRow>>;
  many<T = any>(sql: string, params?: unknown[]): Promise<T[]>;
  one<T = any>(sql: string, params?: unknown[]): Promise<T>;
  maybeOne<T = any>(sql: string, params?: unknown[]): Promise<T | null>;
  tenantId: string | null;
}

function wrap(client: pg.PoolClient | pg.Pool, tenantId: string | null): Db {
  return {
    tenantId,
    query: (sql, params) => client.query(sql, params as any[]),
    many: async (sql, params) => (await client.query(sql, params as any[])).rows,
    one: async (sql, params) => {
      const r = await client.query(sql, params as any[]);
      if (r.rows.length === 0) throw new Error('Expected one row, got none');
      return r.rows[0];
    },
    maybeOne: async (sql, params) => (await client.query(sql, params as any[])).rows[0] ?? null,
  };
}

/**
 * Run fn inside a transaction bound to a tenant. Row level security is enforced by switching to
 * the non-privileged app_tenant role; every query inside can only see/modify this tenant's rows.
 */
export async function withTenant<T>(tenantId: string, fn: (db: Db) => Promise<T>): Promise<T> {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId)) throw new Error('Invalid tenant id');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SET LOCAL ROLE app_tenant');
    await client.query(`SELECT set_config('app.tenant_id', $1, true)`, [tenantId]);
    const result = await fn(wrap(client, tenantId));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Privileged transaction for platform-level operations (auth, super admin, webhooks, workers).
 * Code using this MUST filter by tenant explicitly. Keep usages small and reviewed.
 */
export async function withSystem<T>(fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(wrap(client, null));
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

export const systemDb: Db = wrap(pool, null);

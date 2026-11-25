import os from 'node:os';
import type { Db } from '../db/pool.js';
import { pool, systemDb } from '../db/pool.js';
import { logger } from '../logger.js';
import { captureError } from '../lib/monitoring.js';

export interface EnqueueOpts { runAt?: Date; maxAttempts?: number; dedupeKey?: string; queue?: string }

/** Enqueue inside the caller's transaction: the job exists only if the business change commits. */
export async function enqueue(db: Db, jobType: string, payload: Record<string, unknown>, opts: EnqueueOpts = {}) {
  await db.query(
    `INSERT INTO background_jobs (tenant_id, queue, job_type, payload, run_at, max_attempts, dedupe_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (job_type, dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING`,
    [db.tenantId ?? (payload.tenantId as string | undefined) ?? null, opts.queue ?? 'default', jobType, JSON.stringify(payload),
      opts.runAt ?? new Date(), opts.maxAttempts ?? 5, opts.dedupeKey ?? null]);
}

export type JobHandler = (job: { id: number; tenant_id: string | null; payload: any; attempts: number }) => Promise<void>;
const handlers = new Map<string, JobHandler>();
export const registerHandler = (type: string, h: JobHandler) => handlers.set(type, h);

const workerId = `${os.hostname()}:${process.pid}`;
let timer: NodeJS.Timeout | null = null;
let running = false;

/** Claim and run up to `batch` due jobs. Exponential backoff; dead-letter after max_attempts. */
export async function runDueJobs(batch = 10): Promise<number> {
  const client = await pool.connect();
  let jobs: any[] = [];
  try {
    await client.query('BEGIN');
    // Recover jobs from crashed workers (locked > 10 min)
    await client.query(`UPDATE background_jobs SET status='pending', locked_at=NULL WHERE status='running' AND locked_at < now() - interval '10 minutes'`);
    jobs = (await client.query(
      `UPDATE background_jobs SET status='running', locked_at=now(), locked_by=$2, attempts = attempts + 1
       WHERE id IN (SELECT id FROM background_jobs WHERE status='pending' AND run_at <= now()
                    ORDER BY run_at FOR UPDATE SKIP LOCKED LIMIT $1)
       RETURNING id, tenant_id, job_type, payload, attempts, max_attempts`, [batch, workerId])).rows;
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
  for (const job of jobs) {
    const h = handlers.get(job.job_type);
    try {
      if (!h) throw new Error(`No handler for ${job.job_type}`);
      await h(job);
      await systemDb.query(`UPDATE background_jobs SET status='succeeded', completed_at=now(), last_error=NULL WHERE id=$1`, [job.id]);
    } catch (err) {
      const msg = (err as Error).message?.slice(0, 1000);
      const dead = job.attempts >= job.max_attempts;
      const delaySec = Math.min(3600, 15 * 2 ** (job.attempts - 1));
      logger.warn({ jobId: job.id, type: job.job_type, attempt: job.attempts, err: msg }, dead ? 'job dead-lettered' : 'job failed, will retry');
      if (dead) captureError(err, { jobId: job.id, jobType: job.job_type, tenantId: job.tenant_id, attempts: job.attempts });
      await systemDb.query(
        `UPDATE background_jobs SET status=$2, last_error=$3, run_at = now() + ($4 || ' seconds')::interval, locked_at=NULL WHERE id=$1`,
        [job.id, dead ? 'dead' : 'pending', msg, String(delaySec)]);
    }
  }
  return jobs.length;
}

export function startWorker(intervalMs = 2000) {
  if (timer) return;
  const tick = async () => {
    if (running) return;
    running = true;
    try {
      while ((await runDueJobs()) > 0) { /* drain */ }
    } catch (err) {
      logger.error({ err }, 'worker tick failed');
    } finally {
      running = false;
    }
  };
  timer = setInterval(tick, intervalMs);
  logger.info({ workerId }, 'background worker started');
}
export function stopWorker() { if (timer) clearInterval(timer); timer = null; }

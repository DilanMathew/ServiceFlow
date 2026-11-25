import { config } from './config.js';
import { logger } from './logger.js';
import { migrate } from './db/migrate.js';
import { pool, withSystem } from './db/pool.js';
import { createApp } from './app.js';
import { bootstrapReferenceData } from './auth/bootstrap.js';
import { startWorker, stopWorker } from './jobs/queue.js';
import { registerJobHandlers } from './jobs/handlers.js';
import { startScheduler, stopScheduler } from './jobs/scheduler.js';
import { ensurePlatformAdmin } from './modules/platform/bootstrap.js';
import { initMonitoring, captureError, flushMonitoring } from './lib/monitoring.js';
import { storage } from './integrations/storage.js';
import { ensureVapidKeys } from './integrations/push.js';

initMonitoring();

async function main() {
  const applied = await migrate();
  if (applied.length) logger.info({ applied }, 'migrations applied');
  await withSystem(bootstrapReferenceData);
  await ensurePlatformAdmin();
  if (config.SEED_DEMO) {
    const { seedDemo } = await import('./seed/demo.js');
    await seedDemo({ skipIfExists: true });
  }
  if (config.SEED_SHOWCASE) {
    const { seedShowcase } = await import('./seed/showcase.js');
    try { await seedShowcase(); } catch (err) { logger.error({ err }, 'showcase seeding failed'); }
  }
  // Storage self-check: surfaces bad bucket credentials at boot instead of on the first upload.
  try { await storage.health(); logger.info({ driver: config.STORAGE_DRIVER }, 'storage ok'); }
  catch (err) { logger.error({ err, driver: config.STORAGE_DRIVER }, 'storage check failed: uploads will not work until this is fixed'); captureError(err, { source: 'storage_check' }); }
  try { await ensureVapidKeys(); } catch (err) { logger.error({ err }, 'web push keys unavailable'); }
  registerJobHandlers();
  if (config.RUN_WORKER) { startWorker(); startScheduler(); }

  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, 'NEXUS ServiceFlow API listening'));
  const shutdown = (sig: string) => {
    logger.info({ sig }, 'shutting down');
    stopWorker(); stopScheduler();
    server.close(() => pool.end().then(() => flushMonitoring()).then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => { logger.error({ err }, 'unhandled rejection'); captureError(err, { source: 'unhandledRejection' }); });
}

main().catch(async (err) => { logger.fatal({ err }, 'failed to start'); console.error(err); captureError(err, { source: 'startup' }); await flushMonitoring(); process.exit(1); });

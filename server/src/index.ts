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

async function main() {
  const applied = await migrate();
  if (applied.length) logger.info({ applied }, 'migrations applied');
  await withSystem(bootstrapReferenceData);
  await ensurePlatformAdmin();
  if (config.SEED_DEMO) {
    const { seedDemo } = await import('./seed/demo.js');
    await seedDemo({ skipIfExists: true });
  }
  registerJobHandlers();
  if (config.RUN_WORKER) { startWorker(); startScheduler(); }

  const server = createApp().listen(config.PORT, () => logger.info({ port: config.PORT }, 'NEXUS ServiceFlow API listening'));
  const shutdown = (sig: string) => {
    logger.info({ sig }, 'shutting down');
    stopWorker(); stopScheduler();
    server.close(() => pool.end().then(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10_000).unref();
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('unhandledRejection', (err) => logger.error({ err }, 'unhandled rejection'));
}

main().catch((err) => { logger.fatal({ err }, 'failed to start'); console.error(err); process.exit(1); });

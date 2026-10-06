import Fastify from 'fastify';
import { createLogger } from './shared/config/index.js';
import { createDatabase, pingDatabase } from './db/index.js';
import { env } from './env.js';
import { closeQueues, connection, getQueue, keys, QueueName } from './queues/index.js';
import { createRedis, createResponseCache, pingRedis } from './shared/redis/index.js';
import { errorHandler } from './shared/http/errors.js';
import { createStorage, storageConfigFromEnv } from './shared/storage/index.js';
import { createQueueProducer } from './shared/queue/index.js';
import { createPaymentProvider } from './shared/billing/index.js';
import { startWorkers } from './workers.js';
import { registerSchedules } from './schedules.js';
import { sql } from 'drizzle-orm';
import { providerFromEnv } from './scan/providers.js';

/**
 * Scheduler + workers.
 *
 * Separate from the API because cron inside a horizontally-scaled API means
 * every replica runs every job, jobs die mid-flight on deploy, and a heavy
 * rollup starves request handlers (ARCHITECTURE.md §14).
 *
 * Jobs live in src/jobs/ and are registered in src/workers.ts. Every one of
 * them is idempotent, because BullMQ guarantees at-least-once delivery.
 */

const VERSION = '0.1.0';

const log = createLogger({
  service: env.SERVICE_NAME,
  level: env.LOG_LEVEL,
  pretty: env.NODE_ENV === 'development',
});

const { db, close: closeDatabase } = createDatabase({
  url: env.DATABASE_URL,
  poolMax: env.DATABASE_POOL_MAX,
  statementTimeoutMs: env.DATABASE_STATEMENT_TIMEOUT_MS,
});

// Commands (locks, cache invalidation) use a normal client; BullMQ has its own.
const redis = createRedis({ url: env.REDIS_URL, name: `${env.SERVICE_NAME}-cmd` });
const workerConnection = connection.duplicate();
const jobs = startWorkers(
  {
    db,
    redis,
    keys,
    log,
    storage: createStorage(storageConfigFromEnv(env)),
    mediaBucket: env.S3_BUCKET_MEDIA,
    scansBucket: env.S3_BUCKET_SCANS,
    responseCache: createResponseCache(redis, keys, { maxTtlMs: 5 * 60_000 }),
    queue: createQueueProducer(connection, keys.queuePrefix),
    scanProvider: providerFromEnv(env),
    payments: createPaymentProvider(env, { redis, keys, log }),
  },
  { connection: workerConnection, prefix: keys.queuePrefix, concurrency: env.WORKER_CONCURRENCY },
);

/**
 * The scheduler serves no traffic, but it still needs to tell an orchestrator
 * whether it is healthy — and, unlike the API, whether its queues are draining.
 * A worker that is "up" but not consuming is the failure that goes unnoticed.
 */
const app = Fastify({ loggerInstance: log, disableRequestLogging: true });
app.setErrorHandler(errorHandler);

app.get('/live', async () => ({ status: 'ok' }));

app.get('/ready', async (_req, reply) => {
  // Both bounded: this connection queues commands while Redis is away, so a
  // bare ping() hung the probe instead of failing it (measured, Phase 20).
  const [database, redis] = await Promise.all([pingDatabase(db), pingRedis(connection)]);
  const ready = database && redis;
  return reply.code(ready ? 200 : 503).send({
    status: ready ? 'ready' : 'not-ready',
    checks: { database, redis },
  });
});

/** A section of /health that could not be read in time says so rather than holding the response. */
const within = <T,>(work: Promise<T>, ms: number): Promise<T | 'unavailable'> => {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([work.catch(() => 'unavailable' as const), new Promise<'unavailable'>((resolve) => (timer = setTimeout(() => resolve('unavailable'), ms)))]).finally(() => clearTimeout(timer));
};

app.get('/health', async () => {
  const [lastRuns, queues] = await Promise.all([
    // Last run of every scheduled job: a job that silently stopped shows up here.
    within(
      db.execute(sql`
    SELECT DISTINCT ON (job_name) job_name AS "job", status, created_at AS "startedAt", finished_at AS "finishedAt", error
    FROM job_runs ORDER BY job_name, created_at DESC`) as unknown as Promise<Record<string, unknown>[]>,
      2_000,
    ),
    // Queue depth is the number worth alerting on: a backlog that only grows
    // means workers are wedged even though the process looks fine.
    within(Promise.all(Object.values(QueueName).map(async (name) => [name, await getQueue(name).getJobCounts('waiting', 'active', 'failed', 'delayed')] as const)).then(Object.fromEntries), 2_000),
  ]);

  return {
    status: 'ok',
    service: env.SERVICE_NAME,
    version: VERSION,
    concurrency: env.WORKER_CONCURRENCY,
    queues,
    lastRuns,
  };
});

async function shutdown(signal: string): Promise<void> {
  log.info({ signal }, 'shutting down');
  try {
    // Stop taking new work first, then let the pool go.
    await app.close();
    // Finish in-flight jobs before the pools go away.
    await jobs.close();
    workerConnection.disconnect();
    await closeQueues();
    await redis.quit();
    await closeDatabase();
    log.info('shutdown complete');
    process.exit(0);
  } catch (error) {
    log.error({ error }, 'shutdown failed');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

try {
  const scheduled = await registerSchedules((name) => getQueue(name as QueueName));
  await app.listen({ port: env.PORT, host: env.HOST });
  log.info({ scheduled }, 'job schedulers registered');
  log.info({ port: env.PORT, queues: Object.values(QueueName) }, 'equato-scheduler listening');
} catch (error) {
  log.error({ error }, 'failed to start');
  process.exit(1);
}

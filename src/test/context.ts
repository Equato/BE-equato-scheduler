import { randomUUID } from 'node:crypto';
import { pino } from 'pino';
import { createDatabase } from '../db/index.js';
import type { JobContext } from '../jobs/context.js';
import { createKeyspace, createRedis, createResponseCache } from '../shared/redis/index.js';
import type { JobPayloads, QueueProducer } from '../shared/queue/index.js';
import { createStorage, storageConfigFromEnv } from '../shared/storage/index.js';
import { env } from '../env.js';
import { mockProvider, type MenuScanProvider } from '../scan/providers.js';
import { MockPaymentProvider } from '../shared/billing/mock-provider.js';
import type { PaymentProvider } from '../shared/billing/provider.js';

/** A real JobContext on a private Redis prefix, with an in-memory queue to observe enqueued follow-ups. */
export async function testContext(opts: { scanProvider?: MenuScanProvider; payments?: PaymentProvider | null } = {}) {
  const prefix = `equato-sched-test-${randomUUID().slice(0, 8)}`;
  const keys = createKeyspace(prefix);
  const { db, close } = createDatabase({ url: env.DATABASE_URL, poolMax: 4, statementTimeoutMs: 10_000 });
  const redis = createRedis({ url: env.REDIS_URL, name: 'sched-test' });
  // Commands are not queued while offline (enableOfflineQueue: false): be connected first.
  await new Promise((resolve) => (redis.status === 'ready' ? resolve(undefined) : redis.once('ready', resolve)));
  const enqueued: { queue: string; jobId: string; payload: unknown }[] = [];
  const queue: QueueProducer = {
    add: async <N extends keyof JobPayloads>(q: N, jobId: string, payload: JobPayloads[N]) => void enqueued.push({ queue: q, jobId, payload }),
    close: async () => {},
  };
  const ctx: JobContext = {
    db,
    redis,
    keys,
    log: pino({ level: 'silent' }),
    storage: createStorage(storageConfigFromEnv(env)),
    mediaBucket: env.S3_BUCKET_MEDIA,
    scansBucket: env.S3_BUCKET_SCANS,
    responseCache: createResponseCache(redis, keys, { maxTtlMs: 60_000 }),
    queue,
    scanProvider: opts.scanProvider ?? mockProvider(),
    // Billing tests drive webhooks themselves, so the mock sends none.
    payments: opts.payments === undefined ? new MockPaymentProvider({ redis, keys, hostedUrl: (r) => `http://mock.test/${r}`, webhook: null }) : opts.payments,
  };
  return {
    ctx,
    enqueued,
    prefix,
    async close() {
      let cursor = '0';
      do {
        const [n, found] = await redis.scan(cursor, 'MATCH', `${prefix}:*`, 'COUNT', 500);
        cursor = n;
        if (found.length) await redis.unlink(...found);
      } while (cursor !== '0');
      await redis.quit();
      await close();
    },
  };
}

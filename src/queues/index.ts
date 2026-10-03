import { Queue, type QueueOptions } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../env.js';
import { createKeyspace } from '../shared/redis/index.js';

// Queue names and payloads are the shared contract (src/shared/queue), vendored from equato-api.
export { QueueName } from '../shared/queue/index.js';
import { jobOptionsFor, QueueName } from '../shared/queue/index.js';

export const connection = new IORedis(env.REDIS_URL, {
  connectionName: env.SERVICE_NAME,
  // BullMQ blocks on Redis; retrying forever is correct for a worker, and
  // required — BullMQ refuses to start otherwise.
  maxRetriesPerRequest: null,
});

/**
 * Every queue key lives under `<prefix>:queue:` (SECURITY.md §20), never
 * BullMQ's default `bull:` — so queue data cannot collide with, or be swept
 * by, cache/auth/rate keys on the shared Redis.
 */
export const keys = createKeyspace(env.REDIS_KEY_PREFIX);

// Retention (how many finished jobs Redis keeps) is part of the shared
// contract, so the producers and the scheduler cannot disagree on it.
const defaults: QueueOptions = { connection, prefix: keys.queuePrefix };

const registry = new Map<QueueName, Queue>();

export function getQueue(name: QueueName): Queue {
  let queue = registry.get(name);
  if (!queue) {
    queue = new Queue(name, { ...defaults, defaultJobOptions: jobOptionsFor(name) });
    registry.set(name, queue);
  }
  return queue;
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...registry.values()].map((q) => q.close()));
  await connection.quit();
}

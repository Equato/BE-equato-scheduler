import { Worker, type Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { QueueName, type JobPayloads } from './shared/queue/index.js';
import type { JobContext, JobMeta, JobOutcome } from './jobs/context.js';
import { mediaVariants } from './jobs/media-variants.js';
import { maintenance } from './jobs/maintenance.js';
import { analyticsEvents, analyticsRollup } from './jobs/analytics.js';
import { processWebhook } from './jobs/webhooks.js';
import { menuScan } from './jobs/menu-scan.js';
import { processOutboxEvent } from './jobs/notify.js';

/**
 * One BullMQ Worker per queue with a handler. Workers on any number of
 * scheduler replicas consume the same queues; BullMQ hands each job to one
 * worker at a time (with a lock it renews), and a job whose worker dies is
 * retried after the lock expires. Every handler is idempotent because
 * delivery is at-least-once.
 */
type Handler<N extends keyof JobPayloads> = (ctx: JobContext, payload: JobPayloads[N], meta: JobMeta) => Promise<JobOutcome>;

export const HANDLERS: { [N in keyof JobPayloads]?: Handler<N> } = {
  [QueueName.MEDIA_VARIANTS]: mediaVariants,
  [QueueName.MAINTENANCE]: maintenance as Handler<'maintenance'>,
  [QueueName.ANALYTICS_EVENTS]: analyticsEvents,
  [QueueName.ANALYTICS_ROLLUP]: analyticsRollup,
  [QueueName.WEBHOOKS]: processWebhook,
  [QueueName.MENU_SCAN]: menuScan,
  [QueueName.NOTIFICATIONS]: processOutboxEvent,
};

export function startWorkers(ctx: JobContext, opts: { connection: Redis; prefix: string; concurrency: number; only?: (keyof JobPayloads)[] }) {
  const workers: Worker[] = [];
  for (const [name, handler] of Object.entries(HANDLERS) as [keyof JobPayloads, Handler<keyof JobPayloads>][]) {
    if (opts.only && !opts.only.includes(name)) continue;
    const worker = new Worker(
      name,
      async (job: Job) => {
        const started = Date.now();
        const outcome = await handler(ctx, job.data as never, { attempt: job.attemptsMade + 1, maxAttempts: job.opts.attempts ?? 1 });
        ctx.log.info({ queue: name, jobId: job.id, attempt: job.attemptsMade + 1, ms: Date.now() - started, ...outcome }, 'job finished');
        return outcome;
      },
      { connection: opts.connection, prefix: opts.prefix, concurrency: opts.concurrency },
    );
    worker.on('failed', (job, error) =>
      ctx.log.warn({ queue: name, jobId: job?.id, attempt: job?.attemptsMade, final: job ? job.attemptsMade >= (job.opts.attempts ?? 1) : undefined, error: error.message }, 'job failed'),
    );
    worker.on('error', (error) => ctx.log.error({ queue: name, error: error.message }, 'worker error'));
    workers.push(worker);
  }
  return { workers, close: () => Promise.all(workers.map((w) => w.close())) };
}

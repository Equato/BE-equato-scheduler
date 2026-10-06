import type { Queue } from 'bullmq';
import type { JobPayloads } from './shared/queue/index.js';

/**
 * Recurring work. Registered with BullMQ job schedulers by EVERY replica at
 * boot — `upsertJobScheduler` is idempotent by id, so N replicas still produce
 * one job per tick, and changing a pattern here changes it everywhere on the
 * next deploy. Times are UTC (IST = UTC+5:30).
 */
export interface Schedule<N extends keyof JobPayloads = keyof JobPayloads> {
  id: string;
  queue: N;
  pattern?: string;
  everyMs?: number;
  payload: JobPayloads[N];
}

export const SCHEDULES: Schedule[] = [
  { id: 'analytics-rollup', queue: 'analytics-rollup', everyMs: 10 * 60_000, payload: {} },
  { id: 'partitions', queue: 'maintenance', pattern: '15 20 * * *', payload: { task: 'partitions' } }, // 01:45 IST
  { id: 'webhook-requeue', queue: 'maintenance', everyMs: 2 * 60_000, payload: { task: 'webhook-requeue' } },
  { id: 'sweep-uploads', queue: 'maintenance', pattern: '0 * * * *', payload: { task: 'sweep-uploads' } },
  { id: 'expire-sessions', queue: 'maintenance', pattern: '30 21 * * *', payload: { task: 'expire-sessions' } }, // 03:00 IST
  { id: 'outbox-dispatch', queue: 'maintenance', everyMs: 60_000, payload: { task: 'outbox-dispatch' } },
  { id: 'stale-scans', queue: 'maintenance', everyMs: 15 * 60_000, payload: { task: 'stale-scans' } },
  { id: 'media-requeue', queue: 'maintenance', everyMs: 15 * 60_000, payload: { task: 'media-requeue' } },
  { id: 'analytics-retention', queue: 'maintenance', pattern: '45 20 * * *', payload: { task: 'analytics-retention' } }, // 02:15 IST, after partitions
  { id: 'job-runs-retention', queue: 'maintenance', pattern: '0 22 * * 0', payload: { task: 'job-runs-retention' } },
  // Subscription billing (SUBSCRIPTIONS.md §9).
  { id: 'billing-cycle', queue: 'billing', everyMs: 5 * 60_000, payload: { task: 'cycle' } },
  { id: 'billing-reconcile', queue: 'billing', everyMs: 5 * 60_000, payload: { task: 'reconcile' } },
  { id: 'billing-reminders', queue: 'billing', pattern: '30 3 * * *', payload: { task: 'reminders' } }, // 09:00 IST
];

export async function registerSchedules(queueFor: (name: keyof JobPayloads) => Queue, schedules: Schedule[] = SCHEDULES) {
  for (const s of schedules) {
    await queueFor(s.queue).upsertJobScheduler(s.id, s.pattern ? { pattern: s.pattern } : { every: s.everyMs! }, { name: s.id, data: s.payload });
  }
  return schedules.map((s) => s.id);
}

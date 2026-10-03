import { eq } from 'drizzle-orm';
import { jobRuns } from '../db/schema/index.js';
import { acquireLock } from '../shared/redis/index.js';
import type { JobContext, JobOutcome } from './context.js';

/**
 * Observability + overlap protection for SCHEDULED work.
 *
 * Each run writes a `job_runs` row (RUNNING → SUCCEEDED/FAILED, duration,
 * outcome) so "did last night's rollup run, and how long did it take?" is a
 * SQL query, not a log search. A Redis lock (TTL = the task's maximum
 * runtime) means a slow run is never overlapped by the next tick on another
 * replica; the lock expires on its own if the worker dies.
 *
 * High-volume queue jobs (media, events) are not recorded here — their
 * outcome is logged per job and their queue depth is on /health.
 */
export async function trackedRun(ctx: JobContext, name: string, maxRuntimeMs: number, work: () => Promise<JobOutcome>): Promise<JobOutcome> {
  const lock = await acquireLock(ctx.redis, ctx.keys, `job.${name}`, maxRuntimeMs);
  if (!lock) return { status: 'skipped', detail: 'another run is in progress' };
  const started = Date.now();
  const [run] = await ctx.db.insert(jobRuns).values({ jobName: name }).returning({ id: jobRuns.id });
  try {
    const outcome = await work();
    await ctx.db.update(jobRuns).set({ status: 'SUCCEEDED', finishedAt: new Date(), metadata: { ...outcome, ms: Date.now() - started } }).where(eq(jobRuns.id, run!.id));
    return outcome;
  } catch (error) {
    const message = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    await ctx.db.update(jobRuns).set({ status: 'FAILED', finishedAt: new Date(), error: message, metadata: { ms: Date.now() - started } }).where(eq(jobRuns.id, run!.id)).catch(() => {});
    throw error;
  } finally {
    await lock.release();
  }
}

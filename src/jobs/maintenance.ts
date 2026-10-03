import { and, eq, gt, inArray, lt, or, sql } from 'drizzle-orm';
import { authAttempts, jobRuns, media, refreshTokens, userSessions } from '../db/schema/index.js';
import type { JobContext, JobOutcome } from './context.js';
import { trackedRun } from './runs.js';
import { requeueWebhooks } from './webhooks.js';

/**
 * Maintenance tasks. Scheduled ones (partitions, sweeps, retention) run
 * through trackedRun (job_runs row + overlap lock); `delete-objects` is
 * queued by the API when media is deleted.
 *
 * Every task is idempotent: it deletes or creates things that are already
 * deleted or created as a no-op, so a retry or a duplicate tick is harmless.
 */

const MEDIA_KEY = /^(incoming|originals|public|scans)\//;
export const RETENTION = {
  pendingUploadMs: 24 * 3_600_000,
  rejectedUploadMs: 7 * 24 * 3_600_000,
  endedSessionDays: 30,
  authAttemptDays: 30,
  jobRunDays: 90,
  /** Raw analytics events: whole months, so between 3 and 4 months are kept. The rollups are kept forever. */
  analyticsMonths: 3,
} as const;

/** Encoding takes seconds; PROCESSING for this long means the job was lost. */
export const MEDIA_REQUEUE = { stuckAfterMs: 10 * 60_000, giveUpAfterMs: 24 * 3_600_000 } as const;

async function deleteObjects(ctx: JobContext, payload: { bucket?: string; keys?: string[] }): Promise<JobOutcome> {
  const bucket = payload.bucket === ctx.scansBucket ? ctx.scansBucket : ctx.mediaBucket; // never an arbitrary bucket
  const keys = (payload.keys ?? []).filter((k) => MEDIA_KEY.test(k) && !k.includes('..'));
  for (const key of keys) await ctx.storage.delete(bucket, key);
  return { status: 'done', deleted: keys.length };
}

/** Keep the next three months of every monthly-partitioned table created ahead of time. */
async function partitions(ctx: JobContext): Promise<JobOutcome> {
  const created: Record<string, number> = {};
  for (const t of ['price_history', 'analytics_events', 'audit_logs', 'security_events']) {
    const [r] = (await ctx.db.execute(sql`SELECT ensure_monthly_partitions(${t}, current_date, (current_date + interval '3 months')::date) AS n`)) as unknown as { n: number }[];
    created[t] = Number(r?.n ?? 0);
  }
  return { status: 'done', created };
}

/**
 * Uploads that were started but never confirmed (browser closed, attacker
 * probing) and rejected ones past their grace period: storage objects first,
 * then the rows. Bounded batches so one run never holds a long transaction.
 */
async function sweepUploads(ctx: JobContext): Promise<JobOutcome> {
  let removed = 0;
  for (let batch = 0; batch < 20; batch++) {
    const stale = await ctx.db
      .select({ id: media.id, kind: media.kind, storageKey: media.storageKey, variants: media.variants })
      .from(media)
      .where(
        or(
          and(eq(media.status, 'PENDING'), lt(media.createdAt, new Date(Date.now() - RETENTION.pendingUploadMs))),
          and(eq(media.status, 'REJECTED'), lt(media.updatedAt, new Date(Date.now() - RETENTION.rejectedUploadMs))),
        ),
      )
      .limit(200);
    if (!stale.length) break;
    for (const m of stale) {
      for (const key of [m.storageKey, ...Object.values(m.variants ?? {}).map((v) => v.key)]) {
        if (MEDIA_KEY.test(key)) await ctx.storage.delete(m.kind === 'SCAN_UPLOAD' ? ctx.scansBucket : ctx.mediaBucket, key).catch(() => {});
      }
    }
    await ctx.db.delete(media).where(inArray(media.id, stale.map((m) => m.id)));
    removed += stale.length;
  }
  return { status: 'done', removed };
}

/** Ended sessions and login attempts are kept 30 days for investigations, then deleted. */
async function expireSessions(ctx: JobContext): Promise<JobOutcome> {
  const cutoff = new Date(Date.now() - RETENTION.endedSessionDays * 86_400_000);
  const tokens = await ctx.db.delete(refreshTokens).where(lt(refreshTokens.expiresAt, cutoff)).returning({ id: refreshTokens.id });
  const sessions = await ctx.db
    .delete(userSessions)
    .where(or(lt(userSessions.expiresAt, cutoff), lt(userSessions.revokedAt, cutoff)))
    .returning({ id: userSessions.id });
  const attempts = await ctx.db.delete(authAttempts).where(lt(authAttempts.attemptedAt, new Date(Date.now() - RETENTION.authAttemptDays * 86_400_000))).returning({ id: authAttempts.id });
  return { status: 'done', refreshTokens: tokens.length, sessions: sessions.length, authAttempts: attempts.length };
}

async function jobRunRetention(ctx: JobContext): Promise<JobOutcome> {
  const gone = await ctx.db.delete(jobRuns).where(lt(jobRuns.startedAt, new Date(Date.now() - RETENTION.jobRunDays * 86_400_000))).returning({ id: jobRuns.id });
  return { status: 'done', deleted: gone.length };
}

import { failStaleScans } from './menu-scan.js';
import { dispatchOutbox } from './notify.js';

/** Drops raw-event partitions past retention (a whitelisted SECURITY DEFINER function; the app role can't DROP). */
async function analyticsRetention(ctx: JobContext): Promise<JobOutcome> {
  const [r] = (await ctx.db.execute(sql`SELECT drop_expired_analytics_partitions(${RETENTION.analyticsMonths}) AS n`)) as unknown as { n: number }[];
  return { status: 'done', droppedPartitions: Number(r?.n ?? 0) };
}

/**
 * A photo whose variants job was never queued (Redis down when the upload was
 * confirmed) or ran out of attempts (storage down) would stay PROCESSING —
 * invisible to shoppers — forever. Re-queue it under a fresh job id (a failed
 * job keeps the old one); the job is idempotent. After a day it is left for an
 * operator: a photo that fails that long is not going to succeed on its own.
 */
async function requeueMedia(ctx: JobContext): Promise<JobOutcome> {
  const now = Date.now();
  const stuck = await ctx.db
    .select({ id: media.id })
    .from(media)
    .where(and(eq(media.status, 'PROCESSING'), lt(media.updatedAt, new Date(now - MEDIA_REQUEUE.stuckAfterMs)), gt(media.updatedAt, new Date(now - MEDIA_REQUEUE.giveUpAfterMs))))
    .limit(200);
  for (const m of stuck) await ctx.queue.add('media-variants', `media:${m.id}:retry:${now}`, { mediaId: m.id });
  return { status: 'done', requeued: stuck.length };
}

const SCHEDULED: Record<string, { run: (ctx: JobContext) => Promise<JobOutcome>; maxRuntimeMs: number }> = {
  partitions: { run: partitions, maxRuntimeMs: 5 * 60_000 },
  'sweep-uploads': { run: sweepUploads, maxRuntimeMs: 15 * 60_000 },
  'expire-sessions': { run: expireSessions, maxRuntimeMs: 10 * 60_000 },
  'job-runs-retention': { run: jobRunRetention, maxRuntimeMs: 5 * 60_000 },
  'analytics-retention': { run: analyticsRetention, maxRuntimeMs: 5 * 60_000 },
  'stale-scans': { run: failStaleScans, maxRuntimeMs: 5 * 60_000 },
  'outbox-dispatch': { run: dispatchOutbox, maxRuntimeMs: 60_000 },
  'media-requeue': { run: requeueMedia, maxRuntimeMs: 60_000 },
};

export async function maintenance(ctx: JobContext, payload: { task: string; bucket?: string; keys?: string[] }): Promise<JobOutcome> {
  if (payload.task === 'delete-objects') return deleteObjects(ctx, payload);
  if (payload.task === 'webhook-requeue') return requeueWebhooks(ctx);
  const task = SCHEDULED[payload.task];
  if (!task) return { status: 'skipped', detail: `unknown task ${payload.task}` };
  return trackedRun(ctx, payload.task, task.maxRuntimeMs, () => task.run(ctx));
}

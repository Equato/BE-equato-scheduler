import { and, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { businessOwners, ownerSettings, users, userSettings, webhookEvents } from '../db/schema/index.js';
import { validateEvent } from '../shared/webhooks/index.js';
import type { JobContext, JobOutcome } from './context.js';
import { trackedRun } from './runs.js';

/**
 * webhooks: act on a persisted, signature-verified event.
 *
 *   - claimed with a conditional UPDATE (RECEIVED/FAILED → PROCESSING), so two
 *     workers can't act on one event; a PROCESSED/SKIPPED event is a no-op;
 *   - `data` is validated AGAIN against the shared contract — the row is the
 *     input here, and a row could predate a schema change;
 *   - every action is idempotent (setting a flag to false twice is one false);
 *   - a failure records last_error and rethrows, so BullMQ retries with
 *     backoff; after the final attempt the row stays FAILED (visible in the
 *     admin console) and the sweep stops retrying it.
 */

export const MAX_WEBHOOK_ATTEMPTS = 8;

type Handler = (ctx: JobContext, data: Record<string, unknown>) => Promise<Record<string, unknown>>;

/** Hard bounces and complaints stop email to that address everywhere; soft bounces are only recorded. */
async function stopEmailTo(ctx: JobContext, email: string) {
  const people = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}::text) = ${email}`);
  if (people.length) {
    await ctx.db
      .insert(userSettings)
      .values(people.map((p) => ({ userId: p.id, emailEnabled: false })))
      .onConflictDoUpdate({ target: userSettings.userId, set: { emailEnabled: false, updatedAt: new Date() } });
  }
  const owners = await ctx.db.select({ id: businessOwners.id }).from(businessOwners).where(sql`lower(${businessOwners.contactEmail}::text) = ${email}`);
  if (owners.length) {
    await ctx.db
      .insert(ownerSettings)
      .values(owners.map((o) => ({ ownerId: o.id, emailApprovals: false, weeklyReport: false, competitorPriceAlerts: false })))
      .onConflictDoUpdate({ target: ownerSettings.ownerId, set: { emailApprovals: false, weeklyReport: false, competitorPriceAlerts: false, updatedAt: new Date() } });
  }
  return { users: people.length, owners: owners.length };
}

export const WEBHOOK_HANDLERS: Record<string, Record<string, Handler>> = {
  email: {
    'email.delivered': async () => ({ action: 'none' }),
    'email.bounced': async (ctx, d) => (d.bounceType === 'hard' ? { action: 'email-disabled', ...(await stopEmailTo(ctx, String(d.email))) } : { action: 'none (soft bounce)' }),
    'email.complained': async (ctx, d) => ({ action: 'email-disabled', ...(await stopEmailTo(ctx, String(d.email))) }),
  },
  default: {
    'test.ping': async () => ({ action: 'none' }),
  },
};

/** Handlers registered from other modules (menu scans, Phase 15). */
export function registerWebhookHandler(provider: string, type: string, handler: Handler) {
  (WEBHOOK_HANDLERS[provider] ??= {})[type] = handler;
}

export async function processWebhook(ctx: JobContext, payload: { webhookEventId: string }): Promise<JobOutcome> {
  const [claimed] = await ctx.db
    .update(webhookEvents)
    .set({ status: 'PROCESSING', attempts: sql`${webhookEvents.attempts} + 1` })
    .where(and(eq(webhookEvents.id, payload.webhookEventId), inArray(webhookEvents.status, ['RECEIVED', 'FAILED']), lt(webhookEvents.attempts, MAX_WEBHOOK_ATTEMPTS)))
    .returning();
  if (!claimed) return { status: 'skipped', detail: 'already processed, in progress, or out of attempts' };

  const finish = (status: 'PROCESSED' | 'SKIPPED' | 'FAILED', lastError: string | null = null) =>
    ctx.db.update(webhookEvents).set({ status, lastError, ...(status === 'FAILED' ? {} : { processedAt: new Date() }) }).where(eq(webhookEvents.id, claimed.id));

  const envelope = claimed.payload as { type?: string; data?: unknown };
  const handler = WEBHOOK_HANDLERS[claimed.provider]?.[claimed.eventType];
  const checked = validateEvent(claimed.provider, claimed.eventType, envelope.data ?? {});
  if (!handler || !checked.ok || !checked.known) {
    await finish('SKIPPED', !checked.ok ? `invalid data: ${checked.issues.join('; ')}`.slice(0, 500) : 'no handler');
    return { status: 'skipped', detail: 'no handler or invalid data' };
  }
  try {
    const result = await handler(ctx, checked.data);
    await finish('PROCESSED');
    return { status: 'done', provider: claimed.provider, type: claimed.eventType, ...result };
  } catch (error) {
    await finish('FAILED', (error instanceof Error ? error.message : String(error)).slice(0, 500));
    throw error;
  }
}

/**
 * Outbox sweep: events that were persisted but never queued (Redis was down
 * at ingest), or that FAILED with attempts left, are enqueued again. Job ids
 * are the event ids, so a still-queued event isn't doubled.
 */
export async function requeueWebhooks(ctx: JobContext): Promise<JobOutcome> {
  return trackedRun(ctx, 'webhook-requeue', 5 * 60_000, async () => {
    const stale = await ctx.db
      .select({ id: webhookEvents.id, status: webhookEvents.status })
      .from(webhookEvents)
      .where(
        and(
          lt(webhookEvents.attempts, MAX_WEBHOOK_ATTEMPTS),
          or(
            and(eq(webhookEvents.status, 'RECEIVED'), lt(webhookEvents.receivedAt, new Date(Date.now() - 2 * 60_000))),
            eq(webhookEvents.status, 'FAILED'),
            // A worker died mid-event: PROCESSING for far longer than any handler runs.
            and(eq(webhookEvents.status, 'PROCESSING'), lt(webhookEvents.receivedAt, new Date(Date.now() - 30 * 60_000))),
          ),
        ),
      )
      .limit(500);
    for (const e of stale) {
      if (e.status === 'PROCESSING') await ctx.db.update(webhookEvents).set({ status: 'FAILED', lastError: 'worker lost while processing' }).where(and(eq(webhookEvents.id, e.id), eq(webhookEvents.status, 'PROCESSING')));
      // A retry of a FAILED event needs a fresh job id (the failed job keeps the old one).
      await ctx.queue.add('webhooks', e.status === 'RECEIVED' ? `webhook:${e.id}` : `webhook:${e.id}:retry:${Date.now()}`, { webhookEventId: e.id });
    }
    return { status: 'done', requeued: stale.length };
  });
}

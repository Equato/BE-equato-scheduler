import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { Queue, QueueEvents } from 'bullmq';
import { eq, inArray, sql } from 'drizzle-orm';
import IORedis from 'ioredis';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businesses, jobRuns, media } from '../db/schema/index.js';
import { createQueueProducer, DEFAULT_JOB_OPTIONS, jobOptionsFor, QueueName } from '../shared/queue/index.js';
import { env } from '../env.js';
import { registerSchedules, SCHEDULES } from '../schedules.js';
import { testContext } from '../test/context.js';
import { startWorkers } from '../workers.js';
import { analyticsEvents, analyticsRollup } from './analytics.js';
import { MEDIA_REQUEUE, maintenance } from './maintenance.js';

/**
 * Multiple workers, one truth: duplicate deliveries, concurrent consumers and
 * overlapping ticks must never double-apply work.
 */

let t: Awaited<ReturnType<typeof testContext>>;
let businessId: string;
const conns: IORedis[] = [];
const conn = () => {
  const c = new IORedis(env.REDIS_URL, { maxRetriesPerRequest: null });
  conns.push(c);
  return c;
};
const madeMedia: string[] = [];

beforeAll(async () => {
  t = await testContext();
  [{ id: businessId }] = (await t.ctx.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.publicationStatus, 'APPROVED')).limit(1)) as [{ id: string }];
});
afterAll(async () => {
  if (madeMedia.length) await t.ctx.db.delete(media).where(inArray(media.id, madeMedia));
  await t.ctx.db.execute(sql`DELETE FROM analytics_events WHERE properties->>'test' = ${t.prefix}`);
  for (const c of conns) c.disconnect();
  await t?.close();
});

const prefix = () => t.ctx.keys.queuePrefix;

async function drain(queueName: string) {
  const q = new Queue(queueName, { connection: conn(), prefix: prefix() });
  for (let i = 0; i < 100; i++) {
    const c = await q.getJobCounts('waiting', 'active', 'delayed');
    if ((c.waiting ?? 0) + (c.active ?? 0) + (c.delayed ?? 0) === 0) break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const counts = await q.getJobCounts('completed', 'failed');
  await q.close();
  return counts;
}

describe('concurrent workers', () => {
  it('two worker replicas on the same queue: a batch delivered 4× is stored once', async () => {
    const a = startWorkers(t.ctx, { connection: conn(), prefix: prefix(), concurrency: 4, only: ['analytics-events'] });
    const b = startWorkers(t.ctx, { connection: conn(), prefix: prefix(), concurrency: 4, only: ['analytics-events'] });
    const producer = createQueueProducer(conn(), prefix());
    const events = Array.from({ length: 30 }, () => ({ id: randomUUID(), type: 'BUSINESS_VIEW', businessId, at: new Date().toISOString(), properties: { test: t.prefix } }));
    // Four deliveries of the same events under different job ids (a retried producer, a duplicated webhook…).
    await Promise.all([1, 2, 3, 4].map((n) => producer.add('analytics-events', `events-${t.prefix}-${n}`, { events })));
    const counts = await drain('analytics-events');
    expect(counts.failed).toBe(0);
    const [{ n }] = (await t.ctx.db.execute(sql`SELECT count(*)::int AS n FROM analytics_events WHERE properties->>'test' = ${t.prefix}`)) as unknown as [{ n: number }];
    expect(n).toBe(30);
    await producer.close();
    await a.close();
    await b.close();
  });

  it('the same job id enqueued twice is one job (producer-side dedupe)', async () => {
    const producer = createQueueProducer(conn(), prefix());
    await producer.add('maintenance', `once-${t.prefix}`, { task: 'noop' });
    await producer.add('maintenance', `once-${t.prefix}`, { task: 'noop' });
    const q = new Queue('maintenance', { connection: conn(), prefix: prefix() });
    expect((await q.getJobs(['waiting', 'delayed'])).filter((j) => j.id === `once-${t.prefix}`)).toHaveLength(1);
    await q.obliterate({ force: true });
    await q.close();
    await producer.close();
  });

  it('two workers racing on one image: processed once, READY, consistent variants', async () => {
    const original = await sharp({ create: { width: 900, height: 600, channels: 3, background: '#123456' } }).jpeg().toBuffer();
    const [m] = await t.ctx.db.insert(media).values({ kind: 'BUSINESS_PHOTO', storageKey: `originals/race-${randomUUID()}.jpg`, mimeType: 'image/jpeg', byteSize: original.length, businessId, status: 'PROCESSING', width: 900, height: 600 }).returning();
    madeMedia.push(m!.id);
    await t.ctx.storage.put(t.ctx.mediaBucket, m!.storageKey, original, { contentType: 'image/jpeg' });
    const a = startWorkers(t.ctx, { connection: conn(), prefix: prefix(), concurrency: 2, only: ['media-variants'] });
    const b = startWorkers(t.ctx, { connection: conn(), prefix: prefix(), concurrency: 2, only: ['media-variants'] });
    const producer = createQueueProducer(conn(), prefix());
    await Promise.all(['x', 'y', 'z'].map((s) => producer.add('media-variants', `media-${m!.id}-${s}`, { mediaId: m!.id })));
    await drain('media-variants');
    const [row] = await t.ctx.db.select().from(media).where(eq(media.id, m!.id));
    expect(row!.status).toBe('READY');
    expect(Object.keys(row!.variants)).toHaveLength(12);
    await producer.close();
    await a.close();
    await b.close();
  }, 60_000);

  it('a failing job is retried with backoff (at-least-once), then succeeds', async () => {
    const q = new Queue('analytics-rollup-retry-test', { connection: conn(), prefix: prefix(), defaultJobOptions: { ...DEFAULT_JOB_OPTIONS, backoff: { type: 'fixed', delay: 50 } } });
    const { Worker } = await import('bullmq');
    let attempts = 0;
    const w = new Worker(
      'analytics-rollup-retry-test',
      async () => {
        attempts++;
        if (attempts < 3) throw new Error('transient');
        return 'ok';
      },
      { connection: conn(), prefix: prefix() },
    );
    const events = new QueueEvents('analytics-rollup-retry-test', { connection: conn(), prefix: prefix() });
    await events.waitUntilReady();
    const job = await q.add('x', {});
    await job.waitUntilFinished(events, 10_000);
    expect(attempts).toBe(3);
    await w.close();
    await events.close();
    await q.obliterate({ force: true });
    await q.close();
  });

  it('finished jobs cannot grow Redis: a stored analytics batch leaves nothing behind, failures keep a capped tail', async () => {
    // Redis runs noeviction. 1,000 retained ≈200 KB batches held ≈200 MB, and
    // during a database outage every job fails — an age-only limit kept them all for a week.
    for (const name of Object.values(QueueName)) expect(jobOptionsFor(name).removeOnFail).toMatchObject({ count: expect.any(Number) });
    const producer = createQueueProducer(conn(), prefix());
    const { Worker } = await import('bullmq');
    const w = new Worker('analytics-events', async () => 'stored', { connection: conn(), prefix: prefix() });
    const events = new QueueEvents('analytics-events', { connection: conn(), prefix: prefix() });
    await events.waitUntilReady();
    const q = new Queue('analytics-events', { connection: conn(), prefix: prefix() });
    const done = new Promise((resolve) => events.once('completed', resolve));
    await producer.add('analytics-events', `ae:${randomUUID()}`, { events: [] });
    await done;
    expect(await q.getJobCounts('completed', 'failed', 'wait', 'active')).toEqual({ completed: 0, failed: 0, wait: 0, active: 0 });
    await w.close();
    await events.close();
    await producer.close();
    await q.obliterate({ force: true });
    await q.close();
  });
});

describe('scheduled work', () => {
  it('registering schedules from several replicas leaves one scheduler per job', async () => {
    const queues = new Map<string, Queue>();
    const queueFor = (name: string) => queues.get(name) ?? (queues.set(name, new Queue(name, { connection: conn(), prefix: prefix() })), queues.get(name)!);
    await Promise.all([registerSchedules(queueFor as never), registerSchedules(queueFor as never), registerSchedules(queueFor as never)]);
    let total = 0;
    for (const q of queues.values()) total += (await q.getJobSchedulers()).length;
    expect(total).toBe(SCHEDULES.length);
    for (const q of queues.values()) {
      await q.obliterate({ force: true });
      await q.close();
    }
  });

  it('overlapping ticks of the same task: one runs, the other is skipped; job_runs records it', async () => {
    const [x, y] = await Promise.all([analyticsRollup(t.ctx, {}), analyticsRollup(t.ctx, {})]);
    expect([x.status, y.status].sort()).toEqual(['done', 'skipped']);
    const [run] = await t.ctx.db.select().from(jobRuns).where(eq(jobRuns.jobName, 'analytics-rollup')).orderBy(sql`created_at desc`).limit(1);
    expect(run!.status).toBe('SUCCEEDED');
  });

  it('the rollup recomputes a day from events — running it again changes nothing', async () => {
    const today = new Date().toISOString().slice(0, 10);
    await analyticsRollup(t.ctx, { date: today });
    const read = async () => (await t.ctx.db.execute(sql`SELECT views FROM business_daily_metrics WHERE business_id = ${businessId}::uuid AND date = ${today}::date`)) as unknown as { views: number }[];
    const first = await read();
    await analyticsRollup(t.ctx, { date: today });
    expect(await read()).toEqual(first);
    // The 30 test BUSINESS_VIEW events from the first test are counted.
    expect(first[0]!.views).toBeGreaterThanOrEqual(30);
  });

  it('folded impressions count their n (the API batches one row per business per window)', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const read = async () => ((await t.ctx.db.execute(sql`SELECT impressions FROM business_daily_metrics WHERE business_id = ${businessId}::uuid AND date = ${today}::date`)) as unknown as { impressions: number }[])[0]?.impressions ?? 0;
    await analyticsRollup(t.ctx, { date: today });
    const before = await read();
    const at = new Date().toISOString();
    await analyticsEvents(t.ctx, { events: [
      { id: randomUUID(), type: 'IMPRESSION', businessId, sessionHash: 'x', properties: { n: 7 }, at },
      { id: randomUUID(), type: 'IMPRESSION', businessId, sessionHash: 'y', at }, // no n: counts once
    ] });
    await analyticsRollup(t.ctx, { date: today });
    expect(await read()).toBe(before + 8);
  });

  it('search terms roll up per day: counted, distinct visitors, recompute is idempotent', async () => {
    const today = new Date().toISOString().slice(0, 10);
    const term = `rollup-test-${randomUUID().slice(0, 8)}`;
    const at = new Date().toISOString();
    const ev = (hash: string) => ({ id: randomUUID(), type: 'SEARCH', sessionHash: hash, properties: { query: term, results: 3 }, at });
    await analyticsEvents(t.ctx, { events: [ev('a'), ev('a'), ev('b')] });
    await analyticsRollup(t.ctx, { date: today });
    const read = async () => (await t.ctx.db.execute(sql`SELECT searches, visitors FROM search_term_daily WHERE date = ${today}::date AND query = ${term}`)) as unknown as { searches: number; visitors: number }[];
    expect(await read()).toEqual([{ searches: 3, visitors: 2 }]);
    await analyticsRollup(t.ctx, { date: today });
    expect(await read()).toEqual([{ searches: 3, visitors: 2 }]);
    // Two replicas whose Redis locks don't see each other: the database serialises them.
    const other = await testContext();
    try {
      const results = await Promise.all([analyticsRollup(t.ctx, { date: today }), analyticsRollup(other.ctx, { date: today })]);
      expect(results.map((r) => r.status)).toEqual(['done', 'done']);
      expect(await read()).toEqual([{ searches: 3, visitors: 2 }]);
    } finally {
      await other.close();
    }
  });

  it('analytics retention drops whole expired months and keeps recent ones', async () => {
    const exists = async (name: string) => ((await t.ctx.db.execute(sql`SELECT to_regclass(${name}) IS NOT NULL AS e`)) as unknown as { e: boolean }[])[0]!.e;
    // An old month (created the same way the partitions task does).
    await t.ctx.db.execute(sql`SELECT ensure_monthly_partitions('analytics_events', DATE '2025-01-01', DATE '2025-01-01')`);
    expect(await exists('analytics_events_2025_01')).toBe(true);
    const current = `analytics_events_${new Date().toISOString().slice(0, 7).replace('-', '_')}`;
    expect(await maintenance(t.ctx, { task: 'analytics-retention' })).toMatchObject({ status: 'done' });
    expect(await exists('analytics_events_2025_01')).toBe(false);
    expect(await exists(current)).toBe(true);
    expect(await exists('analytics_events_default')).toBe(true);
  });

  it('sweep-uploads deletes abandoned uploads and keeps fresh ones', async () => {
    const [old] = await t.ctx.db.insert(media).values({ kind: 'BUSINESS_PHOTO', storageKey: `incoming/${randomUUID()}`, mimeType: 'image/png', byteSize: 10, businessId, status: 'PENDING', createdAt: new Date(Date.now() - 2 * 86_400_000) }).returning();
    const [fresh] = await t.ctx.db.insert(media).values({ kind: 'BUSINESS_PHOTO', storageKey: `incoming/${randomUUID()}`, mimeType: 'image/png', byteSize: 10, businessId, status: 'PENDING' }).returning();
    madeMedia.push(fresh!.id);
    const out = await maintenance(t.ctx, { task: 'sweep-uploads' });
    expect(out.status).toBe('done');
    expect(await t.ctx.db.select({ id: media.id }).from(media).where(eq(media.id, old!.id))).toEqual([]);
    expect(await t.ctx.db.select({ id: media.id }).from(media).where(eq(media.id, fresh!.id))).toHaveLength(1);
  });

  it('media-requeue re-queues a photo whose variants job was lost — not a fresh one, not one given up on', async () => {
    const row = (ageMs: number) => ({ kind: 'BUSINESS_PHOTO' as const, storageKey: `originals/${randomUUID()}`, mimeType: 'image/png', byteSize: 10, businessId, status: 'PROCESSING' as const, updatedAt: new Date(Date.now() - ageMs) });
    const [stuck, fresh, dead] = await t.ctx.db
      .insert(media)
      .values([row(MEDIA_REQUEUE.stuckAfterMs + 60_000), row(0), row(MEDIA_REQUEUE.giveUpAfterMs + 60_000)])
      .returning({ id: media.id });
    madeMedia.push(stuck!.id, fresh!.id, dead!.id);
    t.enqueued.length = 0;
    expect(await maintenance(t.ctx, { task: 'media-requeue' })).toMatchObject({ status: 'done' });
    const jobs = t.enqueued.filter((j) => j.queue === 'media-variants') as { jobId: string; payload: { mediaId: string } }[];
    const ids = jobs.map((j) => j.payload.mediaId);
    expect(ids).toContain(stuck!.id);
    expect(ids).not.toContain(fresh!.id);
    expect(ids).not.toContain(dead!.id);
    // A fresh job id: a job that failed for good keeps the original one, and BullMQ would ignore a re-add.
    expect(jobs.find((j) => j.payload.mediaId === stuck!.id)!.jobId).toMatch(new RegExp(`^media:${stuck!.id}:retry:\\d+$`));
  });

  it('partitions: the next months exist and a rerun creates nothing', async () => {
    await maintenance(t.ctx, { task: 'partitions' });
    const again = await maintenance(t.ctx, { task: 'partitions' });
    expect(Object.values(again.created as Record<string, number>).every((n) => n === 0)).toBe(true);
  });
});


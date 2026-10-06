import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businesses, favorites, notifications, offerings, outboxEvents, reviews, savedComparisons, users, userSettings } from '../db/schema/index.js';
import { testContext } from '../test/context.js';
import { dispatchOutbox, FANOUT, processOutboxEvent } from './notify.js';

let t: Awaited<ReturnType<typeof testContext>>;
let biz: { id: string; ownerId: string; slug: string; name: string };
let offeringId: string;
const events: string[] = [];
const people: string[] = [];

beforeAll(async () => {
  t = await testContext();
  [biz] = (await t.ctx.db
    .select({ id: businesses.id, ownerId: businesses.ownerId, slug: businesses.slug, name: businesses.name })
    .from(businesses)
    .where(eq(businesses.publicationStatus, 'APPROVED'))
    .limit(1)) as [typeof biz];
  [{ id: offeringId }] = (await t.ctx.db.select({ id: offerings.id }).from(offerings).where(and(eq(offerings.businessId, biz.id), eq(offerings.publicationStatus, 'APPROVED'))).limit(1)) as [{ id: string }];
});
afterAll(async () => {
  if (events.length) {
    await t.ctx.db.delete(notifications).where(sql`split_part(${notifications.dedupeKey}, ':', 1) IN (${sql.join(events.map((e) => sql`${e}`), sql`, `)})`);
    await t.ctx.db.delete(outboxEvents).where(inArray(outboxEvents.id, events));
  }
  if (people.length) await t.ctx.db.delete(users).where(inArray(users.id, people));
  await t?.close();
});

async function event(type: string, payload: Record<string, unknown>, opts: { ageMs?: number } = {}) {
  const [e] = await t.ctx.db
    .insert(outboxEvents)
    .values({ type, payload, ...(opts.ageMs ? { createdAt: new Date(Date.now() - opts.ageMs) } : {}) })
    .returning();
  events.push(e!.id);
  return e!;
}
const delivered = (eventId: string) => t.ctx.db.select().from(notifications).where(like(notifications.dedupeKey, `${eventId}:%`));

async function shopper(prefs: Partial<{ priceAlerts: boolean; reviewReplyAlerts: boolean }> = {}) {
  const [u] = await t.ctx.db.insert(users).values({ email: `notify-${randomUUID()}@example.test`, name: 'Notify Test', status: 'ACTIVE' }).returning({ id: users.id });
  people.push(u!.id);
  if (Object.keys(prefs).length) await t.ctx.db.insert(userSettings).values({ userId: u!.id, ...prefs });
  return u!.id;
}

describe('notifications from domain events', () => {
  it('a decision reaches the owner once — redelivery and a reset event never duplicate it', async () => {
    const e = await event('approval.decided', { entityType: 'BUSINESS', entityId: biz.id, businessId: biz.id, status: 'REJECTED', action: 'REJECT', reason: 'Add a real photo of the storefront' });
    expect(await processOutboxEvent(t.ctx, { outboxEventId: e.id })).toMatchObject({ status: 'done', notified: 1 });
    const [n] = await delivered(e.id);
    expect(n).toMatchObject({ audience: 'OWNER', ownerId: biz.ownerId, businessId: biz.id, type: 'REJECTED', link: `/b/${biz.id}/approvals` });
    expect(n!.title).toContain('not approved');
    expect(n!.body).toContain('real photo');

    expect((await processOutboxEvent(t.ctx, { outboxEventId: e.id })).status).toBe('skipped'); // already delivered
    await t.ctx.db.update(outboxEvents).set({ dispatchedAt: null }).where(eq(outboxEvents.id, e.id)); // e.g. crash before the ack
    await processOutboxEvent(t.ctx, { outboxEventId: e.id });
    expect(await delivered(e.id)).toHaveLength(1);
  });

  it('an item decision links to the item; a new submission goes to the staff inbox', async () => {
    const d = await event('approval.decided', { entityType: 'OFFERING', entityId: offeringId, businessId: biz.id, status: 'APPROVED', action: 'APPROVE', reason: null });
    await processOutboxEvent(t.ctx, { outboxEventId: d.id });
    expect((await delivered(d.id))[0]).toMatchObject({ type: 'APPROVED', link: `/b/${biz.id}/offerings/${offeringId}` });

    const s = await event('approval.submitted', { entityType: 'BUSINESS', entityId: biz.id, businessId: biz.id, resubmission: false });
    await processOutboxEvent(t.ctx, { outboxEventId: s.id });
    expect((await delivered(s.id))[0]).toMatchObject({ audience: 'ADMIN', userId: null, ownerId: null, type: 'BUSINESS', link: '/approvals?tab=businesses' });
  });

  it('a price drop fans out only to shoppers who saved the business and want price alerts', async () => {
    const wants = await shopper();
    const optedOut = await shopper({ priceAlerts: false });
    const stranger = await shopper();
    const comparer = await shopper(); // saved a comparison this item is in — and ALSO favourited: still one notification
    const [{ groupId }] = (await t.ctx.db.select({ groupId: offerings.comparisonGroupId }).from(offerings).where(eq(offerings.id, offeringId))) as [{ groupId: string | null }];
    // The suite runs against the shared dev database, where seeded shoppers may
    // already follow this business or comparison; they are not under test.
    const preexisting = new Set([
      ...(await t.ctx.db.select({ u: favorites.userId }).from(favorites).where(eq(favorites.businessId, biz.id))).map((r) => r.u),
      ...(groupId ? (await t.ctx.db.select({ u: savedComparisons.userId }).from(savedComparisons).where(eq(savedComparisons.comparisonGroupId, groupId))).map((r) => r.u) : []),
    ]);
    await t.ctx.db.insert(favorites).values([{ userId: wants, businessId: biz.id }, { userId: optedOut, businessId: biz.id }, { userId: comparer, businessId: biz.id }]);
    if (groupId) await t.ctx.db.insert(savedComparisons).values({ userId: comparer, comparisonGroupId: groupId });
    const e = await event('price.dropped', { offeringId, businessId: biz.id, oldAmountMinor: 25000, newAmountMinor: 19900 });
    await processOutboxEvent(t.ctx, { outboxEventId: e.id });
    const got = (await delivered(e.id)).filter((n) => !preexisting.has(n.userId!));
    expect(got.map((n) => n.userId).sort()).toEqual([wants, comparer].sort());
    expect(got[0]).toMatchObject({ audience: 'USER', type: 'PRICE_DROP', link: `/item/${offeringId}` });
    expect(got[0]!.title).toContain('₹250 → ₹199');
    expect(got.some((n) => n.userId === stranger)).toBe(false);
    // Redelivery: still exactly one each.
    await t.ctx.db.update(outboxEvents).set({ dispatchedAt: null }).where(eq(outboxEvents.id, e.id));
    await processOutboxEvent(t.ctx, { outboxEventId: e.id });
    expect((await delivered(e.id)).filter((n) => !preexisting.has(n.userId!))).toHaveLength(2);
  });

  it('saved-comparison shoppers hear about a price drop even without favouriting the business', async () => {
    const [{ groupId }] = (await t.ctx.db.select({ groupId: offerings.comparisonGroupId }).from(offerings).where(eq(offerings.id, offeringId))) as [{ groupId: string | null }];
    expect(groupId).not.toBeNull(); // a live seeded offering is grouped
    const only = await shopper();
    await t.ctx.db.insert(savedComparisons).values({ userId: only, comparisonGroupId: groupId! });
    const e = await event('price.dropped', { offeringId, businessId: biz.id, oldAmountMinor: 25000, newAmountMinor: 19900 });
    await processOutboxEvent(t.ctx, { outboxEventId: e.id });
    expect((await delivered(e.id)).map((n) => n.userId)).toContain(only);
  });

  it('fans out in chunks: every recipient once, however small the chunk', async () => {
    const people = await Promise.all(Array.from({ length: 7 }, () => shopper()));
    await t.ctx.db.insert(favorites).values(people.map((userId) => ({ userId, businessId: biz.id })));
    const saved = FANOUT.chunk;
    FANOUT.chunk = 2;
    try {
      const e = await event('price.dropped', { offeringId, businessId: biz.id, oldAmountMinor: 30000, newAmountMinor: 20000 });
      await processOutboxEvent(t.ctx, { outboxEventId: e.id });
      const got = (await delivered(e.id)).map((n) => n.userId);
      for (const p of people) expect(got.filter((u) => u === p)).toHaveLength(1);
      expect(new Set(got).size).toBe(got.length);
    } finally {
      FANOUT.chunk = saved;
    }
  });

  it('reply alerts are opt-in', async () => {
    const quiet = await shopper();
    const keen = await shopper({ reviewReplyAlerts: true });
    const reviewOf = async (userId: string) =>
      (await t.ctx.db.insert(reviews).values({ targetType: 'BUSINESS', businessId: biz.id, userId, rating: 4, body: 'ok', status: 'PUBLISHED' }).returning({ id: reviews.id }))[0]!.id;
    for (const [userId, expected] of [[quiet, 0], [keen, 1]] as const) {
      const e = await event('review.replied', { reviewId: await reviewOf(userId), businessId: biz.id });
      await processOutboxEvent(t.ctx, { outboxEventId: e.id });
      const got = await delivered(e.id);
      expect(got).toHaveLength(expected);
      if (expected) expect(got[0]).toMatchObject({ userId: keen, type: 'MESSAGE', link: `/business/${biz.slug}` });
    }
  });

  it('an event that never committed, or has no handler, is a no-op', async () => {
    expect((await processOutboxEvent(t.ctx, { outboxEventId: randomUUID() })).status).toBe('skipped');
    const e = await event('something.unknown', {});
    expect(await processOutboxEvent(t.ctx, { outboxEventId: e.id })).toMatchObject({ status: 'done', notified: 0 });
  });

  it('the sweep re-queues committed events that were never queued (Redis was down)', async () => {
    const lost = await event('review.created', { reviewId: randomUUID(), businessId: biz.id, offeringId: null, rating: 5 }, { ageMs: 5 * 60_000 });
    const fresh = await event('review.created', { reviewId: randomUUID(), businessId: biz.id, offeringId: null, rating: 5 });
    t.enqueued.length = 0;
    await dispatchOutbox(t.ctx);
    const ids = t.enqueued.filter((j) => j.queue === 'notifications').map((j) => (j.payload as { outboxEventId: string }).outboxEventId);
    expect(ids).toContain(lost.id);
    expect(ids).not.toContain(fresh.id); // the API's own enqueue gets a minute first
    await processOutboxEvent(t.ctx, { outboxEventId: lost.id });
    expect((await delivered(lost.id))[0]).toMatchObject({ type: 'REVIEW', link: `/b/${biz.id}/reviews` });
  });
});

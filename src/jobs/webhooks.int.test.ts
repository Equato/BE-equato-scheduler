import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { users, userSettings, webhookEvents } from '../db/schema/index.js';
import { testContext } from '../test/context.js';
import { processWebhook, registerWebhookHandler, requeueWebhooks } from './webhooks.js';

let t: Awaited<ReturnType<typeof testContext>>;
const rows: string[] = [];
let userId: string;
const email = `bounce-${randomUUID()}@example.test`;

beforeAll(async () => {
  t = await testContext();
  const [u] = await t.ctx.db.insert(users).values({ email, name: 'Bounce Test' }).returning({ id: users.id });
  userId = u!.id;
  await t.ctx.db.insert(userSettings).values({ userId, emailEnabled: true });
});
afterAll(async () => {
  if (rows.length) await t.ctx.db.delete(webhookEvents).where(inArray(webhookEvents.id, rows));
  await t.ctx.db.delete(users).where(eq(users.id, userId));
  await t?.close();
});

async function event(provider: string, type: string, data: Record<string, unknown>, extra: Partial<typeof webhookEvents.$inferInsert> = {}) {
  const [r] = await t.ctx.db
    .insert(webhookEvents)
    .values({ provider, eventId: `evt_${randomUUID()}`, eventType: type, payload: { id: 'x', type, data }, signatureVerified: true, ...extra })
    .returning();
  rows.push(r!.id);
  return r!;
}

describe('webhook processing', () => {
  it('a hard bounce turns email off for that address; the event is PROCESSED once', async () => {
    const e = await event('email', 'email.bounced', { email: email.toUpperCase(), bounceType: 'hard' });
    // Two workers race on the same event: exactly one acts.
    const [a, b] = await Promise.all([processWebhook(t.ctx, { webhookEventId: e.id }), processWebhook(t.ctx, { webhookEventId: e.id })]);
    expect([a.status, b.status].sort()).toEqual(['done', 'skipped']);
    const [s] = await t.ctx.db.select().from(userSettings).where(eq(userSettings.userId, userId));
    expect(s!.emailEnabled).toBe(false);
    const [row] = await t.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, e.id));
    expect(row).toMatchObject({ status: 'PROCESSED', attempts: 1 });
    // Redelivery of the job is a no-op.
    expect((await processWebhook(t.ctx, { webhookEventId: e.id })).status).toBe('skipped');
  });

  it('a row whose data no longer matches the contract is SKIPPED with the reason, never acted on', async () => {
    const e = await event('email', 'email.bounced', { email: 'not-an-email', bounceType: 'hard' });
    expect((await processWebhook(t.ctx, { webhookEventId: e.id })).status).toBe('skipped');
    const [row] = await t.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, e.id));
    expect(row!.status).toBe('SKIPPED');
    expect(row!.lastError).toMatch(/invalid data/);
  });

  it('a failing handler leaves the event FAILED with the error, and rethrows for retry', async () => {
    registerWebhookHandler('default', 'test.ping', async () => {
      throw new Error('downstream unavailable');
    });
    const e = await event('default', 'test.ping', {});
    await expect(processWebhook(t.ctx, { webhookEventId: e.id })).rejects.toThrow('downstream unavailable');
    const [row] = await t.ctx.db.select().from(webhookEvents).where(eq(webhookEvents.id, e.id));
    expect(row).toMatchObject({ status: 'FAILED', lastError: 'downstream unavailable', attempts: 1 });
    registerWebhookHandler('default', 'test.ping', async () => ({ action: 'none' }));
    expect((await processWebhook(t.ctx, { webhookEventId: e.id })).status).toBe('done'); // the retry succeeds
  });

  it('the sweep re-queues events that were stored but never queued', async () => {
    const e = await event('default', 'test.ping', {}, { receivedAt: new Date(Date.now() - 10 * 60_000) });
    await requeueWebhooks(t.ctx);
    expect(t.enqueued.some((j) => j.queue === 'webhooks' && (j.payload as { webhookEventId: string }).webhookEventId === e.id)).toBe(true);
  });
});

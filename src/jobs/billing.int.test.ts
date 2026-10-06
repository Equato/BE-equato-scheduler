import { randomUUID } from 'node:crypto';
import { and, eq, inArray, like, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  areas,
  billingCheckouts,
  businessOwners,
  businesses,
  categories,
  invoices,
  notifications,
  outboxEvents,
  paymentMandates,
  paymentTransactions,
  subscriptionEvents,
  subscriptionPlans,
  subscriptions,
  users,
  webhookEvents,
} from '../db/schema/index.js';
import { MockPaymentProvider } from '../shared/billing/mock-provider.js';
import { addDays, addPeriod, reconcile, runBillingCycle, sendReminders, type BillingDeps } from '../shared/billing/index.js';
import { testContext } from '../test/context.js';
import { billingDepsFor, registerBillingWebhooks } from './billing.js';
import { processOutboxEvent } from './notify.js';
import { processWebhook } from './webhooks.js';

/**
 * The subscription lifecycle as the scheduler runs it: trial ends, renewals,
 * failed debits and retries, expiry, cancellation at period end, reminders,
 * webhooks and reconciliation — against the shared Postgres, with the mock
 * provider. Every step is run twice somewhere to prove it is idempotent.
 */

let t: Awaited<ReturnType<typeof testContext>>;
let deps: BillingDeps;
let mock: MockPaymentProvider;
let planId: string;
const made = { users: [] as string[], businesses: [] as string[] };

beforeAll(async () => {
  t = await testContext();
  deps = billingDepsFor(t.ctx)!;
  mock = t.ctx.payments as MockPaymentProvider;
  registerBillingWebhooks();
  const [p] = await t.ctx.db.insert(subscriptionPlans).values({ code: `sched-${randomUUID().slice(0, 8)}`, name: 'Scheduler Pro', status: 'ACTIVE', priceMinor: 50_000, interval: 'MONTH', intervalCount: 1, trialDays: 7 }).returning();
  planId = p!.id;
});

afterAll(async () => {
  const db = t.ctx.db;
  const ids = made.businesses;
  if (ids.length) {
    await db.delete(notifications).where(inArray(notifications.businessId, ids));
    for (const table of ['payment_transactions', 'invoices', 'subscription_trials', 'billing_checkouts', 'subscription_events', 'subscriptions', 'payment_mandates', 'payment_customers']) {
      await db.execute(sql`DELETE FROM ${sql.raw(table)} WHERE business_id IN ${ids}`);
    }
    await db.execute(sql`DELETE FROM outbox_events WHERE type = 'billing.event' AND payload->>'businessId' IN ${ids}`);
    await db.delete(businesses).where(inArray(businesses.id, ids));
  }
  await db.delete(webhookEvents).where(like(webhookEvents.eventId, 'evt_sched_%'));
  if (made.users.length) await db.delete(users).where(inArray(users.id, made.users));
  await db.delete(subscriptionPlans).where(eq(subscriptionPlans.id, planId));
  await t?.close();
});

/** A fresh owner + approved business. */
async function business() {
  const db = t.ctx.db;
  const email = `billing-${randomUUID().slice(0, 8)}@test.local`;
  const [u] = await db.insert(users).values({ email, name: 'Billing Test', status: 'ACTIVE' }).returning({ id: users.id });
  const [o] = await db.insert(businessOwners).values({ userId: u!.id, displayName: 'Billing Owner', contactEmail: email, status: 'ACTIVE' }).returning({ id: businessOwners.id });
  const [c] = await db.select({ id: categories.id }).from(categories).where(eq(categories.slug, 'cafe'));
  const [a] = await db.select({ id: areas.id }).from(areas).where(eq(areas.slug, 'vesu'));
  const [b] = await db
    .insert(businesses)
    .values({ ownerId: o!.id, categoryId: c!.id, areaId: a!.id, name: 'Billing Test Cafe', slug: `billing-test-${randomUUID()}`, location: { lat: 21.17, lng: 72.83 }, publicationStatus: 'APPROVED' })
    .returning({ id: businesses.id });
  made.users.push(u!.id);
  made.businesses.push(b!.id);
  return { businessId: b!.id, ownerId: o!.id };
}

/** An ACTIVE AutoPay mandate at the (mock) provider and in Postgres. */
async function mandate(businessId: string, maxMinor = 50_000) {
  const s = await mock.createCheckout({ checkoutId: randomUUID(), idempotencyKey: `m-${randomUUID()}`, businessId, customerRef: null, method: 'UPI', recurring: true, amount: { amountMinor: 0, currency: 'INR' }, recurringAmount: { amountMinor: maxMinor, currency: 'INR' }, interval: 'MONTH', intervalCount: 1, description: 'test', returnUrl: 'http://x.test', expiresAt: addDays(new Date(), 1) });
  const done = await mock.simulateCheckout(s.providerCheckoutRef, 'APPROVE', { vpa: 'owner@okicici' });
  const [m] = await t.ctx.db
    .insert(paymentMandates)
    .values({ businessId, provider: 'mock', providerMandateRef: done.mandateRef!, methodType: 'UPI', status: 'ACTIVE', maxAmountMinor: maxMinor, interval: 'MONTH', consentText: 'test consent', consentedAt: new Date() })
    .returning();
  return m!;
}

type SubInit = Partial<typeof subscriptions.$inferInsert> & { businessId: string };
async function subscription(init: SubInit) {
  const now = new Date();
  const [s] = await t.ctx.db
    .insert(subscriptions)
    .values({ planId, status: 'ACTIVE', priceMinor: 50_000, interval: 'MONTH', intervalCount: 1, currentPeriodStart: addDays(now, -31), currentPeriodEnd: addDays(now, -1), ...init })
    .returning();
  return s!;
}
const subNow = async (id: string) => (await t.ctx.db.select().from(subscriptions).where(eq(subscriptions.id, id)))[0]!;
const invoicesOf = (id: string) => t.ctx.db.select().from(invoices).where(eq(invoices.subscriptionId, id));
const txnsOf = (id: string) => t.ctx.db.select().from(paymentTransactions).where(eq(paymentTransactions.subscriptionId, id));
const eventsOf = async (businessId: string) => (await t.ctx.db.select({ type: subscriptionEvents.type }).from(subscriptionEvents).where(eq(subscriptionEvents.businessId, businessId))).map((e) => e.type);

describe('trials', () => {
  it('a trial with AutoPay converts to paid at trial end — once, however often the cycle runs', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    const trialEnd = addDays(new Date(), -1);
    const s = await subscription({ businessId, status: 'TRIALING', trialEndsAt: trialEnd, currentPeriodStart: addDays(trialEnd, -7), currentPeriodEnd: trialEnd, recurring: true, mandateId: m.id, paymentMethodType: 'UPI' });
    await runBillingCycle(deps);
    await runBillingCycle(deps);
    const after = await subNow(s.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.currentPeriodStart.toISOString()).toBe(trialEnd.toISOString());
    expect(after.currentPeriodEnd.toISOString()).toBe(addPeriod(trialEnd, 'MONTH', 1).toISOString());
    const inv = await invoicesOf(s.id);
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: 'PAID', totalMinor: 50_000 });
    expect((await txnsOf(s.id)).map((x) => x.status)).toEqual(['SUCCEEDED']);
  });

  it('a trial without a payment method expires at the end', async () => {
    const { businessId } = await business();
    const s = await subscription({ businessId, status: 'TRIALING', trialEndsAt: addDays(new Date(), -1), recurring: false });
    await runBillingCycle(deps);
    expect((await subNow(s.id)).status).toBe('EXPIRED');
    expect(await eventsOf(businessId)).toContain('EXPIRED');
  });
});

describe('renewals, failures and retries', () => {
  it('renewal charges the mandate and moves the period on', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id, paymentMethodType: 'UPI' });
    await runBillingCycle(deps);
    const after = await subNow(s.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.currentPeriodStart.toISOString()).toBe(s.currentPeriodEnd.toISOString());
    expect((await invoicesOf(s.id))[0]!.status).toBe('PAID');
  });

  it('a failed debit makes the subscription PAST_DUE with a retry; the retry succeeds', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    await mock.failNextCharges(m.providerMandateRef, 1);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id, paymentMethodType: 'UPI' });
    await runBillingCycle(deps);
    let after = await subNow(s.id);
    expect(after.status).toBe('PAST_DUE');
    expect(after.retryAttempts).toBe(1);
    expect(after.nextRetryAt!.getTime()).toBeGreaterThan(Date.now());
    expect(await eventsOf(businessId)).toContain('PAYMENT_FAILED');

    await t.ctx.db.update(subscriptions).set({ nextRetryAt: addDays(new Date(), -0.01) }).where(eq(subscriptions.id, s.id));
    await runBillingCycle(deps);
    after = await subNow(s.id);
    expect(after.status).toBe('ACTIVE');
    expect(after.pastDueSince).toBeNull();
    expect((await txnsOf(s.id)).map((x) => x.status).sort()).toEqual(['FAILED', 'SUCCEEDED']);
    expect(await invoicesOf(s.id)).toHaveLength(1);
  });

  it('when every retry fails the subscription expires and the mandate is revoked at the provider', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    await mock.failNextCharges(m.providerMandateRef, 10);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id, paymentMethodType: 'UPI' });
    await runBillingCycle(deps);
    for (let i = 0; i < 4 && (await subNow(s.id)).status === 'PAST_DUE'; i++) {
      await t.ctx.db.update(subscriptions).set({ nextRetryAt: addDays(new Date(), -0.01) }).where(eq(subscriptions.id, s.id));
      await runBillingCycle(deps);
    }
    const after = await subNow(s.id);
    expect(after.status).toBe('EXPIRED');
    expect(await txnsOf(s.id)).toHaveLength(4); // first attempt + 3 retries
    expect((await invoicesOf(s.id))[0]!.status).toBe('FAILED');
    expect((await mock.retrieveMandate(m.providerMandateRef)).status).toBe('CANCELLED');
  });

  it('cancel at period end ends it at the renewal instead of charging', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id, cancelAtPeriodEnd: true });
    await runBillingCycle(deps);
    expect((await subNow(s.id)).status).toBe('CANCELLED');
    expect(await invoicesOf(s.id)).toHaveLength(0);
    expect((await mock.retrieveMandate(m.providerMandateRef)).status).toBe('CANCELLED');
  });

  it('without AutoPay: an open invoice and PAST_DUE; after the grace period, EXPIRED', async () => {
    const { businessId } = await business();
    const s = await subscription({ businessId, recurring: false });
    await runBillingCycle(deps);
    expect((await subNow(s.id)).status).toBe('PAST_DUE');
    expect((await invoicesOf(s.id))[0]!.status).toBe('OPEN');
    await t.ctx.db.update(subscriptions).set({ pastDueSince: addDays(new Date(), -8) }).where(eq(subscriptions.id, s.id));
    await runBillingCycle(deps);
    expect((await subNow(s.id)).status).toBe('EXPIRED');
    expect((await invoicesOf(s.id))[0]!.status).toBe('FAILED');
  });
});

describe('webhooks, reconciliation, reminders, notifications', () => {
  async function delivery(type: string, data: Record<string, string>) {
    const [e] = await t.ctx.db.insert(webhookEvents).values({ provider: 'payments', eventId: `evt_sched_${randomUUID()}`, eventType: type, payload: { id: 'x', type, data } }).returning();
    return processWebhook(t.ctx, { webhookEventId: e!.id });
  }

  it('a checkout.updated webhook completes the checkout (reading the provider back); repeats change nothing', async () => {
    const { businessId } = await business();
    const [co] = await t.ctx.db
      .insert(billingCheckouts)
      .values({ businessId, kind: 'SUBSCRIBE', planId, methodType: 'UPI', recurring: true, listAmountMinor: 50_000, amountMinor: 50_000, recurringAmountMinor: 50_000, consentText: 'consent', idempotencyKey: `k-${randomUUID()}`, provider: 'mock', expiresAt: addDays(new Date(), 1) })
      .returning();
    const s = await mock.createCheckout({ checkoutId: co!.id, idempotencyKey: `checkout:${co!.id}`, businessId, customerRef: null, method: 'UPI', recurring: true, amount: { amountMinor: 50_000, currency: 'INR' }, recurringAmount: { amountMinor: 50_000, currency: 'INR' }, interval: 'MONTH', intervalCount: 1, description: 'consent', returnUrl: 'http://x.test', expiresAt: addDays(new Date(), 1) });
    await t.ctx.db.update(billingCheckouts).set({ providerCheckoutRef: s.providerCheckoutRef }).where(eq(billingCheckouts.id, co!.id));
    await mock.simulateCheckout(s.providerCheckoutRef, 'APPROVE', { vpa: 'x@ybl' });
    const first = await delivery('checkout.updated', { checkoutRef: s.providerCheckoutRef });
    expect(first.action).toBe('checkout COMPLETED');
    const second = await delivery('checkout.updated', { checkoutRef: s.providerCheckoutRef });
    expect(second.action).toMatch(/unchanged/);
    expect(await t.ctx.db.select().from(subscriptions).where(eq(subscriptions.businessId, businessId))).toHaveLength(1);
    expect(await t.ctx.db.select().from(paymentTransactions).where(eq(paymentTransactions.businessId, businessId))).toHaveLength(1);
  });

  it('a mandate revoked from the bank side turns AutoPay off and tells the owner', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id, currentPeriodEnd: addDays(new Date(), 10), currentPeriodStart: addDays(new Date(), -20) });
    await mock.revokeFromBank(m.providerMandateRef);
    await delivery('mandate.updated', { mandateRef: m.providerMandateRef });
    await delivery('mandate.updated', { mandateRef: m.providerMandateRef });
    expect((await subNow(s.id)).recurring).toBe(false);
    expect((await eventsOf(businessId)).filter((e) => e === 'MANDATE_CANCELLED')).toHaveLength(1);
  });

  it('a charge whose answer was lost is re-asked with the SAME idempotency key — never a second debit', async () => {
    const { businessId } = await business();
    const m = await mandate(businessId);
    const s = await subscription({ businessId, recurring: true, mandateId: m.id });
    const [inv] = await t.ctx.db.insert(invoices).values({ businessId, subscriptionId: s.id, status: 'OPEN', subtotalMinor: 50_000, totalMinor: 50_000, periodStart: s.currentPeriodEnd, periodEnd: addPeriod(s.currentPeriodEnd, 'MONTH', 1), description: 'x', dueAt: s.currentPeriodEnd }).returning();
    // The worker crashed after recording the attempt but before the provider answered.
    const key = `invoice:${inv!.id}:attempt:1`;
    await t.ctx.db.insert(paymentTransactions).values({ businessId, subscriptionId: s.id, invoiceId: inv!.id, mandateId: m.id, provider: 'mock', kind: 'CHARGE', amountMinor: 50_000, status: 'PENDING', idempotencyKey: key, updatedAt: addDays(new Date(), -1) });
    await reconcile(deps);
    await reconcile(deps);
    const txns = await txnsOf(s.id);
    expect(txns).toHaveLength(1);
    expect(txns[0]!.status).toBe('SUCCEEDED');
    expect((await subNow(s.id)).currentPeriodStart.toISOString()).toBe(s.currentPeriodEnd.toISOString());
  });

  it('renewal reminders are sent once per period and become an owner notification', async () => {
    const { businessId } = await business();
    await subscription({ businessId, recurring: false, currentPeriodStart: addDays(new Date(), -28), currentPeriodEnd: addDays(new Date(), 2) });
    await sendReminders(deps);
    await sendReminders(deps);
    expect((await eventsOf(businessId)).filter((e) => e === 'RENEWAL_REMINDER')).toHaveLength(1);
    const [ev] = await t.ctx.db.select().from(outboxEvents).where(and(eq(outboxEvents.type, 'billing.event'), sql`${outboxEvents.payload}->>'businessId' = ${businessId}`, sql`${outboxEvents.payload}->>'kind' = 'RENEWAL_REMINDER'`));
    await processOutboxEvent(t.ctx, { outboxEventId: ev!.id });
    const [n] = await t.ctx.db.select().from(notifications).where(eq(notifications.businessId, businessId));
    expect(n).toMatchObject({ audience: 'OWNER', type: 'BILLING', link: `/b/${businessId}/billing` });
    expect(n!.title).toMatch(/renews on/);
  });
});

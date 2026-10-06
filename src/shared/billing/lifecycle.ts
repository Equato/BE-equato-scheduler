/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { and, desc, eq, gt, inArray, isNotNull, isNull, lt, lte, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  billingCheckouts,
  invoiceItems,
  invoices,
  paymentMandates,
  paymentTransactions,
  subscriptionEvents,
  subscriptionOffers,
  subscriptionPlans,
  subscriptions,
  subscriptionTrials,
} from '../../db/schema/index.js';
import { BILLING_POLICY, canTransitionPayment, canTransitionSubscription, type PaymentStatus, type SubscriptionStatus } from '../domain/billing.js';
import { addDays, addPeriod, discountedPrice, inr, nextPeriodAmount, periodLabel } from './pricing.js';
import { ProviderError, type CheckoutResult, type MandateResult, type PaymentProvider, type PaymentResult } from './provider.js';
import { liveSubscription, type Tx } from './rules.js';

/**
 * The subscription state machine, shared by equato-api (checkout return,
 * owner actions) and equato-scheduler (webhooks, renewals, retries,
 * reconciliation). Rules that hold everywhere:
 *
 *   - Provider results are READ BACK from the provider (never taken from the
 *     browser), and checked against what Equato expected to be charged.
 *   - Every apply is idempotent: rows are locked FOR UPDATE, final states
 *     never move again, and UNIQUE keys (one invoice per period, one
 *     transaction per idempotency key, one live subscription per business)
 *     make a second delivery a no-op instead of a second charge.
 *   - No network call to the provider happens inside a DB transaction: work
 *     is prepared and committed, then the provider is called, then the result
 *     is applied in a new transaction.
 *   - Owner-facing changes write a subscription_events row and an outbox
 *     event (in the same transaction) for the in-app notification.
 */

export type BillingEventKind =
  | 'TRIAL_STARTED'
  | 'TRIAL_ENDING'
  | 'ACTIVATED'
  | 'RENEWED'
  | 'PAYMENT_SUCCEEDED'
  | 'PAYMENT_FAILED'
  | 'PAST_DUE'
  | 'RENEWAL_REMINDER'
  | 'CANCEL_SCHEDULED'
  | 'CANCELLED'
  | 'RESUMED'
  | 'EXPIRED'
  | 'PLAN_CHANGE_SCHEDULED'
  | 'PLAN_CHANGED'
  | 'MANDATE_CREATED'
  | 'MANDATE_CANCELLED'
  | 'PAUSED'
  | 'REFUNDED'
  | 'CHECKOUT_FAILED';

export interface BillingEventPayload {
  businessId: string;
  subscriptionId: string | null;
  kind: BillingEventKind;
  amountMinor?: number | null;
  planName?: string | null;
  /** ISO date the owner should know (next charge, trial end, retry). */
  date?: string | null;
  detail?: string | null;
}

export interface BillingDeps {
  db: Database;
  provider: PaymentProvider;
  /** Writes the event to the transactional outbox (→ in-app notification). */
  emit: (tx: Tx, payload: BillingEventPayload) => Promise<void>;
  now?: () => Date;
  log?: { warn(obj: unknown, msg?: string): void; info?(obj: unknown, msg?: string): void };
}

type Sub = typeof subscriptions.$inferSelect;
type Checkout = typeof billingCheckouts.$inferSelect;
type Post = (() => Promise<unknown>)[];

const nowOf = (d: BillingDeps) => d.now?.() ?? new Date();

/* ---------------------------------------------------------------- events */

export async function recordEvent(
  tx: Tx,
  deps: BillingDeps,
  e: { businessId: string; subscriptionId: string | null; kind: BillingEventKind; notify?: boolean; actorUserId?: string | null; dedupeKey?: string | null; amountMinor?: number | null; planName?: string | null; date?: Date | null; detail?: string | null; data?: Record<string, unknown> },
): Promise<boolean> {
  const rows = await tx
    .insert(subscriptionEvents)
    .values({
      businessId: e.businessId,
      subscriptionId: e.subscriptionId,
      type: e.kind,
      data: { ...(e.data ?? {}), ...(e.amountMinor != null ? { amountMinor: e.amountMinor } : {}), ...(e.planName ? { planName: e.planName } : {}), ...(e.date ? { date: e.date.toISOString() } : {}), ...(e.detail ? { detail: e.detail } : {}) },
      actorUserId: e.actorUserId ?? null,
      dedupeKey: e.dedupeKey ?? null,
    })
    .onConflictDoNothing()
    .returning({ id: subscriptionEvents.id });
  if (!rows.length) return false;
  if (e.notify) {
    await deps.emit(tx, { businessId: e.businessId, subscriptionId: e.subscriptionId, kind: e.kind, amountMinor: e.amountMinor ?? null, planName: e.planName ?? null, date: e.date ? e.date.toISOString() : null, detail: e.detail ?? null });
  }
  return true;
}

async function planOf(tx: Tx, planId: string) {
  const [p] = await tx.select().from(subscriptionPlans).where(eq(subscriptionPlans.id, planId)).limit(1);
  if (!p) throw new Error(`plan ${planId} missing`);
  return p;
}

function setStatus(sub: Sub, to: SubscriptionStatus) {
  if (sub.status !== to && !canTransitionSubscription(sub.status, to)) throw new Error(`subscription ${sub.id}: ${sub.status} → ${to} is not allowed`);
  return to;
}

/* ------------------------------------------------------- payments/mandates */

async function upsertMandate(tx: Tx, deps: BillingDeps, co: Checkout, m: MandateResult): Promise<string> {
  const now = nowOf(deps);
  const [row] = await tx
    .insert(paymentMandates)
    .values({
      businessId: co.businessId,
      provider: deps.provider.name,
      providerMandateRef: m.providerMandateRef,
      methodType: m.method,
      status: m.status,
      maxAmountMinor: m.maxAmount.amountMinor,
      currency: m.maxAmount.currency,
      interval: (await planOf(tx, co.planId)).interval,
      intervalCount: (await planOf(tx, co.planId)).intervalCount,
      validUntil: m.validUntil,
      displayLabel: m.displayLabel,
      consentText: co.consentText,
      consentedAt: co.createdAt,
      consentedByUserId: co.createdByUserId,
      activatedAt: m.status === 'ACTIVE' ? now : null,
    })
    .onConflictDoUpdate({ target: [paymentMandates.provider, paymentMandates.providerMandateRef], set: { status: m.status, displayLabel: m.displayLabel, updatedAt: now } })
    .returning({ id: paymentMandates.id, businessId: paymentMandates.businessId });
  if (row!.businessId !== co.businessId) throw new Error('mandate belongs to another business');
  return row!.id;
}

/** Records (or advances) the transaction for a checkout's payment. */
async function recordCheckoutPayment(tx: Tx, deps: BillingDeps, co: Checkout, p: PaymentResult): Promise<string> {
  const key = `checkout:${co.id}`;
  const now = nowOf(deps);
  const inserted = await tx
    .insert(paymentTransactions)
    .values({
      businessId: co.businessId,
      checkoutId: co.id,
      subscriptionId: co.subscriptionId,
      provider: deps.provider.name,
      providerPaymentRef: p.providerPaymentRef,
      kind: 'CHARGE',
      methodType: p.method,
      amountMinor: p.amount.amountMinor,
      currency: p.amount.currency,
      status: p.status,
      idempotencyKey: key,
      failureCode: p.failureCode ?? null,
      failureMessage: p.failureMessage ?? null,
      succeededAt: p.status === 'SUCCEEDED' ? now : null,
    })
    .onConflictDoNothing()
    .returning({ id: paymentTransactions.id });
  if (inserted[0]) return inserted[0].id;
  const [t] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, key)).for('update');
  if (t && t.status !== p.status && canTransitionPayment(t.status, p.status)) {
    await tx.update(paymentTransactions).set({ status: p.status, providerPaymentRef: t.providerPaymentRef ?? p.providerPaymentRef, updatedAt: now, succeededAt: p.status === 'SUCCEEDED' ? now : t.succeededAt }).where(eq(paymentTransactions.id, t.id));
  }
  return t!.id;
}

/** The provider's answer must match what WE asked for — otherwise nothing is activated. */
function mismatch(co: Checkout, r: CheckoutResult): string | null {
  if (co.amountMinor > 0) {
    if (!r.payment) return 'no payment reported';
    if (r.payment.status !== 'SUCCEEDED') return `payment is ${r.payment.status}`;
    if (r.payment.amount.amountMinor !== co.amountMinor || r.payment.amount.currency !== co.currency) return 'amount or currency differs';
    if (r.payment.method !== co.methodType) return 'payment method differs';
  }
  if (co.recurring) {
    if (!r.mandate) return 'no mandate reported';
    if (r.mandate.status !== 'ACTIVE') return `mandate is ${r.mandate.status}`;
    if (r.mandate.maxAmount.amountMinor < co.recurringAmountMinor) return 'mandate limit is below the recurring amount';
  }
  return null;
}

/* --------------------------------------------------------------- checkout */

export interface CheckoutOutcome {
  status: Checkout['status'];
  subscriptionId: string | null;
  changed: boolean;
  failureReason: string | null;
}

/**
 * Apply what the provider says happened to a checkout. Called when the owner
 * returns (API, after reading the provider back), by the `checkout.updated`
 * webhook (scheduler) and by reconciliation. Whichever runs first does the
 * work; the others find the checkout no longer OPEN and change nothing.
 */
export async function applyCheckoutResult(deps: BillingDeps, checkoutId: string, result: CheckoutResult): Promise<CheckoutOutcome> {
  const post: Post = [];
  const out = await deps.db.transaction(async (tx): Promise<CheckoutOutcome> => {
    const [co] = await tx.select().from(billingCheckouts).where(eq(billingCheckouts.id, checkoutId)).for('update');
    if (!co) throw new Error('checkout not found');
    if (co.status !== 'OPEN') return { status: co.status, subscriptionId: co.subscriptionId, changed: false, failureReason: co.failureReason };
    const now = nowOf(deps);
    const fail = async (reason: string, opts: { refund?: PaymentResult | null; cancelMandate?: string | null } = {}) => {
      await tx.update(billingCheckouts).set({ status: 'FAILED', failureReason: reason, completedAt: now, updatedAt: now }).where(eq(billingCheckouts.id, co.id));
      await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: co.subscriptionId, kind: 'CHECKOUT_FAILED', notify: false, detail: reason, data: { checkoutId: co.id } });
      const refund = opts.refund;
      if (refund?.status === 'SUCCEEDED') post.push(() => deps.provider.refund({ providerPaymentRef: refund.providerPaymentRef, amount: refund.amount, idempotencyKey: `refund:checkout:${co.id}`, reason }));
      const mandateRef = opts.cancelMandate;
      if (mandateRef) post.push(() => deps.provider.cancelMandate(mandateRef));
      return { status: 'FAILED' as const, subscriptionId: co.subscriptionId, changed: true, failureReason: reason };
    };

    if (result.status === 'OPEN') return { status: 'OPEN', subscriptionId: co.subscriptionId, changed: false, failureReason: null };
    if (result.status === 'EXPIRED') {
      await tx.update(billingCheckouts).set({ status: 'EXPIRED', completedAt: now, updatedAt: now }).where(eq(billingCheckouts.id, co.id));
      return { status: 'EXPIRED', subscriptionId: co.subscriptionId, changed: true, failureReason: null };
    }
    if (result.payment) await recordCheckoutPayment(tx, deps, co, result.payment);
    if (result.status === 'FAILED') {
      const reason = result.failureMessage || 'The payment did not go through.';
      const r = await fail(reason);
      await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: co.subscriptionId, kind: 'PAYMENT_FAILED', notify: true, amountMinor: co.amountMinor, detail: reason, data: { checkoutId: co.id } });
      return r;
    }

    // COMPLETED — but only if it is exactly what we asked for.
    const why = mismatch(co, result);
    if (why) {
      deps.log?.warn({ checkoutId: co.id, why }, 'billing: provider result does not match the checkout; nothing activated');
      return fail('The payment could not be verified, so your plan was not changed. Any amount taken will be refunded.', { refund: result.payment, cancelMandate: result.mandate?.providerMandateRef ?? null });
    }
    const mandateId = result.mandate ? await upsertMandate(tx, deps, co, result.mandate) : null;

    let subId: string | null;
    if (co.kind === 'SUBSCRIBE') subId = await subscribeFromCheckout(tx, deps, co, mandateId, result, post, fail);
    else if (co.kind === 'RENEW') subId = await renewFromCheckout(tx, deps, co, result, post, fail);
    else subId = await paymentMethodFromCheckout(tx, deps, co, mandateId, result, post, fail);
    if (!subId) {
      const [after] = await tx.select().from(billingCheckouts).where(eq(billingCheckouts.id, co.id));
      return { status: after!.status, subscriptionId: after!.subscriptionId, changed: true, failureReason: after!.failureReason };
    }
    await tx.update(billingCheckouts).set({ status: 'COMPLETED', subscriptionId: subId, completedAt: now, updatedAt: now }).where(eq(billingCheckouts.id, co.id));
    await tx.update(paymentTransactions).set({ subscriptionId: subId, mandateId }).where(eq(paymentTransactions.checkoutId, co.id));
    return { status: 'COMPLETED', subscriptionId: subId, changed: true, failureReason: null };
  });
  for (const p of post) await p().catch((error) => deps.log?.warn({ err: (error as Error).message, checkoutId }, 'billing: follow-up provider call failed'));
  return out;
}

type Fail = (reason: string, opts?: { refund?: PaymentResult | null; cancelMandate?: string | null }) => Promise<CheckoutOutcome>;

async function offerFields(tx: Tx, co: Checkout, isTrial: boolean) {
  if (!co.offerId) return { offerId: null, discountedPriceMinor: null, discountCyclesRemaining: null };
  const [offer] = await tx.select().from(subscriptionOffers).where(eq(subscriptionOffers.id, co.offerId)).for('update');
  if (!offer) return { offerId: null, discountedPriceMinor: null, discountCyclesRemaining: null };
  await tx.update(subscriptionOffers).set({ redemptionCount: sql`${subscriptionOffers.redemptionCount} + 1`, updatedAt: new Date() }).where(eq(subscriptionOffers.id, offer.id));
  const perPeriod = isTrial ? discountedPrice(co.listAmountMinor, offer) : co.amountMinor;
  // The first paid period (now, unless a trial comes first) already used one cycle.
  const cycles = offer.durationCycles == null ? null : Math.max(0, offer.durationCycles - (isTrial ? 0 : 1));
  return { offerId: offer.id, discountedPriceMinor: perPeriod, discountCyclesRemaining: cycles };
}

async function issuePaidInvoice(tx: Tx, deps: BillingDeps, input: { businessId: string; subscriptionId: string; planName: string; periodStart: Date; periodEnd: Date; listMinor: number; discountMinor: number; interval: Sub['interval']; intervalCount: number }) {
  const now = nowOf(deps);
  const [inv] = await tx
    .insert(invoices)
    .values({
      businessId: input.businessId,
      subscriptionId: input.subscriptionId,
      status: 'PAID',
      subtotalMinor: input.listMinor,
      discountMinor: input.discountMinor,
      totalMinor: input.listMinor - input.discountMinor,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      description: `${input.planName} — 1 ${periodLabel(input.interval, input.intervalCount)}`,
      dueAt: now,
      paidAt: now,
    })
    .returning({ id: invoices.id });
  await tx.insert(invoiceItems).values([
    { invoiceId: inv!.id, kind: 'PLAN', description: input.planName, amountMinor: input.listMinor },
    ...(input.discountMinor > 0 ? [{ invoiceId: inv!.id, kind: 'DISCOUNT', description: 'Offer discount', amountMinor: -input.discountMinor }] : []),
  ]);
  return inv!.id;
}

async function subscribeFromCheckout(tx: Tx, deps: BillingDeps, co: Checkout, mandateId: string | null, r: CheckoutResult, post: Post, fail: Fail): Promise<string | null> {
  const now = nowOf(deps);
  const plan = await planOf(tx, co.planId);
  const live = await liveSubscription(tx, co.businessId, { forUpdate: true });
  const isTrial = co.trialDays > 0;
  if (live && (live.status !== 'TRIALING' || isTrial)) {
    await fail('This business already has a subscription, so this payment was not applied. It will be refunded.', { refund: r.payment, cancelMandate: r.mandate?.providerMandateRef ?? null });
    return null;
  }
  const offer = await offerFields(tx, co, isTrial);
  const base = {
    planId: plan.id,
    currency: co.currency,
    priceMinor: co.listAmountMinor,
    interval: plan.interval,
    intervalCount: plan.intervalCount,
    ...offer,
    recurring: co.recurring,
    mandateId,
    paymentMethodType: co.methodType,
    createdByUserId: co.createdByUserId,
  };

  if (isTrial) {
    const trialEnds = addDays(now, co.trialDays);
    const [ownerRow] = (await tx.execute(sql`SELECT owner_id FROM businesses WHERE id = ${co.businessId}::uuid`)) as unknown as [{ owner_id: string }];
    // One trial per business, ever — the UNIQUE decides a race between two checkouts.
    const trial = await tx.insert(subscriptionTrials).values({ businessId: co.businessId, ownerId: ownerRow.owner_id, planId: plan.id, startedAt: now, endsAt: trialEnds }).onConflictDoNothing().returning({ id: subscriptionTrials.id });
    if (!trial.length) {
      await fail('This business has already used its free trial, so AutoPay was not set up.', { refund: r.payment, cancelMandate: r.mandate?.providerMandateRef ?? null });
      return null;
    }
    const [sub] = await tx.insert(subscriptions).values({ ...base, businessId: co.businessId, status: 'TRIALING', trialEndsAt: trialEnds, currentPeriodStart: now, currentPeriodEnd: trialEnds }).returning();
    await tx.update(subscriptionTrials).set({ subscriptionId: sub!.id }).where(eq(subscriptionTrials.id, trial[0]!.id));
    if (mandateId) await tx.update(paymentMandates).set({ nextDebitAt: trialEnds }).where(eq(paymentMandates.id, mandateId));
    await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: sub!.id, kind: 'TRIAL_STARTED', notify: true, planName: plan.name, date: trialEnds, actorUserId: co.createdByUserId });
    if (mandateId) await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: sub!.id, kind: 'MANDATE_CREATED', notify: true, amountMinor: co.recurringAmountMinor, date: trialEnds, detail: co.methodType });
    return sub!.id;
  }

  const periodEnd = addPeriod(now, plan.interval, plan.intervalCount);
  let subId: string;
  if (live) {
    // A trial converted to paid early: the same subscription, now ACTIVE.
    const oldMandate = live.mandateId;
    await tx
      .update(subscriptions)
      .set({ ...base, status: setStatus(live, 'ACTIVE'), currentPeriodStart: now, currentPeriodEnd: periodEnd, pendingPlanId: null, updatedAt: now })
      .where(eq(subscriptions.id, live.id));
    subId = live.id;
    if (oldMandate && oldMandate !== mandateId) {
      const [m] = await tx.select().from(paymentMandates).where(eq(paymentMandates.id, oldMandate));
      if (m && (m.status === 'ACTIVE' || m.status === 'PAUSED')) post.push(() => deps.provider.cancelMandate(m.providerMandateRef));
    }
  } else {
    const [sub] = await tx.insert(subscriptions).values({ ...base, businessId: co.businessId, status: 'ACTIVE', currentPeriodStart: now, currentPeriodEnd: periodEnd }).returning();
    subId = sub!.id;
  }
  if (co.listAmountMinor > 0) {
    const invoiceId = await issuePaidInvoice(tx, deps, { businessId: co.businessId, subscriptionId: subId, planName: plan.name, periodStart: now, periodEnd, listMinor: co.listAmountMinor, discountMinor: co.discountMinor, interval: plan.interval, intervalCount: plan.intervalCount });
    await tx.update(paymentTransactions).set({ invoiceId }).where(eq(paymentTransactions.checkoutId, co.id));
  }
  if (mandateId) await tx.update(paymentMandates).set({ nextDebitAt: periodEnd }).where(eq(paymentMandates.id, mandateId));
  await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: subId, kind: 'ACTIVATED', notify: true, planName: plan.name, amountMinor: co.amountMinor, date: periodEnd, actorUserId: co.createdByUserId });
  if (mandateId) await recordEvent(tx, deps, { businessId: co.businessId, subscriptionId: subId, kind: 'MANDATE_CREATED', notify: true, amountMinor: co.recurringAmountMinor, date: periodEnd, detail: co.methodType });
  return subId;
}

/** The period a manual renewal pays for: an unpaid invoice's, else the one after the current. */
export async function renewalTarget(tx: Tx | Database, sub: Sub) {
  const [open] = await tx
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, 'OPEN')))
    .orderBy(desc(invoices.periodStart))
    .limit(1);
  if (open) return { invoice: open, periodStart: open.periodStart, periodEnd: open.periodEnd, amountMinor: open.totalMinor, listMinor: open.subtotalMinor, discountMinor: open.discountMinor };
  const amount = nextPeriodAmount(sub);
  return { invoice: null, periodStart: sub.currentPeriodEnd, periodEnd: addPeriod(sub.currentPeriodEnd, sub.interval, sub.intervalCount), amountMinor: amount, listMinor: sub.priceMinor, discountMinor: sub.priceMinor - amount };
}

async function renewFromCheckout(tx: Tx, deps: BillingDeps, co: Checkout, r: CheckoutResult, post: Post, fail: Fail): Promise<string | null> {
  const [sub] = co.subscriptionId ? await tx.select().from(subscriptions).where(eq(subscriptions.id, co.subscriptionId)).for('update') : [];
  if (!sub || sub.businessId !== co.businessId || !['ACTIVE', 'PAST_DUE'].includes(sub.status)) {
    await fail('This subscription can no longer be renewed, so the payment will be refunded.', { refund: r.payment });
    return null;
  }
  const t = await renewalTarget(tx, sub);
  if (t.amountMinor !== co.amountMinor) {
    await fail('The amount due changed while you were paying, so the payment will be refunded. Please try again.', { refund: r.payment });
    return null;
  }
  const plan = await planOf(tx, sub.planId);
  let invoiceId: string;
  if (t.invoice) {
    invoiceId = t.invoice.id;
    await tx.update(invoices).set({ status: 'PAID', paidAt: nowOf(deps), updatedAt: nowOf(deps) }).where(and(eq(invoices.id, invoiceId), eq(invoices.status, 'OPEN')));
  } else {
    const inserted = await tx
      .insert(invoices)
      .values({ businessId: sub.businessId, subscriptionId: sub.id, status: 'PAID', subtotalMinor: t.listMinor, discountMinor: t.discountMinor, totalMinor: t.amountMinor, periodStart: t.periodStart, periodEnd: t.periodEnd, description: `${plan.name} — 1 ${periodLabel(sub.interval, sub.intervalCount)}`, dueAt: t.periodStart, paidAt: nowOf(deps) })
      .onConflictDoNothing()
      .returning({ id: invoices.id });
    if (!inserted[0]) {
      await fail('This period is already paid, so the payment will be refunded.', { refund: r.payment });
      return null;
    }
    invoiceId = inserted[0].id;
    await tx.insert(invoiceItems).values({ invoiceId, kind: 'PLAN', description: plan.name, amountMinor: t.listMinor });
  }
  await tx.update(paymentTransactions).set({ invoiceId }).where(eq(paymentTransactions.checkoutId, co.id));
  await advanceToInvoice(tx, deps, sub, { periodStart: t.periodStart, periodEnd: t.periodEnd, discountMinor: t.discountMinor });
  await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'RENEWED', notify: true, planName: plan.name, amountMinor: t.amountMinor, date: t.periodEnd, actorUserId: co.createdByUserId });
  return sub.id;
}

async function paymentMethodFromCheckout(tx: Tx, deps: BillingDeps, co: Checkout, mandateId: string | null, r: CheckoutResult, post: Post, fail: Fail): Promise<string | null> {
  const [sub] = co.subscriptionId ? await tx.select().from(subscriptions).where(eq(subscriptions.id, co.subscriptionId)).for('update') : [];
  if (!sub || sub.businessId !== co.businessId || !['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'].includes(sub.status) || !mandateId) {
    await fail('This subscription has ended, so the new AutoPay was not set up.', { refund: r.payment, cancelMandate: r.mandate?.providerMandateRef ?? null });
    return null;
  }
  const now = nowOf(deps);
  if (sub.mandateId && sub.mandateId !== mandateId) {
    const [old] = await tx.select().from(paymentMandates).where(eq(paymentMandates.id, sub.mandateId));
    if (old && (old.status === 'ACTIVE' || old.status === 'PAUSED')) post.push(() => deps.provider.cancelMandate(old.providerMandateRef));
  }
  await tx
    .update(subscriptions)
    .set({ mandateId, recurring: true, paymentMethodType: co.methodType, cancelAtPeriodEnd: false, ...(sub.status === 'PAST_DUE' ? { nextRetryAt: now } : {}), updatedAt: now })
    .where(eq(subscriptions.id, sub.id));
  await tx.update(paymentMandates).set({ nextDebitAt: sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd }).where(eq(paymentMandates.id, mandateId));
  await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'MANDATE_CREATED', notify: true, amountMinor: co.recurringAmountMinor, date: sub.status === 'TRIALING' ? sub.trialEndsAt : sub.currentPeriodEnd, detail: co.methodType, actorUserId: co.createdByUserId });
  return sub.id;
}

/** Moves a subscription onto a paid period (idempotent: an already-advanced subscription is left alone). */
async function advanceToInvoice(tx: Tx, deps: BillingDeps, sub: Sub, inv: { periodStart: Date; periodEnd: Date; discountMinor: number }) {
  if (sub.currentPeriodEnd > inv.periodStart && sub.status === 'ACTIVE') return;
  const now = nowOf(deps);
  await tx
    .update(subscriptions)
    .set({
      status: setStatus(sub, 'ACTIVE'),
      currentPeriodStart: inv.periodStart,
      currentPeriodEnd: inv.periodEnd,
      pastDueSince: null,
      retryAttempts: 0,
      nextRetryAt: null,
      discountCyclesRemaining: inv.discountMinor > 0 && sub.discountCyclesRemaining != null ? Math.max(0, sub.discountCyclesRemaining - 1) : sub.discountCyclesRemaining,
      updatedAt: now,
    })
    .where(eq(subscriptions.id, sub.id));
  if (sub.mandateId) await tx.update(paymentMandates).set({ nextDebitAt: inv.periodEnd }).where(eq(paymentMandates.id, sub.mandateId));
}

/* ------------------------------------------------------ recurring charges */

export interface ChargeJob {
  transactionId: string;
  providerMandateRef: string;
  amountMinor: number;
  currency: string;
  idempotencyKey: string;
  description: string;
}

/** Inside a transaction: the OPEN invoice for a period (created once) and a PENDING transaction for this attempt. */
async function prepareCharge(tx: Tx, deps: BillingDeps, sub: Sub, period: { start: Date; end: Date }, attempt: number): Promise<ChargeJob | { done: true }> {
  const now = nowOf(deps);
  const plan = await planOf(tx, sub.planId);
  const amount = nextPeriodAmount(sub);
  const [m] = sub.mandateId ? await tx.select().from(paymentMandates).where(eq(paymentMandates.id, sub.mandateId)) : [];
  let [inv] = await tx.select().from(invoices).where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.periodStart, period.start)));
  if (!inv) {
    [inv] = await tx
      .insert(invoices)
      .values({ businessId: sub.businessId, subscriptionId: sub.id, status: 'OPEN', subtotalMinor: sub.priceMinor, discountMinor: sub.priceMinor - amount, totalMinor: amount, periodStart: period.start, periodEnd: period.end, description: `${plan.name} — 1 ${periodLabel(sub.interval, sub.intervalCount)}`, dueAt: period.start })
      .returning();
    await tx.insert(invoiceItems).values([
      { invoiceId: inv!.id, kind: 'PLAN', description: plan.name, amountMinor: sub.priceMinor },
      ...(sub.priceMinor - amount > 0 ? [{ invoiceId: inv!.id, kind: 'DISCOUNT', description: 'Offer discount', amountMinor: amount - sub.priceMinor }] : []),
    ]);
  }
  if (inv!.status === 'PAID') return { done: true };
  const key = `invoice:${inv!.id}:attempt:${attempt}`;
  await tx
    .insert(paymentTransactions)
    .values({ businessId: sub.businessId, subscriptionId: sub.id, invoiceId: inv!.id, mandateId: sub.mandateId, provider: deps.provider.name, kind: 'CHARGE', methodType: sub.paymentMethodType, amountMinor: inv!.totalMinor, currency: inv!.currency, status: 'PENDING', attempt, idempotencyKey: key })
    .onConflictDoNothing();
  const [t] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.idempotencyKey, key));
  if (t!.status !== 'PENDING' && t!.status !== 'CREATED') return { done: true };
  void now;
  return { transactionId: t!.id, providerMandateRef: m!.providerMandateRef, amountMinor: inv!.totalMinor, currency: inv!.currency, idempotencyKey: key, description: `${plan.name} — Equato subscription` };
}

/** Outside any transaction: debit the mandate, then apply the answer. Provider outages leave the transaction PENDING for reconciliation. */
export async function executeCharge(deps: BillingDeps, job: ChargeJob): Promise<PaymentStatus> {
  let result: PaymentResult;
  try {
    result = await deps.provider.chargeMandate({ providerMandateRef: job.providerMandateRef, amount: { amountMinor: job.amountMinor, currency: job.currency }, idempotencyKey: job.idempotencyKey, description: job.description });
  } catch (error) {
    if (error instanceof ProviderError && error.code !== 'UNAVAILABLE') {
      result = { providerPaymentRef: '', status: 'FAILED', amount: { amountMinor: job.amountMinor, currency: job.currency }, method: 'UPI', failureCode: error.code, failureMessage: error.message };
      return applyChargeResult(deps, job.transactionId, result);
    }
    deps.log?.warn({ err: (error as Error).message, transactionId: job.transactionId }, 'billing: charge not confirmed; reconciliation will retry with the same idempotency key');
    return 'PENDING';
  }
  return applyChargeResult(deps, job.transactionId, result);
}

/**
 * The answer to a recurring debit (synchronous result, `payment.updated`
 * webhook, or reconciliation). Final states never change again, so the
 * three paths can arrive in any order, any number of times.
 */
export async function applyChargeResult(deps: BillingDeps, transactionId: string, p: PaymentResult): Promise<PaymentStatus> {
  const post: Post = [];
  const status = await deps.db.transaction(async (tx) => {
    const [t] = await tx.select().from(paymentTransactions).where(eq(paymentTransactions.id, transactionId)).for('update');
    if (!t) throw new Error('transaction not found');
    if (t.status === p.status || !canTransitionPayment(t.status, p.status)) return t.status;
    if (p.status === 'SUCCEEDED' && (p.amount.amountMinor !== t.amountMinor || p.amount.currency !== t.currency)) {
      deps.log?.warn({ transactionId }, 'billing: charged amount differs from the invoice; not settling');
      await tx.update(paymentTransactions).set({ status: 'FAILED', failureCode: 'AMOUNT_MISMATCH', failureMessage: 'Charged amount did not match the invoice.', providerPaymentRef: t.providerPaymentRef ?? (p.providerPaymentRef || null), updatedAt: nowOf(deps) }).where(eq(paymentTransactions.id, t.id));
      post.push(() => deps.provider.refund({ providerPaymentRef: p.providerPaymentRef, amount: p.amount, idempotencyKey: `refund:txn:${t.id}`, reason: 'amount mismatch' }));
      return 'FAILED' as PaymentStatus;
    }
    const now = nowOf(deps);
    await tx
      .update(paymentTransactions)
      .set({ status: p.status, providerPaymentRef: t.providerPaymentRef ?? (p.providerPaymentRef || null), failureCode: p.failureCode ?? null, failureMessage: p.failureMessage ?? null, succeededAt: p.status === 'SUCCEEDED' ? now : null, updatedAt: now })
      .where(eq(paymentTransactions.id, t.id));
    if (!t.subscriptionId || !t.invoiceId) return p.status;
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, t.subscriptionId)).for('update');
    const [inv] = await tx.select().from(invoices).where(eq(invoices.id, t.invoiceId)).for('update');
    if (!sub || !inv) return p.status;
    const plan = await planOf(tx, sub.planId);

    if (p.status === 'SUCCEEDED') {
      if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') {
        // Money arrived after the subscription ended: give it back rather than revive it.
        post.push(() => deps.provider.refund({ providerPaymentRef: p.providerPaymentRef, amount: p.amount, idempotencyKey: `refund:txn:${t.id}`, reason: 'subscription already ended' }));
        return p.status;
      }
      if (inv.status !== 'PAID') await tx.update(invoices).set({ status: 'PAID', paidAt: now, updatedAt: now }).where(eq(invoices.id, inv.id));
      await advanceToInvoice(tx, deps, sub, { periodStart: inv.periodStart, periodEnd: inv.periodEnd, discountMinor: inv.discountMinor });
      await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'PAYMENT_SUCCEEDED', notify: true, amountMinor: t.amountMinor, planName: plan.name, date: inv.periodEnd, dedupeKey: `paid:${inv.id}` });
      return p.status;
    }

    if (p.status === 'FAILED') {
      const exhausted = t.attempt > BILLING_POLICY.retryScheduleDays.length;
      const mandateDead = p.failureCode === 'MANDATE_INACTIVE' || p.failureCode === 'NOT_FOUND';
      if (sub.status === 'CANCELLED' || sub.status === 'EXPIRED') return p.status;
      const since = sub.pastDueSince ?? now;
      if (exhausted) {
        await expireTx(tx, deps, sub, 'Payment kept failing after every retry.', post);
        await tx.update(invoices).set({ status: 'FAILED', updatedAt: now }).where(and(eq(invoices.id, inv.id), eq(invoices.status, 'OPEN')));
      } else {
        const next = mandateDead ? null : addDays(since, BILLING_POLICY.retryScheduleDays[t.attempt - 1]!);
        await tx
          .update(subscriptions)
          .set({ status: setStatus(sub, 'PAST_DUE'), pastDueSince: since, retryAttempts: t.attempt, nextRetryAt: next, ...(mandateDead ? { recurring: false } : {}), updatedAt: now })
          .where(eq(subscriptions.id, sub.id));
        await recordEvent(tx, deps, {
          businessId: sub.businessId,
          subscriptionId: sub.id,
          kind: 'PAYMENT_FAILED',
          notify: true,
          amountMinor: t.amountMinor,
          planName: plan.name,
          date: next ?? addDays(since, BILLING_POLICY.graceDays),
          detail: mandateDead ? 'AutoPay is no longer active — renew from Subscription & Billing.' : p.failureMessage ?? 'The payment was declined.',
          dedupeKey: `failed:${t.id}`,
        });
      }
    }
    if (p.status === 'REFUNDED') {
      await tx.update(invoices).set({ status: 'REFUNDED', updatedAt: now }).where(eq(invoices.id, inv.id));
      await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'REFUNDED', notify: true, amountMinor: t.amountMinor, dedupeKey: `refunded:${t.id}` });
    }
    return p.status;
  });
  for (const f of post) await f().catch((error) => deps.log?.warn({ err: (error as Error).message, transactionId }, 'billing: follow-up provider call failed'));
  return status;
}

async function expireTx(tx: Tx, deps: BillingDeps, sub: Sub, reason: string, post: Post) {
  const now = nowOf(deps);
  await tx.update(subscriptions).set({ status: setStatus(sub, 'EXPIRED'), endedAt: now, nextRetryAt: null, cancelReason: reason, updatedAt: now }).where(eq(subscriptions.id, sub.id));
  await cancelMandateLater(tx, deps, sub.mandateId, post);
  await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'EXPIRED', notify: true, detail: reason });
}

/** Revoke the provider-side mandate after commit, so a CANCELLED/EXPIRED row never leaves a live AutoPay behind. */
export async function cancelMandateLater(tx: Tx, deps: BillingDeps, mandateId: string | null, post: Post) {
  if (!mandateId) return;
  const [m] = await tx.select().from(paymentMandates).where(eq(paymentMandates.id, mandateId)).for('update');
  if (!m || (m.status !== 'ACTIVE' && m.status !== 'PAUSED' && m.status !== 'PENDING' && m.status !== 'CREATED')) return;
  post.push(async () => {
    const r = await deps.provider.cancelMandate(m.providerMandateRef);
    await deps.db.update(paymentMandates).set({ status: r.status, cancelledAt: r.status === 'CANCELLED' ? new Date() : null, updatedAt: new Date() }).where(eq(paymentMandates.id, m.id));
  });
}

/* ------------------------------------------------------- scheduled cycle */

type Claimed = { sub: Sub; job: ChargeJob | null; post: Post };

/** Lock one subscription for a cycle step; skip it if another worker holds it. */
async function claim(deps: BillingDeps, id: string, step: (tx: Tx, sub: Sub, post: Post) => Promise<ChargeJob | null>, where: (sub: Sub, now: Date) => boolean): Promise<Claimed | null> {
  const post: Post = [];
  const r = await deps.db.transaction(async (tx) => {
    const [sub] = await tx.select().from(subscriptions).where(eq(subscriptions.id, id)).for('update', { skipLocked: true });
    if (!sub || !where(sub, nowOf(deps))) return null;
    const job = await step(tx, sub, post);
    return { sub, job, post };
  });
  if (r) for (const f of r.post) await f().catch((error) => deps.log?.warn({ err: (error as Error).message, subscriptionId: id }, 'billing: follow-up provider call failed'));
  return r;
}

async function mandateActive(tx: Tx, mandateId: string | null) {
  if (!mandateId) return false;
  const [m] = await tx.select({ status: paymentMandates.status }).from(paymentMandates).where(eq(paymentMandates.id, mandateId));
  return m?.status === 'ACTIVE';
}

/** Trial over: charge the mandate for the first paid period, or expire. */
export async function endTrial(deps: BillingDeps, id: string) {
  const r = await claim(
    deps,
    id,
    async (tx, sub, post) => {
      const plan = await planOf(tx, sub.planId);
      const start = sub.trialEndsAt ?? sub.currentPeriodEnd;
      const end = addPeriod(start, sub.interval, sub.intervalCount);
      const amount = nextPeriodAmount(sub);
      if (amount === 0) {
        await tx.update(subscriptions).set({ status: setStatus(sub, 'ACTIVE'), currentPeriodStart: start, currentPeriodEnd: end, updatedAt: nowOf(deps) }).where(eq(subscriptions.id, sub.id));
        await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'ACTIVATED', notify: true, planName: plan.name, date: end });
        return null;
      }
      if (sub.recurring && (await mandateActive(tx, sub.mandateId))) {
        const job = await prepareCharge(tx, deps, sub, { start, end }, 1);
        return 'done' in job ? null : job;
      }
      await expireTx(tx, deps, sub, 'Your free trial ended. Choose a plan to keep going.', post);
      return null;
    },
    (sub, now) => sub.status === 'TRIALING' && !!sub.trialEndsAt && sub.trialEndsAt <= now,
  );
  if (r?.job) return executeCharge(deps, r.job);
  return r ? 'done' : 'skipped';
}

/** Period over: cancel (if asked), apply a scheduled plan change, then charge / ask to renew. */
export async function renew(deps: BillingDeps, id: string) {
  const r = await claim(
    deps,
    id,
    async (tx, sub0, post) => {
      const now = nowOf(deps);
      let sub = sub0;
      if (sub.cancelAtPeriodEnd) {
        await tx.update(subscriptions).set({ status: setStatus(sub, 'CANCELLED'), endedAt: sub.currentPeriodEnd, updatedAt: now }).where(eq(subscriptions.id, sub.id));
        await cancelMandateLater(tx, deps, sub.mandateId, post);
        await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'CANCELLED', notify: true, detail: 'Your subscription ended as you asked.' });
        return null;
      }
      if (sub.pendingPlanId) {
        const next = await planOf(tx, sub.pendingPlanId);
        const [updated] = await tx
          .update(subscriptions)
          .set({ planId: next.id, priceMinor: next.priceMinor, currency: next.currency, interval: next.interval, intervalCount: next.intervalCount, offerId: null, discountedPriceMinor: null, discountCyclesRemaining: null, pendingPlanId: null, updatedAt: now })
          .where(eq(subscriptions.id, sub.id))
          .returning();
        sub = updated!;
        await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'PLAN_CHANGED', notify: true, planName: next.name, amountMinor: next.priceMinor });
      }
      const start = sub.currentPeriodEnd;
      const end = addPeriod(start, sub.interval, sub.intervalCount);
      const amount = nextPeriodAmount(sub);
      if (amount === 0) {
        await tx.update(subscriptions).set({ currentPeriodStart: start, currentPeriodEnd: end, discountCyclesRemaining: sub.discountCyclesRemaining != null && sub.discountedPriceMinor != null && sub.discountedPriceMinor < sub.priceMinor ? Math.max(0, sub.discountCyclesRemaining - 1) : sub.discountCyclesRemaining, updatedAt: now }).where(eq(subscriptions.id, sub.id));
        await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'RENEWED', notify: false, date: end });
        return null;
      }
      if (sub.recurring && (await mandateActive(tx, sub.mandateId))) {
        const job = await prepareCharge(tx, deps, sub, { start, end }, 1);
        return 'done' in job ? null : job;
      }
      // Pay-as-you-go: an unpaid invoice and a grace period to renew.
      const plan = await planOf(tx, sub.planId);
      const existing = await tx.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.periodStart, start)));
      if (!existing.length) {
        const [inv] = await tx
          .insert(invoices)
          .values({ businessId: sub.businessId, subscriptionId: sub.id, status: 'OPEN', subtotalMinor: sub.priceMinor, discountMinor: sub.priceMinor - amount, totalMinor: amount, periodStart: start, periodEnd: end, description: `${plan.name} — 1 ${periodLabel(sub.interval, sub.intervalCount)}`, dueAt: addDays(start, BILLING_POLICY.graceDays) })
          .returning({ id: invoices.id });
        await tx.insert(invoiceItems).values({ invoiceId: inv!.id, kind: 'PLAN', description: plan.name, amountMinor: sub.priceMinor });
      }
      await tx.update(subscriptions).set({ status: setStatus(sub, 'PAST_DUE'), pastDueSince: start, nextRetryAt: null, updatedAt: now }).where(eq(subscriptions.id, sub.id));
      await recordEvent(tx, deps, { businessId: sub.businessId, subscriptionId: sub.id, kind: 'PAST_DUE', notify: true, amountMinor: amount, planName: plan.name, date: addDays(start, BILLING_POLICY.graceDays), dedupeKey: `pastdue:${sub.id}:${start.toISOString()}` });
      return null;
    },
    (sub, now) => sub.status === 'ACTIVE' && sub.currentPeriodEnd <= now,
  );
  if (r?.job) return executeCharge(deps, r.job);
  return r ? 'done' : 'skipped';
}

/** A scheduled retry of a failed AutoPay debit. */
export async function retry(deps: BillingDeps, id: string) {
  const r = await claim(
    deps,
    id,
    async (tx, sub) => {
      const [inv] = await tx.select().from(invoices).where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, 'OPEN'))).orderBy(desc(invoices.periodStart)).limit(1);
      if (!inv || !sub.recurring || !(await mandateActive(tx, sub.mandateId))) {
        await tx.update(subscriptions).set({ nextRetryAt: null, updatedAt: nowOf(deps) }).where(eq(subscriptions.id, sub.id));
        return null;
      }
      const job = await prepareCharge(tx, deps, sub, { start: inv.periodStart, end: inv.periodEnd }, sub.retryAttempts + 1);
      return 'done' in job ? null : job;
    },
    (sub, now) => sub.status === 'PAST_DUE' && !!sub.nextRetryAt && sub.nextRetryAt <= now,
  );
  if (r?.job) return executeCharge(deps, r.job);
  return r ? 'done' : 'skipped';
}

/** Grace over with nothing paid (and no retry pending): the subscription expires. */
export async function expireIfGraceOver(deps: BillingDeps, id: string) {
  const r = await claim(
    deps,
    id,
    async (tx, sub, post) => {
      const pending = await tx.select({ id: paymentTransactions.id }).from(paymentTransactions).where(and(eq(paymentTransactions.subscriptionId, sub.id), inArray(paymentTransactions.status, ['CREATED', 'PENDING', 'AUTHORIZED']))).limit(1);
      if (pending.length) return null; // a payment is still in flight
      await expireTx(tx, deps, sub, 'The renewal was not paid in time.', post);
      await tx.update(invoices).set({ status: 'FAILED', updatedAt: nowOf(deps) }).where(and(eq(invoices.subscriptionId, sub.id), eq(invoices.status, 'OPEN')));
      return null;
    },
    (sub, now) => sub.status === 'PAST_DUE' && !sub.nextRetryAt && !!sub.pastDueSince && addDays(sub.pastDueSince, BILLING_POLICY.graceDays) <= now,
  );
  return r ? 'done' : 'skipped';
}

/** One pass of everything due. Each step claims rows with SKIP LOCKED, so replicas share the work. */
export async function runBillingCycle(deps: BillingDeps, limit = 200) {
  const now = nowOf(deps);
  const ids = async (where: ReturnType<typeof and>) => (await deps.db.select({ id: subscriptions.id }).from(subscriptions).where(where).limit(limit)).map((r) => r.id);
  const out = { trials: 0, renewals: 0, retries: 0, expired: 0 };
  for (const id of await ids(and(eq(subscriptions.status, 'TRIALING'), lte(subscriptions.trialEndsAt, now)))) if ((await endTrial(deps, id)) !== 'skipped') out.trials++;
  for (const id of await ids(and(eq(subscriptions.status, 'ACTIVE'), lte(subscriptions.currentPeriodEnd, now)))) if ((await renew(deps, id)) !== 'skipped') out.renewals++;
  for (const id of await ids(and(eq(subscriptions.status, 'PAST_DUE'), lte(subscriptions.nextRetryAt, now)))) if ((await retry(deps, id)) !== 'skipped') out.retries++;
  for (const id of await ids(and(eq(subscriptions.status, 'PAST_DUE'), isNull(subscriptions.nextRetryAt), lte(subscriptions.pastDueSince, addDays(now, -BILLING_POLICY.graceDays)))))
    if ((await expireIfGraceOver(deps, id)) !== 'skipped') out.expired++;
  return out;
}

/** Renewal and trial-ending reminders, once per period (dedupe keys). */
export async function sendReminders(deps: BillingDeps, limit = 500) {
  const now = nowOf(deps);
  const soon = addDays(now, BILLING_POLICY.reminderDaysBefore);
  let sent = 0;
  const renewing = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.status, 'ACTIVE'), eq(subscriptions.cancelAtPeriodEnd, false), gt(subscriptions.currentPeriodEnd, now), lte(subscriptions.currentPeriodEnd, soon)))
    .limit(limit);
  for (const sub of renewing) {
    await deps.db.transaction(async (tx) => {
      const plan = await planOf(tx, sub.pendingPlanId ?? sub.planId);
      const amount = sub.pendingPlanId ? plan.priceMinor : nextPeriodAmount(sub);
      if (amount === 0) return;
      const ok = await recordEvent(tx, deps, {
        businessId: sub.businessId,
        subscriptionId: sub.id,
        kind: 'RENEWAL_REMINDER',
        notify: true,
        amountMinor: amount,
        planName: plan.name,
        date: sub.currentPeriodEnd,
        detail: sub.recurring ? 'AutoPay will charge this automatically.' : 'Renew from Subscription & Billing to keep your plan.',
        dedupeKey: `reminder:${sub.id}:${sub.currentPeriodEnd.toISOString()}`,
      });
      if (ok) sent++;
    });
  }
  const trials = await deps.db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.status, 'TRIALING'), gt(subscriptions.trialEndsAt, now), lte(subscriptions.trialEndsAt, soon)))
    .limit(limit);
  for (const sub of trials) {
    await deps.db.transaction(async (tx) => {
      const plan = await planOf(tx, sub.planId);
      const ok = await recordEvent(tx, deps, {
        businessId: sub.businessId,
        subscriptionId: sub.id,
        kind: 'TRIAL_ENDING',
        notify: true,
        amountMinor: nextPeriodAmount(sub),
        planName: plan.name,
        date: sub.trialEndsAt,
        detail: sub.recurring ? `AutoPay will charge ${inr(nextPeriodAmount(sub), sub.currency)} when the trial ends.` : 'Choose a plan before the trial ends to keep going.',
        dedupeKey: `trial-ending:${sub.id}`,
      });
      if (ok) sent++;
    });
  }
  return { sent };
}

/* ----------------------------------------------------------- reconciliation */

/** A `payment.updated` webhook or a stale PENDING transaction: read the provider back and apply. */
export async function syncPayment(deps: BillingDeps, providerPaymentRef: string) {
  const [t] = await deps.db.select().from(paymentTransactions).where(and(eq(paymentTransactions.provider, deps.provider.name), eq(paymentTransactions.providerPaymentRef, providerPaymentRef))).limit(1);
  if (!t) return 'unknown';
  if (t.checkoutId && !t.invoiceId && !t.subscriptionId) return 'checkout payment (settled through its checkout)';
  return applyChargeResult(deps, t.id, await deps.provider.retrievePayment(providerPaymentRef));
}

/** A `checkout.updated` webhook or a stale OPEN checkout. */
export async function syncCheckout(deps: BillingDeps, providerCheckoutRef: string) {
  const [co] = await deps.db.select().from(billingCheckouts).where(and(eq(billingCheckouts.provider, deps.provider.name), eq(billingCheckouts.providerCheckoutRef, providerCheckoutRef))).limit(1);
  if (!co) return null;
  if (co.status !== 'OPEN') return { status: co.status, subscriptionId: co.subscriptionId, changed: false, failureReason: co.failureReason } satisfies CheckoutOutcome;
  return applyCheckoutResult(deps, co.id, await deps.provider.retrieveCheckout(providerCheckoutRef));
}

/** A `mandate.updated` webhook: the owner (or their bank) changed the mandate outside Equato. */
export async function syncMandate(deps: BillingDeps, providerMandateRef: string) {
  const [m] = await deps.db.select().from(paymentMandates).where(and(eq(paymentMandates.provider, deps.provider.name), eq(paymentMandates.providerMandateRef, providerMandateRef))).limit(1);
  if (!m) return 'unknown';
  const r = await deps.provider.retrieveMandate(providerMandateRef);
  if (r.status === m.status) return r.status;
  await deps.db.transaction(async (tx) => {
    const now = nowOf(deps);
    await tx
      .update(paymentMandates)
      .set({ status: r.status, displayLabel: r.displayLabel ?? m.displayLabel, cancelledAt: r.status === 'CANCELLED' ? now : m.cancelledAt, updatedAt: now })
      .where(eq(paymentMandates.id, m.id));
    if (r.status === 'CANCELLED' || r.status === 'EXPIRED' || r.status === 'FAILED') {
      const users = await tx
        .update(subscriptions)
        .set({ recurring: false, updatedAt: now })
        .where(and(eq(subscriptions.mandateId, m.id), inArray(subscriptions.status, ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'])))
        .returning({ id: subscriptions.id, businessId: subscriptions.businessId });
      for (const s of users) {
        await recordEvent(tx, deps, { businessId: s.businessId, subscriptionId: s.id, kind: 'MANDATE_CANCELLED', notify: true, detail: 'AutoPay was turned off. Renew manually or set up AutoPay again from Subscription & Billing.', dedupeKey: `mandate-off:${m.id}:${r.status}` });
      }
    }
  });
  return r.status;
}

/** Stale OPEN checkouts and PENDING charges: ask the provider (webhooks can be lost). */
export async function reconcile(deps: BillingDeps, limit = 200) {
  const now = nowOf(deps);
  const out = { checkouts: 0, payments: 0, recharged: 0 };
  const staleCheckouts = await deps.db
    .select({ id: billingCheckouts.id, ref: billingCheckouts.providerCheckoutRef })
    .from(billingCheckouts)
    .where(and(eq(billingCheckouts.status, 'OPEN'), eq(billingCheckouts.provider, deps.provider.name), isNotNull(billingCheckouts.providerCheckoutRef), lt(billingCheckouts.updatedAt, new Date(now.getTime() - 2 * 60_000))))
    .limit(limit);
  for (const c of staleCheckouts) {
    try {
      const r = await syncCheckout(deps, c.ref!);
      if (r?.changed) out.checkouts++;
    } catch (error) {
      deps.log?.warn({ err: (error as Error).message, checkoutId: c.id }, 'billing: checkout reconcile failed');
    }
  }
  const stalePayments = await deps.db
    .select()
    .from(paymentTransactions)
    .where(and(inArray(paymentTransactions.status, ['CREATED', 'PENDING', 'AUTHORIZED']), eq(paymentTransactions.provider, deps.provider.name), lt(paymentTransactions.updatedAt, new Date(now.getTime() - 5 * 60_000))))
    .limit(limit);
  for (const t of stalePayments) {
    try {
      if (t.providerPaymentRef) {
        await syncPayment(deps, t.providerPaymentRef);
        out.payments++;
      } else if (t.mandateId && t.invoiceId) {
        // The charge call never confirmed: repeat it with the SAME idempotency key — the provider returns the original.
        const [m] = await deps.db.select().from(paymentMandates).where(eq(paymentMandates.id, t.mandateId));
        if (m) {
          await executeCharge(deps, { transactionId: t.id, providerMandateRef: m.providerMandateRef, amountMinor: t.amountMinor, currency: t.currency, idempotencyKey: t.idempotencyKey, description: 'Equato subscription' });
          out.recharged++;
        }
      }
    } catch (error) {
      deps.log?.warn({ err: (error as Error).message, transactionId: t.id }, 'billing: payment reconcile failed');
    }
  }
  // Offers past their end date stop showing as active.
  await deps.db.update(subscriptionOffers).set({ isActive: false, updatedAt: now }).where(and(eq(subscriptionOffers.isActive, true), lte(subscriptionOffers.endsAt, now)));
  return out;
}

export { liveSubscription };

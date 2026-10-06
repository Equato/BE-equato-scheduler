/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { and, count, eq, gt, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import type { Database } from '../../db/client.js';
import {
  businesses,
  invoices,
  subscriptionOfferBusinesses,
  subscriptionOfferPlans,
  subscriptionOffers,
  subscriptions,
  subscriptionTrials,
} from '../../db/schema/index.js';
import { BILLING_POLICY } from '../domain/billing.js';
import { discountedPrice } from './pricing.js';

export type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];
export type Exec = Database | Tx;

type OfferRow = typeof subscriptionOffers.$inferSelect;
type PlanRow = { id: string; priceMinor: number; trialDays: number; eligibleCategoryIds: string[]; status: string };

/**
 * Server-side eligibility. The browser only ever sends a plan id and,
 * optionally, a code — whether an offer applies, what it is worth and whether
 * a trial is allowed are all decided here, from the database.
 */

export type OfferCheck = { ok: true; offer: OfferRow } | { ok: false; reason: string };

/** Has this business ever paid for a subscription? (new-subscriber offers, trial abuse) */
export async function hasPaidBefore(db: Exec, businessId: string): Promise<boolean> {
  const [r] = await db.select({ n: count() }).from(invoices).where(and(eq(invoices.businessId, businessId), eq(invoices.status, 'PAID'), gt(invoices.totalMinor, 0)));
  return (r?.n ?? 0) > 0;
}

async function offerUsable(db: Exec, offer: OfferRow, businessId: string, planId: string, now: Date): Promise<string | null> {
  if (!offer.isActive) return 'This offer is no longer available.';
  if (offer.startsAt > now) return 'This offer has not started yet.';
  if (offer.endsAt && offer.endsAt <= now) return 'This offer has ended.';
  if (offer.maxRedemptions != null && offer.redemptionCount >= offer.maxRedemptions) return 'This offer has been fully used.';
  const plans = await db.select({ planId: subscriptionOfferPlans.planId }).from(subscriptionOfferPlans).where(eq(subscriptionOfferPlans.offerId, offer.id));
  if (plans.length && !plans.some((p) => p.planId === planId)) return 'This offer does not apply to this plan.';
  const targeted = await db.select({ businessId: subscriptionOfferBusinesses.businessId }).from(subscriptionOfferBusinesses).where(eq(subscriptionOfferBusinesses.offerId, offer.id));
  if (targeted.length && !targeted.some((t) => t.businessId === businessId)) return 'This offer is not available for this business.';
  const [used] = await db
    .select({ n: count() })
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, businessId), eq(subscriptions.offerId, offer.id)));
  if ((used?.n ?? 0) >= offer.maxPerBusiness) return 'You have already used this offer.';
  if (offer.newSubscribersOnly && (await hasPaidBefore(db, businessId))) return 'This offer is for new subscribers only.';
  return null;
}

/** A typed code, or — without one — the best automatic offer for the plan (or none). */
export async function resolveOffer(db: Exec, input: { businessId: string; plan: PlanRow; code: string | null | undefined; now: Date }): Promise<OfferCheck | null> {
  const code = input.code?.trim().toUpperCase();
  if (code) {
    if (!/^[A-Z0-9_-]{3,32}$/.test(code)) return { ok: false, reason: 'That code is not valid.' };
    const [offer] = await db.select().from(subscriptionOffers).where(eq(subscriptionOffers.code, code)).limit(1);
    // One message for "no such code" and "not yours", so codes can't be enumerated.
    if (!offer) return { ok: false, reason: 'That code is not valid.' };
    const why = await offerUsable(db, offer, input.businessId, input.plan.id, input.now);
    return why ? { ok: false, reason: why } : { ok: true, offer };
  }
  const autos = await db
    .select()
    .from(subscriptionOffers)
    .where(
      and(
        eq(subscriptionOffers.autoApply, true),
        eq(subscriptionOffers.isActive, true),
        lte(subscriptionOffers.startsAt, input.now),
        or(isNull(subscriptionOffers.endsAt), gt(subscriptionOffers.endsAt, input.now)),
      ),
    )
    .limit(50);
  let best: { offer: OfferRow; price: number } | null = null;
  for (const offer of autos) {
    if (await offerUsable(db, offer, input.businessId, input.plan.id, input.now)) continue;
    const price = discountedPrice(input.plan.priceMinor, offer);
    if (!best || price < best.price) best = { offer, price };
  }
  return best ? { ok: true, offer: best.offer } : null;
}

export type TrialCheck = { eligible: true } | { eligible: false; reason: string };

/**
 * Trial abuse rules: one trial per business, ever; not after a paid
 * subscription; a live (approved) business only; and at most N per owner per
 * rolling year, so registering throwaway businesses doesn't farm trials.
 */
export async function trialEligibility(db: Exec, input: { businessId: string; ownerId: string; plan: PlanRow; now: Date }): Promise<TrialCheck> {
  if (input.plan.trialDays <= 0) return { eligible: false, reason: 'This plan has no free trial.' };
  const [b] = await db.select({ status: businesses.publicationStatus }).from(businesses).where(eq(businesses.id, input.businessId)).limit(1);
  if (b?.status !== 'APPROVED') return { eligible: false, reason: 'A free trial starts once your business is approved.' };
  const [t] = await db.select({ id: subscriptionTrials.id }).from(subscriptionTrials).where(eq(subscriptionTrials.businessId, input.businessId)).limit(1);
  if (t) return { eligible: false, reason: 'This business has already used its free trial.' };
  const [prior] = await db.select({ n: count() }).from(subscriptions).where(eq(subscriptions.businessId, input.businessId));
  if ((prior?.n ?? 0) > 0) return { eligible: false, reason: 'Free trials are for a first subscription only.' };
  const yearAgo = new Date(input.now.getTime() - 365 * 86_400_000);
  const [mine] = await db
    .select({ n: count() })
    .from(subscriptionTrials)
    .where(and(eq(subscriptionTrials.ownerId, input.ownerId), gt(subscriptionTrials.startedAt, yearAgo)));
  if ((mine?.n ?? 0) >= BILLING_POLICY.maxTrialsPerOwnerPerYear) return { eligible: false, reason: 'You have used all the free trials available to your account this year.' };
  return { eligible: true };
}

/** Plans a business may subscribe to: ACTIVE, and (if the plan restricts categories) in one of them. */
export function planOpenTo(plan: PlanRow, business: { categoryId: string }): boolean {
  return plan.status === 'ACTIVE' && (plan.eligibleCategoryIds.length === 0 || plan.eligibleCategoryIds.includes(business.categoryId));
}

/** Live subscription of a business, if any (TRIALING / ACTIVE / PAST_DUE / PAUSED). */
export async function liveSubscription(db: Exec, businessId: string, opts: { forUpdate?: boolean } = {}) {
  const q = db
    .select()
    .from(subscriptions)
    .where(and(eq(subscriptions.businessId, businessId), inArray(subscriptions.status, ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'])))
    .limit(1);
  const [row] = opts.forUpdate ? await q.for('update') : await q;
  return row ?? null;
}

export const sqlNow = sql`now()`;

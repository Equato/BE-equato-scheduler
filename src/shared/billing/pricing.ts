/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { BillingInterval, DiscountType } from '../domain/billing.js';

/**
 * Pure money maths for subscriptions. Every amount a business pays is
 * computed HERE, on the server, from the plan and offer rows — never taken
 * from the browser. Integer paise throughout; no floating point reaches a
 * stored amount.
 */

export interface PlanTerms {
  priceMinor: number;
  currency: string;
  interval: BillingInterval;
  intervalCount: number;
  trialDays: number;
}

export interface OfferTerms {
  discountType: DiscountType;
  discountValue: number;
  /** Periods the discount lasts; null = for as long as the subscription runs. */
  durationCycles: number | null;
}

/** The per-period price while an offer applies (never negative, never above list). */
export function discountedPrice(priceMinor: number, offer: OfferTerms | null): number {
  if (!offer) return priceMinor;
  let p: number;
  switch (offer.discountType) {
    case 'PERCENT': {
      const off = (priceMinor * Math.min(100, Math.max(0, offer.discountValue))) / 100;
      // Whole-rupee prices get whole-rupee discounts (₹999 − 20% = ₹799, not ₹799.20).
      p = priceMinor - (priceMinor % 100 === 0 ? Math.round(off / 100) * 100 : Math.round(off));
      break;
    }
    case 'AMOUNT_OFF':
      p = priceMinor - offer.discountValue;
      break;
    case 'FIXED_PRICE':
      p = offer.discountValue;
      break;
  }
  return Math.min(priceMinor, Math.max(0, Math.trunc(p)));
}

export interface Quote {
  currency: string;
  /** List price of one period. */
  listAmountMinor: number;
  /** Discount on the amount due now. */
  discountMinor: number;
  /** Charged at checkout (0 when a trial starts first). */
  dueNowMinor: number;
  /** Price per period while the offer lasts. */
  discountedPeriodMinor: number;
  /** Periods at the discounted price (null = all). */
  discountCycles: number | null;
  /** The most any single recurring debit can be — the mandate's maximum. */
  mandateMaxMinor: number;
  trialDays: number;
}

export function quote(plan: PlanTerms, offer: OfferTerms | null, opts: { withTrial: boolean }): Quote {
  const discounted = discountedPrice(plan.priceMinor, offer);
  const trialDays = opts.withTrial ? plan.trialDays : 0;
  const dueNow = trialDays > 0 ? 0 : discounted;
  return {
    currency: plan.currency,
    listAmountMinor: plan.priceMinor,
    discountMinor: trialDays > 0 ? 0 : plan.priceMinor - discounted,
    dueNowMinor: dueNow,
    discountedPeriodMinor: discounted,
    discountCycles: offer ? offer.durationCycles : null,
    mandateMaxMinor: plan.priceMinor,
    trialDays,
  };
}

/** What the NEXT period costs, given how many discounted periods remain. */
export function nextPeriodAmount(sub: { priceMinor: number; discountedPriceMinor: number | null; discountCyclesRemaining: number | null; offerId: string | null }): number {
  if (sub.offerId && sub.discountedPriceMinor != null && (sub.discountCyclesRemaining == null || sub.discountCyclesRemaining > 0)) return sub.discountedPriceMinor;
  return sub.priceMinor;
}

/**
 * Calendar period arithmetic: Jan 31 + 1 month = Feb 28/29 (clamped), not
 * Mar 3. Computed in UTC on the instant; periods run end-to-start, so no
 * day is ever billed twice or skipped.
 */
export function addPeriod(from: Date, interval: BillingInterval, count: number): Date {
  const months = interval === 'YEAR' ? 12 * count : count;
  const d = new Date(from.getTime());
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + months);
  const lastDay = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, lastDay));
  return d;
}

export const addDays = (from: Date, days: number) => new Date(from.getTime() + days * 86_400_000);

/** "₹1,299" / "₹99.50" — for text the owner reads (consent, invoices, notifications). */
export function inr(minor: number, currency = 'INR'): string {
  const sym = currency === 'INR' ? '₹' : `${currency} `;
  const whole = minor % 100 === 0;
  return `${sym}${(minor / 100).toLocaleString('en-IN', { minimumFractionDigits: whole ? 0 : 2, maximumFractionDigits: 2 })}`;
}

export function periodLabel(interval: BillingInterval, count: number): string {
  if (interval === 'YEAR') return count === 1 ? 'year' : `${count} years`;
  if (count === 1) return 'month';
  if (count === 3) return 'quarter (3 months)';
  if (count === 6) return '6 months';
  return `${count} months`;
}

/**
 * The exact sentence the owner agrees to. Recurring and one-time use
 * deliberately different wording so AutoPay is never mistaken for a single
 * payment (and vice versa). Stored with the checkout and the mandate.
 */
export function consentText(input: {
  recurring: boolean;
  businessName: string;
  planName: string;
  q: Quote;
  interval: BillingInterval;
  intervalCount: number;
  firstChargeAt: Date;
}): string {
  const per = periodLabel(input.interval, input.intervalCount);
  const when = input.firstChargeAt.toLocaleDateString('en-IN', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Asia/Kolkata' });
  if (input.recurring) {
    const intro =
      input.q.discountedPeriodMinor !== input.q.listAmountMinor
        ? input.q.discountCycles
          ? ` ${inr(input.q.discountedPeriodMinor, input.q.currency)} for the first ${input.q.discountCycles} ${input.q.discountCycles === 1 ? 'period' : 'periods'}, then`
          : ` ${inr(input.q.discountedPeriodMinor, input.q.currency)} instead of`
        : '';
    return `You are authorizing recurring payments of${intro} ${inr(input.q.listAmountMinor, input.q.currency)} every ${per} to Equato for ${input.businessName} (${input.planName}), starting ${when}, until you cancel. You can cancel AutoPay anytime from Subscription & Billing.`;
  }
  return `You are making a ONE-TIME payment of ${inr(input.q.dueNowMinor, input.q.currency)} for one ${per} of ${input.planName} for ${input.businessName}. Nothing will be charged automatically — renew before the period ends to continue.`;
}

/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Billing vocabulary — business subscriptions only (shoppers and staff never
 * have one). The Postgres enums in db/schema/_enums.ts mirror these; the
 * enum-parity test stops them drifting. See SUBSCRIPTIONS.md.
 */

/** Where a plan is in its life. Plans are never deleted once anyone subscribed. */
export const PlanStatus = {
  DRAFT: 'DRAFT',
  ACTIVE: 'ACTIVE',
  INACTIVE: 'INACTIVE',
  ARCHIVED: 'ARCHIVED',
} as const;
export type PlanStatus = (typeof PlanStatus)[keyof typeof PlanStatus];

export const PlanVisibility = { PUBLIC: 'PUBLIC', HIDDEN: 'HIDDEN' } as const;
export type PlanVisibility = (typeof PlanVisibility)[keyof typeof PlanVisibility];

/** A period is `interval_count` × this unit (1 × MONTH, 3 × MONTH, 1 × YEAR …). */
export const BillingInterval = { MONTH: 'MONTH', YEAR: 'YEAR' } as const;
export type BillingInterval = (typeof BillingInterval)[keyof typeof BillingInterval];

export const SubscriptionStatus = {
  TRIALING: 'TRIALING',
  ACTIVE: 'ACTIVE',
  PAST_DUE: 'PAST_DUE',
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
  EXPIRED: 'EXPIRED',
} as const;
export type SubscriptionStatus = (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/** A business has at most ONE subscription in these states (a partial unique index enforces it). */
export const LIVE_SUBSCRIPTION_STATUSES: readonly SubscriptionStatus[] = ['TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED'];

/**
 * Allowed subscription transitions. CANCELLED and EXPIRED are terminal — a
 * returning business starts a NEW subscription, so history is never rewritten.
 */
export const SUBSCRIPTION_TRANSITIONS: Readonly<Record<SubscriptionStatus, readonly SubscriptionStatus[]>> = {
  TRIALING: ['ACTIVE', 'PAST_DUE', 'CANCELLED', 'EXPIRED'],
  ACTIVE: ['ACTIVE', 'PAST_DUE', 'PAUSED', 'CANCELLED', 'EXPIRED'],
  PAST_DUE: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  PAUSED: ['ACTIVE', 'CANCELLED', 'EXPIRED'],
  CANCELLED: [],
  EXPIRED: [],
};
export const canTransitionSubscription = (from: SubscriptionStatus, to: SubscriptionStatus) => SUBSCRIPTION_TRANSITIONS[from].includes(to);

export const PaymentStatus = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  AUTHORIZED: 'AUTHORIZED',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
  REFUNDED: 'REFUNDED',
  EXPIRED: 'EXPIRED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

/** Final payment states never move again — except a success that is later refunded. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  CREATED: ['PENDING', 'AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  PENDING: ['AUTHORIZED', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  AUTHORIZED: ['SUCCEEDED', 'FAILED', 'CANCELLED', 'EXPIRED'],
  SUCCEEDED: ['REFUNDED'],
  FAILED: [],
  CANCELLED: [],
  REFUNDED: [],
  EXPIRED: [],
};
export const canTransitionPayment = (from: PaymentStatus, to: PaymentStatus) => from === to || PAYMENT_TRANSITIONS[from].includes(to);

export const PaymentMethodType = { UPI: 'UPI', CARD: 'CARD' } as const;
export type PaymentMethodType = (typeof PaymentMethodType)[keyof typeof PaymentMethodType];

/** A recurring authorisation: UPI AutoPay mandate or a card e-mandate/token held by the provider. */
export const MandateStatus = {
  CREATED: 'CREATED',
  PENDING: 'PENDING',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  CANCELLED: 'CANCELLED',
  FAILED: 'FAILED',
  EXPIRED: 'EXPIRED',
} as const;
export type MandateStatus = (typeof MandateStatus)[keyof typeof MandateStatus];

export const InvoiceStatus = { OPEN: 'OPEN', PAID: 'PAID', FAILED: 'FAILED', VOID: 'VOID', REFUNDED: 'REFUNDED' } as const;
export type InvoiceStatus = (typeof InvoiceStatus)[keyof typeof InvoiceStatus];

export const CheckoutStatus = { OPEN: 'OPEN', COMPLETED: 'COMPLETED', FAILED: 'FAILED', EXPIRED: 'EXPIRED', CANCELLED: 'CANCELLED' } as const;
export type CheckoutStatus = (typeof CheckoutStatus)[keyof typeof CheckoutStatus];

/** What a checkout is for. */
export const CheckoutKind = { SUBSCRIBE: 'SUBSCRIBE', RENEW: 'RENEW', PAYMENT_METHOD: 'PAYMENT_METHOD' } as const;
export type CheckoutKind = (typeof CheckoutKind)[keyof typeof CheckoutKind];

export const DiscountType = { PERCENT: 'PERCENT', AMOUNT_OFF: 'AMOUNT_OFF', FIXED_PRICE: 'FIXED_PRICE' } as const;
export type DiscountType = (typeof DiscountType)[keyof typeof DiscountType];

/** Policy knobs that are code, not data — changing them is a reviewed change. */
export const BILLING_POLICY = {
  /** Failed renewal retries for a mandate: days after the first failure. */
  retryScheduleDays: [1, 3, 5] as readonly number[],
  /** A PAST_DUE subscription without a working mandate expires after this many days. */
  graceDays: 7,
  /** Reminders before renewal / trial end. */
  reminderDaysBefore: 3,
  /** An unpaid checkout lapses after this. */
  checkoutTtlMinutes: 30,
  /** Free trials: one per business, ever; at most this many per owner per rolling year. */
  maxTrialsPerOwnerPerYear: 3,
  maxTrialDays: 90,
} as const;

export const PaymentKind = { CHARGE: 'CHARGE', MANDATE_SETUP: 'MANDATE_SETUP', REFUND: 'REFUND' } as const;
export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

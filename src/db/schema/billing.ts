/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, jsonb, pgSequence, pgTable, primaryKey, smallint, text, timestamp, uniqueIndex, uuid, varchar } from 'drizzle-orm/pg-core';
import {
  billingIntervalEnum,
  checkoutKindEnum,
  checkoutStatusEnum,
  discountTypeEnum,
  invoiceStatusEnum,
  mandateStatusEnum,
  paymentKindEnum,
  paymentMethodTypeEnum,
  paymentStatusEnum,
  planStatusEnum,
  planVisibilityEnum,
  subscriptionStatusEnum,
} from './_enums.js';
import { amountMinor, createdAt, fk, primaryId, timestamps } from './_shared.js';
import { businesses } from './business.js';
import { businessOwners, users } from './identity.js';

/* ---------------------------------------------------------------------------
 * Billing — BUSINESS subscriptions (SUBSCRIPTIONS.md).
 *
 * Every subscription, checkout, mandate, payment and invoice references a
 * business. Postgres is the source of truth; Redis only holds locks, the
 * idempotency fast path and caches. Money is integer minor units (paise).
 * Card numbers, CVVs and UPI PINs never reach Equato: the payment provider
 * holds them and we keep only its references plus a masked display label.
 * ------------------------------------------------------------------------- */

const timestamptz = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });

/**
 * Every foreign key gets an index on the referencing column (constraints test):
 * deleting a parent row must not scan the child table. Nullable, sparse
 * columns get a partial index.
 */
const fkIndex = (table: string, column: string, col: Parameters<ReturnType<typeof index>['on']>[0], nullable = true) =>
  nullable ? index(`${table}_${column}_fk_idx`).on(col).where(sql.raw(`${column} IS NOT NULL`)) : index(`${table}_${column}_fk_idx`).on(col);

/** A plan the admin configures. Never deleted once it has subscribers — archived instead. */
export const subscriptionPlans = pgTable(
  'subscription_plans',
  {
    id: primaryId(),
    /** Stable machine name ("pro-monthly"); names are free text and may change. */
    code: text('code').notNull(),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    status: planStatusEnum('status').notNull().default('DRAFT'),
    visibility: planVisibilityEnum('visibility').notNull().default('PUBLIC'),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    /** List price per period. 0 = a free plan (no payment, no mandate). */
    priceMinor: amountMinor('price_minor').notNull(),
    interval: billingIntervalEnum('interval').notNull().default('MONTH'),
    /** Period = interval_count × interval: 1 MONTH, 3 MONTH (quarterly), 1 YEAR … */
    intervalCount: smallint('interval_count').notNull().default(1),
    /** 0 = no trial. */
    trialDays: smallint('trial_days').notNull().default(0),
    /** A trial needs a recurring authorisation up front (converted at trial end), or not (expires unless paid). */
    trialRequiresPaymentMethod: boolean('trial_requires_payment_method').notNull().default(false),
    /** Empty = every category may subscribe. */
    eligibleCategoryIds: uuid('eligible_category_ids').array().notNull().default(sql`'{}'::uuid[]`),
    sortOrder: integer('sort_order').notNull().default(0),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
    archivedAt: timestamptz('archived_at'),
  },
  (t) => [
    uniqueIndex('subscription_plans_code_uq').on(t.code),
    check('subscription_plans_code_ck', sql`code ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('subscription_plans_price_ck', sql`price_minor >= 0 AND price_minor <= 100000000`),
    check('subscription_plans_interval_ck', sql`interval_count BETWEEN 1 AND 12`),
    check('subscription_plans_trial_ck', sql`trial_days BETWEEN 0 AND 90`),
    check('subscription_plans_currency_ck', sql`currency ~ '^[A-Z]{3}$'`),
    index('subscription_plans_listing_idx').on(t.status, t.visibility, t.sortOrder),
    fkIndex('subscription_plans', 'created_by_user_id', t.createdByUserId),
  ],
);

/** What a plan includes, and its limits ("Menu items: 200"). */
export const subscriptionPlanFeatures = pgTable(
  'subscription_plan_features',
  {
    id: primaryId(),
    planId: fk('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'cascade' }),
    key: text('key').notNull(),
    label: text('label').notNull(),
    /** A numeric limit (null = no limit / not a limit). */
    limitValue: integer('limit_value'),
    included: boolean('included').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('subscription_plan_features_uq').on(t.planId, t.key), check('subscription_plan_features_key_ck', sql`key ~ '^[a-z0-9_.-]{1,60}$'`)],
);

/** A discount the admin configures: a code, or applied automatically. */
export const subscriptionOffers = pgTable(
  'subscription_offers',
  {
    id: primaryId(),
    /** Upper-case code an owner types; null = applied automatically to eligible checkouts (when auto_apply). */
    code: text('code'),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    discountType: discountTypeEnum('discount_type').notNull(),
    /** PERCENT: 1–100. AMOUNT_OFF: paise off each period. FIXED_PRICE: the period price in paise. */
    discountValue: amountMinor('discount_value').notNull(),
    /** How many billing periods the discount lasts (3 = "first 3 months"); null = for as long as the subscription runs. */
    durationCycles: smallint('duration_cycles'),
    startsAt: timestamptz('starts_at').notNull().defaultNow(),
    endsAt: timestamptz('ends_at'),
    maxRedemptions: integer('max_redemptions'),
    maxPerBusiness: smallint('max_per_business').notNull().default(1),
    redemptionCount: integer('redemption_count').notNull().default(0),
    isActive: boolean('is_active').notNull().default(true),
    /** Only businesses that never had a paid subscription. */
    newSubscribersOnly: boolean('new_subscribers_only').notNull().default(false),
    autoApply: boolean('auto_apply').notNull().default(false),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('subscription_offers_code_uq').on(t.code).where(sql`code IS NOT NULL`),
    check('subscription_offers_code_ck', sql`code IS NULL OR code ~ '^[A-Z0-9_-]{3,32}$'`),
    check(
      'subscription_offers_value_ck',
      sql`(discount_type = 'PERCENT' AND discount_value BETWEEN 1 AND 100) OR (discount_type = 'AMOUNT_OFF' AND discount_value >= 1) OR (discount_type = 'FIXED_PRICE' AND discount_value >= 0)`,
    ),
    check('subscription_offers_window_ck', sql`ends_at IS NULL OR ends_at > starts_at`),
    check('subscription_offers_cycles_ck', sql`duration_cycles IS NULL OR duration_cycles BETWEEN 1 AND 120`),
    check('subscription_offers_limits_ck', sql`(max_redemptions IS NULL OR max_redemptions >= 1) AND max_per_business >= 1 AND redemption_count >= 0`),
    fkIndex('subscription_offers', 'created_by_user_id', t.createdByUserId),
  ],
);

/** Plans an offer applies to (none = every plan). */
export const subscriptionOfferPlans = pgTable(
  'subscription_offer_plans',
  {
    offerId: fk('offer_id')
      .notNull()
      .references(() => subscriptionOffers.id, { onDelete: 'cascade' }),
    planId: fk('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.offerId, t.planId] }), fkIndex('subscription_offer_plans', 'plan_id', t.planId, false)],
);

/** Businesses an offer is reserved for (none = every eligible business). */
export const subscriptionOfferBusinesses = pgTable(
  'subscription_offer_businesses',
  {
    offerId: fk('offer_id')
      .notNull()
      .references(() => subscriptionOffers.id, { onDelete: 'cascade' }),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
  },
  (t) => [primaryKey({ columns: [t.offerId, t.businessId] }), fkIndex('subscription_offer_businesses', 'business_id', t.businessId, false)],
);

/**
 * A recurring authorisation held by the provider: a UPI AutoPay mandate or a
 * card e-mandate/token. Equato keeps the reference and a masked label only.
 */
export const paymentMandates = pgTable(
  'payment_mandates',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    providerMandateRef: text('provider_mandate_ref').notNull(),
    methodType: paymentMethodTypeEnum('method_type').notNull(),
    status: mandateStatusEnum('status').notNull().default('CREATED'),
    /** The most a single debit may take (shown to the owner when they consent). */
    maxAmountMinor: amountMinor('max_amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    interval: billingIntervalEnum('interval').notNull(),
    intervalCount: smallint('interval_count').notNull().default(1),
    validUntil: timestamptz('valid_until'),
    nextDebitAt: timestamptz('next_debit_at'),
    /** Masked, provider-supplied: "ra•••@okhdfc" or "Visa •••• 4242". Never a full number. */
    displayLabel: text('display_label'),
    /** The exact sentence the owner agreed to, and when — evidence of explicit consent. */
    consentText: text('consent_text').notNull(),
    consentedAt: timestamptz('consented_at').notNull(),
    consentedByUserId: fk('consented_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    activatedAt: timestamptz('activated_at'),
    cancelledAt: timestamptz('cancelled_at'),
    failureReason: text('failure_reason'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('payment_mandates_ref_uq').on(t.provider, t.providerMandateRef),
    index('payment_mandates_business_idx').on(t.businessId, t.status),
    check('payment_mandates_amount_ck', sql`max_amount_minor >= 0`),
    fkIndex('payment_mandates', 'consented_by_user_id', t.consentedByUserId),
  ],
);

/** The provider's customer object for a business (one per provider). */
export const paymentCustomers = pgTable(
  'payment_customers',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    provider: text('provider').notNull(),
    providerCustomerRef: text('provider_customer_ref').notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('payment_customers_business_uq').on(t.businessId, t.provider), uniqueIndex('payment_customers_ref_uq').on(t.provider, t.providerCustomerRef)],
);

/**
 * A business's subscription. Price, interval and discount are SNAPSHOTS taken
 * when it started: editing a plan never silently changes what an existing
 * subscriber pays.
 */
export const subscriptions = pgTable(
  'subscriptions',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    planId: fk('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    status: subscriptionStatusEnum('status').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    priceMinor: amountMinor('price_minor').notNull(),
    interval: billingIntervalEnum('interval').notNull(),
    intervalCount: smallint('interval_count').notNull().default(1),
    offerId: fk('offer_id').references(() => subscriptionOffers.id, { onDelete: 'set null' }),
    /** Amount charged per period while the discount lasts. */
    discountedPriceMinor: amountMinor('discounted_price_minor'),
    /** Periods the discount still covers (null with an offer = for good). */
    discountCyclesRemaining: smallint('discount_cycles_remaining'),
    /** AutoPay (mandate) or pay-each-period. */
    recurring: boolean('recurring').notNull().default(false),
    mandateId: fk('mandate_id').references(() => paymentMandates.id, { onDelete: 'set null' }),
    paymentMethodType: paymentMethodTypeEnum('payment_method_type'),
    trialEndsAt: timestamptz('trial_ends_at'),
    currentPeriodStart: timestamptz('current_period_start').notNull(),
    currentPeriodEnd: timestamptz('current_period_end').notNull(),
    cancelAtPeriodEnd: boolean('cancel_at_period_end').notNull().default(false),
    /** A plan change waiting for the next renewal (SUBSCRIPTIONS.md §plan change). */
    pendingPlanId: fk('pending_plan_id').references(() => subscriptionPlans.id, { onDelete: 'set null' }),
    pastDueSince: timestamptz('past_due_since'),
    retryAttempts: smallint('retry_attempts').notNull().default(0),
    nextRetryAt: timestamptz('next_retry_at'),
    pausedAt: timestamptz('paused_at'),
    cancelledAt: timestamptz('cancelled_at'),
    cancelReason: text('cancel_reason'),
    endedAt: timestamptz('ended_at'),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    ...timestamps(),
  },
  (t) => [
    // At most ONE live subscription per business — the race-proof guard
    // against a double checkout creating two.
    uniqueIndex('subscriptions_live_business_uq')
      .on(t.businessId)
      .where(sql`status IN ('TRIALING', 'ACTIVE', 'PAST_DUE', 'PAUSED')`),
    index('subscriptions_business_idx').on(t.businessId, t.createdAt.desc()),
    // Scheduler sweeps: renewals, trial ends, retries.
    index('subscriptions_period_end_idx').on(t.status, t.currentPeriodEnd),
    index('subscriptions_trial_end_idx').on(t.trialEndsAt).where(sql`status = 'TRIALING'`),
    index('subscriptions_retry_idx').on(t.nextRetryAt).where(sql`status = 'PAST_DUE'`),
    index('subscriptions_plan_idx').on(t.planId, t.status),
    check('subscriptions_period_ck', sql`current_period_end > current_period_start`),
    check('subscriptions_price_ck', sql`price_minor >= 0 AND (discounted_price_minor IS NULL OR discounted_price_minor BETWEEN 0 AND price_minor)`),
    fkIndex('subscriptions', 'mandate_id', t.mandateId),
    fkIndex('subscriptions', 'offer_id', t.offerId),
    fkIndex('subscriptions', 'pending_plan_id', t.pendingPlanId),
    fkIndex('subscriptions', 'created_by_user_id', t.createdByUserId),
  ],
);

/** One free trial per business, ever. Owner-level limits are checked against this too. */
export const subscriptionTrials = pgTable(
  'subscription_trials',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    ownerId: fk('owner_id')
      .notNull()
      .references(() => businessOwners.id, { onDelete: 'restrict' }),
    planId: fk('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    subscriptionId: fk('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    startedAt: timestamptz('started_at').notNull().defaultNow(),
    endsAt: timestamptz('ends_at').notNull(),
  },
  (t) => [
    uniqueIndex('subscription_trials_business_uq').on(t.businessId),
    index('subscription_trials_owner_idx').on(t.ownerId, t.startedAt),
    fkIndex('subscription_trials', 'plan_id', t.planId, false),
    fkIndex('subscription_trials', 'subscription_id', t.subscriptionId),
  ],
);

/**
 * A payment attempt in progress. Amounts are computed by the SERVER from the
 * plan and offer; nothing here came from the browser except the choice.
 */
export const billingCheckouts = pgTable(
  'billing_checkouts',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    kind: checkoutKindEnum('kind').notNull(),
    planId: fk('plan_id')
      .notNull()
      .references(() => subscriptionPlans.id, { onDelete: 'restrict' }),
    offerId: fk('offer_id').references(() => subscriptionOffers.id, { onDelete: 'set null' }),
    subscriptionId: fk('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    methodType: paymentMethodTypeEnum('method_type').notNull(),
    recurring: boolean('recurring').notNull(),
    /** > 0: this checkout starts a free trial (nothing charged now; the mandate debits at trial end). */
    trialDays: smallint('trial_days').notNull().default(0),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    listAmountMinor: amountMinor('list_amount_minor').notNull(),
    discountMinor: amountMinor('discount_minor').notNull().default(0),
    /** Charged now. */
    amountMinor: amountMinor('amount_minor').notNull(),
    /** Each later period (the mandate's debit amount). */
    recurringAmountMinor: amountMinor('recurring_amount_minor').notNull(),
    consentText: text('consent_text').notNull(),
    status: checkoutStatusEnum('status').notNull().default('OPEN'),
    idempotencyKey: text('idempotency_key').notNull(),
    provider: text('provider').notNull(),
    providerCheckoutRef: text('provider_checkout_ref'),
    redirectUrl: text('redirect_url'),
    expiresAt: timestamptz('expires_at').notNull(),
    completedAt: timestamptz('completed_at'),
    failureReason: text('failure_reason'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('billing_checkouts_idem_uq').on(t.businessId, t.idempotencyKey),
    uniqueIndex('billing_checkouts_ref_uq').on(t.provider, t.providerCheckoutRef).where(sql`provider_checkout_ref IS NOT NULL`),
    index('billing_checkouts_open_idx').on(t.status, t.expiresAt),
    index('billing_checkouts_business_idx').on(t.businessId, t.createdAt.desc()),
    check('billing_checkouts_amount_ck', sql`amount_minor >= 0 AND recurring_amount_minor >= 0 AND discount_minor >= 0 AND amount_minor <= list_amount_minor`),
    fkIndex('billing_checkouts', 'plan_id', t.planId, false),
    fkIndex('billing_checkouts', 'offer_id', t.offerId),
    fkIndex('billing_checkouts', 'subscription_id', t.subscriptionId),
    fkIndex('billing_checkouts', 'created_by_user_id', t.createdByUserId),
  ],
);

/** Invoice numbers: EQ-YYYYMM-000123. */
export const invoiceNumberSeq = pgSequence('invoice_number_seq', { startWith: 1 });

/** One invoice per subscription period — the UNIQUE that makes a double renewal impossible. */
export const invoices = pgTable(
  'invoices',
  {
    id: primaryId(),
    number: text('number')
      .notNull()
      .default(sql`'EQ-' || to_char(now() AT TIME ZONE 'Asia/Kolkata', 'YYYYMM') || '-' || lpad(nextval('invoice_number_seq')::text, 6, '0')`),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    subscriptionId: fk('subscription_id')
      .notNull()
      .references(() => subscriptions.id, { onDelete: 'restrict' }),
    status: invoiceStatusEnum('status').notNull().default('OPEN'),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    subtotalMinor: amountMinor('subtotal_minor').notNull(),
    discountMinor: amountMinor('discount_minor').notNull().default(0),
    totalMinor: amountMinor('total_minor').notNull(),
    periodStart: timestamptz('period_start').notNull(),
    periodEnd: timestamptz('period_end').notNull(),
    description: text('description').notNull(),
    issuedAt: timestamptz('issued_at').notNull().defaultNow(),
    dueAt: timestamptz('due_at').notNull(),
    paidAt: timestamptz('paid_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('invoices_number_uq').on(t.number),
    uniqueIndex('invoices_period_uq').on(t.subscriptionId, t.periodStart),
    index('invoices_business_idx').on(t.businessId, t.periodStart.desc(), t.id.desc()),
    check('invoices_amount_ck', sql`subtotal_minor >= 0 AND discount_minor >= 0 AND total_minor = subtotal_minor - discount_minor`),
  ],
);

export const invoiceItems = pgTable(
  'invoice_items',
  {
    id: primaryId(),
    invoiceId: fk('invoice_id')
      .notNull()
      .references(() => invoices.id, { onDelete: 'cascade' }),
    /** PLAN | DISCOUNT */
    kind: text('kind').notNull(),
    description: text('description').notNull(),
    amountMinor: amountMinor('amount_minor').notNull(),
  },
  (t) => [index('invoice_items_invoice_idx').on(t.invoiceId)],
);

/**
 * Every money movement attempt. `idempotency_key` is unique, so a retried
 * renewal or a re-delivered webhook can never record (or charge) twice.
 */
export const paymentTransactions = pgTable(
  'payment_transactions',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    subscriptionId: fk('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    checkoutId: fk('checkout_id').references(() => billingCheckouts.id, { onDelete: 'set null' }),
    invoiceId: fk('invoice_id').references(() => invoices.id, { onDelete: 'set null' }),
    mandateId: fk('mandate_id').references(() => paymentMandates.id, { onDelete: 'set null' }),
    provider: text('provider').notNull(),
    providerPaymentRef: text('provider_payment_ref'),
    kind: paymentKindEnum('kind').notNull(),
    methodType: paymentMethodTypeEnum('method_type'),
    amountMinor: amountMinor('amount_minor').notNull(),
    currency: varchar('currency', { length: 3 }).notNull().default('INR'),
    status: paymentStatusEnum('status').notNull().default('CREATED'),
    attempt: smallint('attempt').notNull().default(1),
    idempotencyKey: text('idempotency_key').notNull(),
    failureCode: text('failure_code'),
    failureMessage: text('failure_message'),
    succeededAt: timestamptz('succeeded_at'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('payment_transactions_idem_uq').on(t.idempotencyKey),
    uniqueIndex('payment_transactions_ref_uq').on(t.provider, t.providerPaymentRef).where(sql`provider_payment_ref IS NOT NULL`),
    index('payment_transactions_business_idx').on(t.businessId, t.createdAt.desc(), t.id.desc()),
    index('payment_transactions_pending_idx').on(t.status, t.createdAt).where(sql`status IN ('CREATED', 'PENDING', 'AUTHORIZED')`),
    index('payment_transactions_invoice_idx').on(t.invoiceId),
    check('payment_transactions_amount_ck', sql`amount_minor >= 0 AND attempt >= 1`),
    fkIndex('payment_transactions', 'subscription_id', t.subscriptionId),
    fkIndex('payment_transactions', 'checkout_id', t.checkoutId),
    fkIndex('payment_transactions', 'mandate_id', t.mandateId),
  ],
);

/** Append-only history of a business's billing, shown in the portal and admin. */
export const subscriptionEvents = pgTable(
  'subscription_events',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'restrict' }),
    subscriptionId: fk('subscription_id').references(() => subscriptions.id, { onDelete: 'set null' }),
    type: text('type').notNull(),
    data: jsonb('data').$type<Record<string, unknown>>().notNull().default({}),
    actorUserId: fk('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    /** Makes scheduled events (reminders) happen once however often a sweep runs. */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('subscription_events_dedupe_uq').on(t.dedupeKey).where(sql`dedupe_key IS NOT NULL`),
    index('subscription_events_business_idx').on(t.businessId, t.createdAt.desc()),
    index('subscription_events_subscription_idx').on(t.subscriptionId, t.createdAt.desc()),
    fkIndex('subscription_events', 'actor_user_id', t.actorUserId),
  ],
);

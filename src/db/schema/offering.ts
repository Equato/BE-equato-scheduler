/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { sql } from 'drizzle-orm';
import {
  boolean,
  index,
  integer,
  jsonb,
  numeric,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  check,
} from 'drizzle-orm/pg-core';
import {
  availabilityModeEnum,
  offeringSourceEnum,
  publicationStatusEnum,
} from './_enums.js';
import {
  amountMinor,
  clockTime,
  createdAt,
  deletedAt,
  fk,
  primaryId,
  readableCode,
  timestamps,
} from './_shared.js';
import { businesses, businessGroups } from './business.js';
import { categories } from './category.js';
import { users } from './identity.js';

/* ---------------------------------------------------------------------------
 * Comparison groups
 *
 * The prototype compares two items when their normalised names match exactly
 * within one category. That works because the owner form nudges toward shared
 * names, but it will not survive real data: "Cold Coffee", "Cold coffee ",
 * "COLD COFFEE (Large)" and "Cold Coffee 300ml" are one product to a shopper
 * and four strings to that rule.
 *
 * An explicit group makes comparability a decision rather than a coincidence,
 * and admins can merge or split one when the automatic assignment is wrong.
 * With empty variant attributes the assignment reproduces the prototype's
 * behaviour exactly, so nothing changes on migration (brief §9).
 * ------------------------------------------------------------------------- */

export const comparisonGroups = pgTable(
  'comparison_groups',
  {
    id: primaryId(),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    canonicalName: text('canonical_name').notNull(),
    /** Name after normalisation: lowercased, unaccented, punctuation stripped. */
    normalizedName: text('normalized_name').notNull(),
    slug: text('slug').notNull(),
    /** "/night", "kg", "ml" — part of identity. 300ml ≠ 500ml. */
    unit: text('unit').notNull().default(''),
    /**
     * Size, quantity, duration — pulled OUT of the name rather than left to
     * poison the match. Two offerings compare only when these agree.
     */
    variantAttrs: jsonb('variant_attrs').$type<Record<string, string>>().notNull().default({}),

    /** Refreshed by the scheduler. Lets the compare hub render without a join. */
    listingCount: integer('listing_count').notNull().default(0),
    minAmountMinor: amountMinor('min_amount_minor'),
    maxAmountMinor: amountMinor('max_amount_minor'),
    ...timestamps(),
  },
  (t) => [
    check('comparison_groups_slug_ck', sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    check('comparison_groups_range_ck', sql`listing_count >= 0 AND (min_amount_minor IS NULL OR min_amount_minor >= 0) AND (min_amount_minor IS NULL OR max_amount_minor IS NULL OR min_amount_minor <= max_amount_minor)`),
    uniqueIndex('comparison_groups_identity_uq').on(
      t.categoryId,
      t.normalizedName,
      t.unit,
      t.variantAttrs,
    ),
    uniqueIndex('comparison_groups_slug_uq').on(t.categoryId, t.slug),
    // The compare hub lists the most-compared items per category.
    index('comparison_groups_popular_idx').on(t.categoryId, t.listingCount.desc()),
    // Item suggestions and "cold cofee" → Cold Coffee: trigram over the matched name.
    index('comparison_groups_name_trgm').using('gin', t.normalizedName.op('gin_trgm_ops')),
  ],
);

/**
 * Curated synonyms. "Cold Coffee" and "Iced Coffee" are the same product to a
 * shopper; no normalisation rule will ever work that out on its own, so an
 * admin says so and the mapping is data.
 */
export const comparisonAliases = pgTable(
  'comparison_aliases',
  {
    id: primaryId(),
    comparisonGroupId: fk('comparison_group_id')
      .notNull()
      .references(() => comparisonGroups.id, { onDelete: 'cascade' }),
    aliasNormalized: text('alias_normalized').notNull(),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('comparison_aliases_uq').on(t.aliasNormalized)],
);

/* ---------------------------------------------------------------------------
 * Offerings — the thing being priced.
 *
 * One table for menu items, room types, membership plans, services, courses
 * and products. Category-specific fields live in `attributes`, validated
 * against that category's `category_fields`.
 * ------------------------------------------------------------------------- */

/** Readable product codes: PRD-2026-00001872 (readableCode). */
export const offeringCodeSeq = pgSequence('offering_code_seq', { startWith: 1 });

export const offerings = pgTable(
  'offerings',
  {
    id: primaryId(),
    code: readableCode('PRD', 'offering_code_seq'),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    businessGroupId: fk('business_group_id').references(() => businessGroups.id, {
      onDelete: 'set null',
    }),
    /** Null until assignment runs, or when nothing else is comparable. */
    comparisonGroupId: fk('comparison_group_id').references(() => comparisonGroups.id, {
      onDelete: 'set null',
    }),

    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description').notNull().default(''),
    priceUnit: text('price_unit').notNull().default(''),

    /** duration, capacity, features[] — shaped by the category's fields. */
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    isVegetarian: boolean('is_vegetarian'),

    availabilityMode: availabilityModeEnum('availability_mode').notNull().default('ALWAYS'),
    /** Only for WINDOW: a lunch-only thali, served 12:00–15:00. */
    availableFrom: clockTime('available_from'),
    availableTo: clockTime('available_to'),

    publicationStatus: publicationStatusEnum('publication_status').notNull().default('DRAFT'),
    rejectionReason: text('rejection_reason'),
    source: offeringSourceEnum('source').notNull().default('MANUAL'),

    ratingAvg: numeric('rating_avg', { precision: 2, scale: 1 }).notNull().default('0'),
    ratingCount: integer('rating_count').notNull().default(0),

    /**
     * The owner's own highlights on the menu: "Our special" and "Best seller".
     * Live immediately, capped per business (modules/offerings/service.ts).
     * "Top rated" is NOT stored — it is earned from customer ratings.
     */
    isSpecial: boolean('is_special').notNull().default(false),
    isBestseller: boolean('is_bestseller').notNull().default(false),

    /**
     * The open price in offering_prices, copied here by a trigger
     * (offering_prices_sync_current) so a comparison can take its cheapest
     * listings straight off an index instead of pricing and sorting every
     * listing in the group. Never written by application code.
     */
    currentAmountMinor: amountMinor('current_amount_minor'),

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check('offerings_rating_ck', sql`rating_avg BETWEEN 0 AND 5 AND rating_count >= 0`),
    uniqueIndex('offerings_code_uq').on(t.code),
    check('offerings_window_ck', sql`availability_mode <> 'WINDOW' OR (available_from IS NOT NULL AND available_to IS NOT NULL)`),
    // Business menu, and the owner's item list with its status tabs.
    index('offerings_business_idx').on(t.businessId, t.publicationStatus),
    // The highlights strip at the top of a business's menu.
    index('offerings_highlight_idx')
      .on(t.businessId)
      .where(sql`(is_special OR is_bestseller) AND deleted_at IS NULL`),

    // THE comparison query. Partial, because only approved rows ever compare.
    // Cheapest-first comparison pages: ORDER BY price, id LIMIT n, served by the index.
    index('offerings_group_price_idx')
      .on(t.comparisonGroupId, t.currentAmountMinor, t.id)
      .where(sql`publication_status = 'APPROVED' AND deleted_at IS NULL`),
    index('offerings_comparison_idx')
      .on(t.comparisonGroupId)
      .where(sql`publication_status = 'APPROVED'`),

    // The admin approval queue, oldest first.
    index('offerings_queue_idx')
      .on(t.submittedAt)
      .where(sql`publication_status = 'PENDING_REVIEW'`),

    // Grouped menu rendering on the public business page.
    index('offerings_group_idx').on(t.businessId, t.businessGroupId),

    // Comparison-group assignment and the owner form's datalist of shared names.
    index('offerings_normalized_idx').on(t.normalizedName),
  ],
);

/**
 * Prices, with validity windows.
 *
 * The current price is the row where now() falls between effective_from and
 * effective_to. Separating price from offering is what allows a scheduled
 * change ("new prices from Monday") without a cron job rewriting rows, and it
 * keeps the audit trail honest.
 */
export const offeringPrices = pgTable(
  'offering_prices',
  {
    id: primaryId(),
    offeringId: fk('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    amountMinor: amountMinor('amount_minor').notNull(),
    currencyCode: text('currency_code').notNull().default('INR'),
    effectiveFrom: timestamp('effective_from', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Null means "current, until replaced". */
    effectiveTo: timestamp('effective_to', { withTimezone: true, mode: 'date' }),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    check('offering_prices_amount_ck', sql`amount_minor BETWEEN 0 AND 1000000000`),
    check('offering_prices_currency_ck', sql`currency_code ~ '^[A-Z]{3}$'`),
    check('offering_prices_period_ck', sql`effective_to IS NULL OR effective_to > effective_from`),
    index('offering_prices_current_idx').on(t.offeringId, t.effectiveFrom.desc()),
    // At most one open-ended price per offering — enforced by the database,
    // because two "current" prices would make the comparison non-deterministic.
    uniqueIndex('offering_prices_one_open_uq')
      .on(t.offeringId)
      .where(sql`effective_to IS NULL`),
  ],
);

/**
 * Append-only record of every price change. The prototype keeps this in
 * `item.history[]`; here it is partitioned by month, because it grows without
 * bound and nobody queries last year's changes on the hot path.
 */
export const priceHistory = pgTable(
  'price_history',
  {
    id: fk('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    offeringId: fk('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    oldAmountMinor: amountMinor('old_amount_minor'),
    newAmountMinor: amountMinor('new_amount_minor').notNull(),
    changedByUserId: fk('changed_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    changedAt: timestamp('changed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    check('price_history_amount_ck', sql`new_amount_minor BETWEEN 0 AND 1000000000 AND (old_amount_minor IS NULL OR old_amount_minor BETWEEN 0 AND 1000000000)`),
    index('price_history_offering_idx').on(t.offeringId, t.changedAt.desc()),
    index('price_history_business_idx').on(t.businessId, t.changedAt.desc()),
  ],
);

/**
 * A pending edit to an APPROVED offering.
 *
 * Approval policy (OFFERING_EDIT): editing a live price returns it to review,
 * but the previously approved version keeps showing until the edit is
 * approved. So the edit lives here — the `offerings` row and its current
 * price stay exactly as shoppers see them — and an admin decision either
 * applies the revision (new price row + history) or rejects it with a reason.
 *
 * Edits to offerings that are not yet public (DRAFT, PENDING_REVIEW,
 * REJECTED) are applied to the row directly; there is nothing live to protect.
 */
export const offeringRevisions = pgTable(
  'offering_revisions',
  {
    id: primaryId(),
    offeringId: fk('offering_id')
      .notNull()
      .references(() => offerings.id, { onDelete: 'cascade' }),
    status: publicationStatusEnum('status').notNull().default('PENDING_REVIEW'),
    name: text('name').notNull(),
    normalizedName: text('normalized_name').notNull(),
    description: text('description').notNull().default(''),
    amountMinor: amountMinor('amount_minor').notNull(),
    isVegetarian: boolean('is_vegetarian'),
    attributes: jsonb('attributes').$type<Record<string, unknown>>().notNull().default({}),
    submittedByUserId: fk('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedByUserId: fk('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    rejectionReason: text('rejection_reason'),
  },
  (t) => [
    check('offering_revisions_amount_ck', sql`amount_minor BETWEEN 0 AND 1000000000`),
    // One open revision per offering: a second edit replaces the first.
    uniqueIndex('offering_revisions_one_open_uq')
      .on(t.offeringId)
      .where(sql`status = 'PENDING_REVIEW'`),
    index('offering_revisions_queue_idx')
      .on(t.submittedAt)
      .where(sql`status = 'PENDING_REVIEW'`),
  ],
);

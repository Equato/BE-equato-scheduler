/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { sql } from 'drizzle-orm';
import { date, index, pgTable, text, timestamp, uniqueIndex, varchar, check } from 'drizzle-orm/pg-core';
import { offerStatusEnum } from './_enums.js';
import { createdAt, fk, primaryId, timestamps } from './_shared.js';
import { businesses } from './business.js';
import { businessOwners, users } from './identity.js';
import { media } from './ops.js';

/* ---------------------------------------------------------------------------
 * Offers — published instantly, no review step.
 *
 * Unlike a price, an offer carries no trust claim that needs checking, so the
 * owner publishes it directly. Visibility is still gated: an offer only shows
 * while its business is approved and its category active, and between its
 * start and end dates.
 *
 * Expired and Scheduled are DERIVED from those dates at query time. Storing
 * them would need a cron job to stay true and would still be wrong between
 * runs; a date comparison is always right.
 * ------------------------------------------------------------------------- */

export const offers = pgTable(
  'offers',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Optional voucher code shown to the shopper, e.g. "SAVE20". */
    couponCode: varchar('coupon_code', { length: 32 }),
    mediaId: fk('media_id').references(() => media.id, { onDelete: 'set null' }),
    validFrom: date('valid_from'),
    /** Null means "runs until the owner pauses it". */
    validTo: date('valid_to'),
    status: offerStatusEnum('status').notNull().default('ACTIVE'),
    ...timestamps(),
  },
  (t) => [
    check('offers_period_ck', sql`valid_from IS NULL OR valid_to IS NULL OR valid_to >= valid_from`),
    index('offers_business_idx').on(t.businessId, t.status),
    // The public offers page: active offers, newest first.
    index('offers_live_idx')
      .on(t.validFrom, t.validTo)
      .where(sql`status = 'ACTIVE'`),
  ],
);

/**
 * Offer codes: a shopper claims one, the owner redeems it at the counter.
 *
 * This is the most commercially interesting thing in the product — it closes
 * the attribution loop, turning "someone looked at your listing" into
 * "someone walked in", and it is what the owner funnel counts as a confirmed
 * visit.
 */
export const offerClaims = pgTable(
  'offer_claims',
  {
    id: primaryId(),
    offerId: fk('offer_id')
      .notNull()
      .references(() => offers.id, { onDelete: 'cascade' }),
    /** Denormalised so redemption can verify ownership without a join. */
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** The short code the shopper shows: "EQ-4821". */
    code: varchar('code', { length: 16 }).notNull(),
    claimedAt: createdAt(),
    /** Null until the owner verifies it. Set once, never cleared. */
    redeemedAt: timestamp('redeemed_at', { withTimezone: true, mode: 'date' }),
    redeemedByOwnerId: fk('redeemed_by_owner_id').references(() => businessOwners.id, { onDelete: 'set null' }),
  },
  (t) => [
    // The code is typed in by hand at a counter; it must be globally unique.
    uniqueIndex('offer_claims_code_uq').on(t.code),
    // One live claim per shopper per offer — re-claiming returns the same code
    // rather than minting a second one.
    uniqueIndex('offer_claims_one_live_uq')
      .on(t.offerId, t.userId)
      .where(sql`redeemed_at IS NULL`),
    // Confirmed-visit counts for the owner funnel.
    index('offer_claims_business_idx').on(t.businessId, t.redeemedAt),
  ],
);
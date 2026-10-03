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
  check,
  index,
  integer,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import {
  reportStatusEnum,
  reportTargetEnum,
  reviewStatusEnum,
  reviewTargetEnum,
} from './_enums.js';
import { createdAt, fk, primaryId, timestamps } from './_shared.js';
import { businesses } from './business.js';
import { offerings } from './offering.js';
import { businessOwners, users } from './identity.js';

/* ---------------------------------------------------------------------------
 * Reviews — two levels that never mix.
 *
 * A review is about THE PLACE or about ONE ITEM. An item review must never move
 * the business's headline rating. The prototype keeps this straight with a
 * `kind` field and disciplined queries; here the CHECK constraint makes it a
 * database invariant, so no future resolver can get it wrong.
 *
 * 371 of the 1,171 seeded reviews are about businesses, 800 about items.
 * ------------------------------------------------------------------------- */

export const reviews = pgTable(
  'reviews',
  {
    id: primaryId(),
    targetType: reviewTargetEnum('target_type').notNull(),
    /** Always set — an item review still belongs to a business, for scoping. */
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** Set only when target_type = 'OFFERING'. The CHECK below enforces it. */
    offeringId: fk('offering_id').references(() => offerings.id, { onDelete: 'cascade' }),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    rating: smallint('rating').notNull(),
    body: text('body').notNull().default(''),
    status: reviewStatusEnum('status').notNull().default('PUBLISHED'),
    helpfulCount: integer('helpful_count').notNull().default(0),
    reportCount: integer('report_count').notNull().default(0),
    editedAt: timestamp('edited_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    // The invariant: an OFFERING review has an offering, a BUSINESS review does not.
    check(
      'reviews_target_consistent',
      sql`(target_type = 'OFFERING' AND offering_id IS NOT NULL)
       OR (target_type = 'BUSINESS' AND offering_id IS NULL)`,
    ),
    check('reviews_rating_range', sql`rating BETWEEN 1 AND 5`),

    // One review per user per subject. Editing replaces, never appends.
    uniqueIndex('reviews_one_per_user_business_uq')
      .on(t.userId, t.businessId)
      .where(sql`target_type = 'BUSINESS'`),
    uniqueIndex('reviews_one_per_user_offering_uq')
      .on(t.userId, t.offeringId)
      .where(sql`target_type = 'OFFERING'`),

    // The business page's Reviews tab, split by scope, newest first.
    // Keyset pagination: (created_at, id) is the cursor, so id is the
    // tiebreaker that keeps pages stable when two reviews share a timestamp.
    index('reviews_business_idx').on(t.businessId, t.targetType, t.status, t.createdAt.desc(), t.id.desc()),
    index('reviews_offering_idx').on(t.offeringId, t.status, t.createdAt.desc(), t.id.desc()),
    index('reviews_user_idx').on(t.userId, t.createdAt.desc()),
    // Admin moderation queue. Partial, so it stays tiny.
    index('reviews_flagged_idx')
      .on(t.createdAt.desc())
      .where(sql`status = 'FLAGGED'`),
  ],
);

/**
 * Replies on a review thread. Either a shopper or the business owner.
 *
 * An owner reply carries the "Owner of {business}" badge and notifies the
 * reviewer — which is why the author is two nullable columns rather than one
 * polymorphic id: the distinction drives behaviour, not just display.
 */
export const reviewComments = pgTable(
  'review_comments',
  {
    id: primaryId(),
    reviewId: fk('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    authorUserId: fk('author_user_id').references(() => users.id, { onDelete: 'set null' }),
    authorOwnerId: fk('author_owner_id').references(() => businessOwners.id, {
      onDelete: 'set null',
    }),
    body: text('body').notNull(),
    ...timestamps(),
  },
  (t) => [
    check(
      'review_comments_one_author',
      sql`(author_user_id IS NOT NULL) <> (author_owner_id IS NOT NULL)`,
    ),
    index('review_comments_review_idx').on(t.reviewId, t.createdAt),
  ],
);

/** Helpful votes. Unique per user so the count cannot be inflated by re-clicking. */
export const reviewHelpfulVotes = pgTable(
  'review_helpful_votes',
  {
    id: primaryId(),
    reviewId: fk('review_id')
      .notNull()
      .references(() => reviews.id, { onDelete: 'cascade' }),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('review_helpful_votes_uq').on(t.reviewId, t.userId)],
);

/** User- and owner-submitted reports: a review, a price, a business, an item. */
export const reports = pgTable(
  'reports',
  {
    id: primaryId(),
    targetType: reportTargetEnum('target_type').notNull(),
    targetId: fk('target_id').notNull(),
    reason: text('reason').notNull(),
    reportedByUserId: fk('reported_by_user_id').references(() => users.id, {
      onDelete: 'set null',
    }),
    status: reportStatusEnum('status').notNull().default('OPEN'),
    resolvedByUserId: fk('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    index('reports_open_idx')
      .on(t.createdAt.desc())
      .where(sql`status = 'OPEN'`),
    index('reports_target_idx').on(t.targetType, t.targetId),
  ],
);
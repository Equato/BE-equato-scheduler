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
  date,
  index,
  integer,
  numeric,
  pgSequence,
  pgTable,
  smallint,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  check,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { deliveryProviderEnum, publicationStatusEnum, removalStatusEnum } from './_enums.js';
import {
  clockTime,
  createdAt,
  deletedAt,
  fk,
  geoPoint,
  primaryId,
  readableCode,
  timestamps,
} from './_shared.js';
import { areas } from './location.js';
import { categories, categoryRequests } from './category.js';
import { businessOwners, users } from './identity.js';
import { media } from './ops.js';

/* ---------------------------------------------------------------------------
 * Businesses
 *
 * One owner holds MANY businesses. 15 of the 94 seeded owners do; the largest
 * runs five. Every business keeps its own menu, hours, photos and prices, and
 * data never mixes between them (brief §11).
 * ------------------------------------------------------------------------- */

/** Readable business codes: BIZ-2026-00000045 (readableCode). */
export const businessCodeSeq = pgSequence('business_code_seq', { startWith: 1 });

export const businesses = pgTable(
  'businesses',
  {
    id: primaryId(),
    code: readableCode('BIZ', 'business_code_seq'),
    ownerId: fk('owner_id')
      .notNull()
      .references(() => businessOwners.id, { onDelete: 'restrict' }),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    /**
     * Set while a requested category is still under review. The business sits
     * under a fallback category meanwhile and is held out of the business
     * queue until this clears.
     */
    pendingCategoryRequestId: fk('pending_category_request_id').references(
      () => categoryRequests.id,
      { onDelete: 'set null' },
    ),
    /** Why a category request was turned down — the owner must then pick one. */
    categoryRejectionReason: text('category_rejection_reason'),

    name: text('name').notNull(),
    slug: text('slug').notNull(),
    description: text('description').notNull().default(''),
    phone: varchar('phone', { length: 32 }),
    email: text('email'),

    areaId: fk('area_id')
      .notNull()
      .references(() => areas.id, { onDelete: 'restrict' }),
    addressLine: text('address_line').notNull().default(''),
    pinCode: varchar('pin_code', { length: 12 }),
    location: geoPoint('location').notNull(),

    /**
     * Where the business sits in the approval workflow.
     *
     * NOT the same thing as whether it is open right now. Operating status is
     * derived from business_hours + business_special_hours at query time and is
     * never stored — the prototype is emphatic about this distinction, and
     * storing it would mean a cron job writing to every row every minute and
     * still being wrong in between.
     */
    publicationStatus: publicationStatusEnum('publication_status')
      .notNull()
      .default('PENDING_REVIEW'),
    /** Most recent rejection reason. Full history lives in business_rejections. */
    rejectionReason: text('rejection_reason'),
    isVerified: boolean('is_verified').notNull().default(false),
    /**
     * The owner's own on/off switch. An APPROVED business that the owner has
     * made inactive is hidden from shoppers exactly like an unapproved one —
     * see publicBusiness() in modules/visibility.ts. It never affects the
     * approval workflow, and turning it back on needs no review.
     */
    isActive: boolean('is_active').notNull().default(true),

    /** The business's own website (https only — see publicUrl()). Live immediately. */
    websiteUrl: text('website_url'),
    /**
     * How many branches the brand has in total, this one included, when it
     * has more than one — some may not be on Equato. Null means a single
     * branch. Shared by every business in the same branch group.
     */
    branchCount: smallint('branch_count'),
    /**
     * Businesses of ONE owner that are branches of the same brand share this
     * value (the id of the business that started the group). Shoppers see the
     * other public branches on each branch's page.
     */
    branchGroupId: fk('branch_group_id'),
    /** The owner's logo, once processed. Null → the generated initials mark. */
    logoMediaId: fk('logo_media_id').references((): AnyPgColumn => media.id, { onDelete: 'set null' }),
    isPureVegetarian: boolean('is_pure_vegetarian'),

    /** Denormalised: reading 1,171 reviews to render a card does not scale. */
    ratingAvg: numeric('rating_avg', { precision: 2, scale: 1 }).notNull().default('0'),
    ratingCount: integer('rating_count').notNull().default(0),

    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }),
    /** When it entered the review queue — drives "waiting since" in admin. */
    queuedAt: timestamp('queued_at', { withTimezone: true, mode: 'date' }),
    approvedAt: timestamp('approved_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [
    check('businesses_location_ck', sql`ST_Y(location::geometry) BETWEEN -90 AND 90 AND ST_X(location::geometry) BETWEEN -180 AND 180 AND NOT (ST_X(location::geometry) = 0 AND ST_Y(location::geometry) = 0)`),
    check('businesses_slug_ck', sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    uniqueIndex('businesses_code_uq').on(t.code),
    check('businesses_rating_ck', sql`rating_avg BETWEEN 0 AND 5 AND rating_count >= 0`),
    check('businesses_branch_count_ck', sql`branch_count IS NULL OR branch_count BETWEEN 2 AND 9999`),
    index('businesses_branch_group_idx')
      .on(t.branchGroupId)
      .where(sql`branch_group_id IS NOT NULL`),
    uniqueIndex('businesses_slug_uq').on(t.slug),

    // Business Portal: "my businesses", loaded on every page of the portal.
    index('businesses_owner_idx')
      .on(t.ownerId)
      .where(sql`deleted_at IS NULL`),

    // The main search filter combination: category + area within approved.
    index('businesses_search_idx').on(t.publicationStatus, t.categoryId, t.areaId),

    // Radius search and distance sort. GiST is the right index for geography.
    index('businesses_location_idx').using('gist', t.location),
    // The shopper "near me" path: only publicly visible rows, so the index is
    // smaller than the table and matches the query's own predicate exactly.
    // The full index above serves admin maps and duplicate-location checks.
    index('businesses_public_location_idx')
      .using('gist', t.location)
      .where(sql`publication_status = 'APPROVED' AND deleted_at IS NULL`),

    // "Featured" and "top rated" listings.
    index('businesses_rating_idx')
      .on(t.categoryId, t.ratingAvg.desc())
      .where(sql`publication_status = 'APPROVED'`),

    // The admin business queue, oldest first. Partial, so it stays tiny.
    index('businesses_queue_idx')
      .on(t.queuedAt)
      .where(sql`publication_status = 'PENDING_REVIEW'`),

    // Migrating waiting businesses when a category request is approved.
    index('businesses_pending_category_idx')
      .on(t.pendingCategoryRequestId)
      .where(sql`pending_category_request_id IS NOT NULL`),

    index('businesses_created_idx').on(t.createdAt.desc()),
  ],
);

/**
 * Rejection history, not a single column.
 *
 * An owner can be rejected, fix it, resubmit and be rejected again. Keeping
 * only the latest reason loses the fact that this is the third attempt, which
 * is exactly what a reviewer needs to know.
 */
export const businessRejections = pgTable(
  'business_rejections',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    rejectedByUserId: fk('rejected_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [index('business_rejections_business_idx').on(t.businessId, t.createdAt.desc())],
);

/**
 * Opening hours: one row per slot per weekday.
 *
 * Two rows for the same day is a split shift (lunch, then dinner) — which 40
 * of the seeded businesses use. `closesAt < opensAt` means the slot runs past
 * midnight, and the hours engine treats it as still-open after midnight.
 * An absent day means closed.
 */
export const businessHours = pgTable(
  'business_hours',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    /** 0 = Monday … 6 = Sunday, matching the prototype's DAYS array. */
    dayOfWeek: smallint('day_of_week').notNull(),
    opensAt: clockTime('opens_at').notNull(),
    closesAt: clockTime('closes_at').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    check('business_hours_day_ck', sql`day_of_week BETWEEN 0 AND 6`),
    index('business_hours_business_idx').on(t.businessId, t.dayOfWeek, t.sortOrder),
  ],
);

/** Overrides the weekly schedule on one date: a festival closure, a late opening. */
export const businessSpecialHours = pgTable(
  'business_special_hours',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    isClosed: boolean('is_closed').notNull().default(true),
    opensAt: clockTime('opens_at'),
    closesAt: clockTime('closes_at'),
    /** Shown to customers: "Diwali", "stock-taking", "private event". */
    reason: text('reason'),
  },
  (t) => [
    check('business_special_hours_times_ck', sql`is_closed OR (opens_at IS NOT NULL AND closes_at IS NOT NULL)`),uniqueIndex('business_special_hours_uq').on(t.businessId, t.date)],
);

/**
 * Amenities. `isCustom` is the load-bearing column.
 *
 * A standard amenity comes from the category. A custom one is invented by the
 * owner and GOES LIVE IMMEDIATELY with no review — because it describes one
 * business, so there is nothing to review. That is a real product rule, and
 * the reason this is a flag rather than two tables is that both kinds are
 * filtered identically on the search page.
 */
/** A business's store page on a delivery app: one link per provider. Live immediately. */
export const businessDeliveryLinks = pgTable(
  'business_delivery_links',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    provider: deliveryProviderEnum('provider').notNull(),
    url: text('url').notNull(),
    ...timestamps(),
  },
  (t) => [uniqueIndex('business_delivery_links_uq').on(t.businessId, t.provider)],
);

export const businessAmenities = pgTable(
  'business_amenities',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    isCustom: boolean('is_custom').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('business_amenities_uq').on(t.businessId, t.name),
    // Search filters on amenity name across businesses.
    index('business_amenities_name_idx').on(t.name),
  ],
);

/**
 * Per-business menu groups.
 *
 * Seeded from the category defaults, then owned by the business — renaming
 * "Beverages" to "Drinks" at one cafe must not touch any other.
 */
export const businessGroups = pgTable(
  'business_groups',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('business_groups_uq').on(t.businessId, t.name)],
);

/** An owner asking for a listing to be taken down. Reviewed, never immediate. */
export const businessRemovalRequests = pgTable(
  'business_removal_requests',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    reason: text('reason').notNull(),
    status: removalStatusEnum('status').notNull().default('OPEN'),
    resolvedByUserId: fk('resolved_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('business_removal_open_idx')
      .on(t.createdAt)
      .where(sql`status = 'OPEN'`),
  ],
);

/**
 * A pending identity edit (name, description, category) to an APPROVED
 * business — BUSINESS_IDENTITY_EDIT in the approval policy. The live listing
 * keeps its approved identity until an admin approves the revision.
 * Contact details and hours never come here: they update immediately.
 */
export const businessRevisions = pgTable(
  'business_revisions',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    status: publicationStatusEnum('status').notNull().default('PENDING_REVIEW'),
    name: text('name').notNull(),
    description: text('description').notNull(),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'restrict' }),
    submittedByUserId: fk('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: timestamp('submitted_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    decidedByUserId: fk('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    rejectionReason: text('rejection_reason'),
  },
  (t) => [
    uniqueIndex('business_revisions_one_open_uq')
      .on(t.businessId)
      .where(sql`status = 'PENDING_REVIEW'`),
    index('business_revisions_queue_idx')
      .on(t.submittedAt)
      .where(sql`status = 'PENDING_REVIEW'`),
  ],
);

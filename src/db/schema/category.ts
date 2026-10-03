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
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  check,
} from 'drizzle-orm/pg-core';
import { categoryRequestStatusEnum } from './_enums.js';
import { fk, primaryId, timestamps } from './_shared.js';
import { businessOwners, users } from './identity.js';

/* ---------------------------------------------------------------------------
 * Categories
 *
 * A category defines what its businesses list, what one item is called, whether
 * prices carry a unit, which sub-groups exist, which form fields appear and
 * which amenities are filterable.
 *
 * This is why 13 wildly different verticals — cafes, hotels, gyms, salons,
 * bookshops — run on one code path. Hard-coding per-category behaviour would
 * mean a new vertical is a deploy; here it is a row (brief §14).
 * ------------------------------------------------------------------------- */

export const categories = pgTable(
  'categories',
  {
    id: primaryId(),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    /** Emoji shown on tiles and in the admin grid. */
    icon: varchar('icon', { length: 16 }),
    /** Tab label: "Menu", "Rooms", "Plans", "Services", "Courses", "Products". */
    offeringLabel: text('offering_label').notNull(),
    /** Singular noun for one item: "menu item", "room type", "membership plan". */
    itemNoun: text('item_noun').notNull(),
    /** Suffix on a price, e.g. "/night" for hotels. Empty for most. */
    priceUnit: text('price_unit').notNull().default(''),
    /** Whether a vegetarian marker applies. True for cafes and restaurants. */
    supportsVegetarian: boolean('supports_vegetarian').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
    ...timestamps(),
  },
  (t) => [
    check('categories_slug_ck', sql`slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
    uniqueIndex('categories_slug_uq').on(t.slug),
    index('categories_active_idx').on(t.isActive, t.sortOrder),
  ],
);

/** Default sub-groups. A business may override these with its own set. */
export const categoryGroups = pgTable(
  'category_groups',
  {
    id: primaryId(),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('category_groups_uq').on(t.categoryId, t.name)],
);

/**
 * The dynamic form fields an offering in this category carries.
 *
 * Drives both the owner's item form and the shape of `offerings.attributes`.
 * The prototype's `category.fields[]` — 'duration', 'capacity', 'features',
 * 'veg', 'availability', 'category' — becomes rows here.
 */
export const categoryFields = pgTable(
  'category_fields',
  {
    id: primaryId(),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    fieldKey: text('field_key').notNull(),
    fieldType: text('field_type').notNull(),
    label: text('label').notNull(),
    /** Select options, min/max, placeholder — whatever the field type needs. */
    options: jsonb('options').$type<Record<string, unknown>>(),
    isRequired: boolean('is_required').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('category_fields_uq').on(t.categoryId, t.fieldKey)],
);

/** The standard filterable amenities offered to businesses in this category. */
export const categoryAmenities = pgTable(
  'category_amenities',
  {
    id: primaryId(),
    categoryId: fk('category_id')
      .notNull()
      .references(() => categories.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [uniqueIndex('category_amenities_uq').on(t.categoryId, t.name)],
);

/**
 * An owner asking for a category that does not exist yet.
 *
 * This gates a two-stage workflow that is easy to lose in a rewrite: the
 * business waits behind its category, is parked under a fallback category so
 * every screen keeps working, is held OUT of the business review queue, and
 * moves into it automatically the moment the category is approved.
 *
 * A category needs review because it changes what every owner can list under —
 * unlike a business feature, which describes one business and goes live
 * immediately.
 */
export const categoryRequests = pgTable(
  'category_requests',
  {
    id: primaryId(),
    requestedByOwnerId: fk('requested_by_owner_id')
      .notNull()
      .references(() => businessOwners.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** The business the owner wants to list under it, if they named one. */
    businessName: text('business_name'),
    status: categoryRequestStatusEnum('status').notNull().default('PENDING_REVIEW'),
    /** Required on rejection — the dialog will not submit empty. */
    rejectionReason: text('rejection_reason'),
    decidedByUserId: fk('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    /** Set on approval, so waiting businesses can be migrated across. */
    createdCategoryId: fk('created_category_id').references(() => categories.id, {
      onDelete: 'set null',
    }),
    ...timestamps(),
  },
  (t) => [
    // The admin queue: oldest pending first.
    index('category_requests_queue_idx').on(t.status, t.createdAt),
    index('category_requests_owner_idx').on(t.requestedByOwnerId),
  ],
);
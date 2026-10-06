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
  customType,
  index,
  integer,
  pgSequence,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import {
  authProviderEnum,
  ownerStatusEnum,
  roleEnum,
  sessionAudienceEnum,
  sessionRevocationReasonEnum,
  userStatusEnum,
} from './_enums.js';
import { createdAt, deletedAt, fk, primaryId, readableCode, timestamps, updatedAt } from './_shared.js';
import { areas } from './location.js';
import { businesses } from './business.js';
import { categories } from './category.js';
import { comparisonGroups } from './offering.js';

/** Case-insensitive text, so email uniqueness is enforced by the database
 *  rather than by remembering to lowercase in every code path. */
const citext = customType<{ data: string; driverData: string }>({
  dataType: () => 'citext',
});

/* ---------------------------------------------------------------------------
 * Identity
 *
 * An owner is a ROLE A USER HOLDS, not a parallel account type. The prototype
 * keeps `users` and `owners` as separate arrays; unifying them is what lets one
 * person shop and run four businesses with one login, and it is the
 * precondition for adding Google/Apple sign-in without a migration.
 * ------------------------------------------------------------------------- */

/** Readable user codes: USR-2026-00000123 (readableCode). */
export const userCodeSeq = pgSequence('user_code_seq', { startWith: 1 });

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    code: readableCode('USR', 'user_code_seq'),
    email: citext('email').notNull(),
    name: text('name').notNull(),
    phone: varchar('phone', { length: 32 }),
    status: userStatusEnum('status').notNull().default('ACTIVE'),
    /** Used for distances and "near me" before any GPS fix. */
    homeAreaId: fk('home_area_id').references(() => areas.id, { onDelete: 'set null' }),
    emailVerifiedAt: timestamp('email_verified_at', { withTimezone: true, mode: 'date' }),
    lastLoginAt: timestamp('last_login_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
    deletedAt: deletedAt(),
  },
  (t) => [
    // Partial: a soft-deleted account must not block the address being reused.
    uniqueIndex('users_email_uq').on(t.email).where(sql`deleted_at IS NULL`),
    uniqueIndex('users_code_uq').on(t.code),
    index('users_status_created_idx').on(t.status, t.createdAt.desc()),
    // Admin console: server-side search by name or email fragment.
    index('users_name_trgm').using('gin', sql`${t.name} gin_trgm_ops`),
    index('users_email_trgm').using('gin', sql`(${t.email}::text) gin_trgm_ops`),
  ],
);

/**
 * Credentials, keyed by provider.
 *
 * A password is one identity among several rather than a column on `users`, so
 * adding Google/Apple/phone-OTP later is an INSERT, not a schema change
 * (brief §16).
 */
export const authIdentities = pgTable(
  'auth_identities',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    provider: authProviderEnum('provider').notNull(),
    /** The provider's own id. For PASSWORD this is the email. */
    providerUserId: citext('provider_user_id').notNull(),
    /** Argon2id. Null for every provider except PASSWORD. */
    passwordHash: text('password_hash'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_uq').on(t.provider, t.providerUserId),
    index('auth_identities_user_idx').on(t.userId),
  ],
);

/**
 * Staff. Separate from `users` so an ordinary account cannot be escalated by
 * flipping a column, and so admin-only fields (TOTP secret) never sit on a row
 * that ordinary queries select.
 */
export const adminUsers = pgTable(
  'admin_users',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    role: roleEnum('role').notNull().default('REVIEWER'),
    /** Encrypted at rest by the application. Never logged, never returned. */
    totpSecretEncrypted: text('totp_secret_encrypted'),
    totpConfirmedAt: timestamp('totp_confirmed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [index('admin_users_role_idx').on(t.role)],
);

/** The Business Portal principal. One per user who lists anything. */
export const businessOwners = pgTable(
  'business_owners',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .unique()
      .references(() => users.id, { onDelete: 'cascade' }),
    /** Denormalised from users for the admin owner list, which sorts on it. */
    displayName: text('display_name').notNull(),
    contactEmail: citext('contact_email').notNull(),
    contactPhone: varchar('contact_phone', { length: 32 }),
    status: ownerStatusEnum('status').notNull().default('PENDING_REVIEW'),
    joinedAt: createdAt(),
    updatedAt: updatedAt(),
    deletedAt: deletedAt(),
  },
  (t) => [
    index('business_owners_status_idx').on(t.status),
    index('business_owners_name_idx').on(t.displayName),
  ],
);

/**
 * The MAIN session: one row per sign-in, per frontend.
 *
 * `audience` fixes which frontend the session belongs to, and with it the
 * absolute lifetime (USER longest, ADMIN shortest — see SECURITY.md §4).
 * `expiresAt` is absolute: rotating refresh tokens never extends it, so a
 * stolen session dies on schedule however actively it is used.
 *
 * Revoking a session kills its whole token family, and — through the Redis
 * revocation marker — every access token issued under it within seconds.
 */
export const userSessions = pgTable(
  'user_sessions',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    audience: sessionAudienceEnum('audience').notNull(),
    userAgent: text('user_agent'),
    ipAddress: varchar('ip_address', { length: 64 }),
    createdAt: createdAt(),
    /** Absolute end of the session. Never moved forward. */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    /** Last successful refresh. Drives the admin idle timeout. */
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true, mode: 'date' }),
    /** Last password (re-)entry. Sensitive admin actions check its age. */
    authenticatedAt: timestamp('authenticated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Set when a second factor was verified. Null until MFA ships. */
    mfaVerifiedAt: timestamp('mfa_verified_at', { withTimezone: true, mode: 'date' }),
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),
    revokedReason: sessionRevocationReasonEnum('revoked_reason'),
  },
  (t) => [
    index('user_sessions_user_idx').on(t.userId, t.createdAt.desc()),
    // Only live sessions are ever listed or counted against the session limit.
    index('user_sessions_active_idx')
      .on(t.userId, t.audience, t.createdAt)
      .where(sql`revoked_at IS NULL`),
    // The scheduler's sweep of sessions past their absolute expiry.
    index('user_sessions_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Refresh tokens.
 *
 * Stored **hashed** — a database read must not yield usable credentials.
 * Rotated on every use: `usedAt` plus `replacedById` make reuse detectable, and
 * a replayed token revokes the entire session family rather than just failing.
 * Kept in Postgres rather than Redis so they survive a flush and stay auditable.
 */
export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    id: primaryId(),
    sessionId: fk('session_id')
      .notNull()
      .references(() => userSessions.id, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    usedAt: timestamp('used_at', { withTimezone: true, mode: 'date' }),
    replacedById: fk('replaced_by_id').references((): AnyPgColumn => refreshTokens.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash),
    index('refresh_tokens_session_idx').on(t.sessionId),
    // Supports the scheduler's nightly sweep of expired rows.
    index('refresh_tokens_expiry_idx').on(t.expiresAt),
  ],
);

/**
 * Failed sign-in attempts, for lockout and backoff (brief §16).
 * Counted per identifier and per IP so neither a targeted nor a spray attack
 * can be run without tripping a limit.
 */
export const authAttempts = pgTable(
  'auth_attempts',
  {
    id: primaryId(),
    identifier: citext('identifier').notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    successful: boolean('successful').notNull().default(false),
    attemptedAt: createdAt(),
  },
  (t) => [
    index('auth_attempts_identifier_idx').on(t.identifier, t.attemptedAt.desc()),
    index('auth_attempts_ip_idx').on(t.ipAddress, t.attemptedAt.desc()),
  ],
);

/**
 * Shopper-side saved state. Straight ports of the prototype's `favorites`,
 * `saved`, `recent` and `history` arrays.
 */
export const favorites = pgTable(
  'favorites',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('favorites_uq').on(t.userId, t.businessId),
    index('favorites_business_idx').on(t.businessId),
  ],
);

export const savedComparisons = pgTable(
  'saved_comparisons',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    comparisonGroupId: fk('comparison_group_id')
      .notNull()
      .references(() => comparisonGroups.id, { onDelete: 'cascade' }),
    areaId: fk('area_id').references(() => areas.id, { onDelete: 'set null' }),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('saved_comparisons_uq').on(t.userId, t.comparisonGroupId)],
);

export const recentlyViewed = pgTable(
  'recently_viewed',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    viewedAt: createdAt(),
  },
  (t) => [
    uniqueIndex('recently_viewed_uq').on(t.userId, t.businessId),
    index('recently_viewed_recent_idx').on(t.userId, t.viewedAt.desc()),
  ],
);

export const searchHistory = pgTable(
  'search_history',
  {
    id: primaryId(),
    userId: fk('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
    query: text('query').notNull(),
    categoryId: fk('category_id').references(() => categories.id, { onDelete: 'set null' }),
    areaId: fk('area_id').references(() => areas.id, { onDelete: 'set null' }),
    resultCount: integer('result_count'),
    searchedAt: createdAt(),
  },
  (t) => [index('search_history_user_idx').on(t.userId, t.searchedAt.desc())],
);

/** A business owner's email preferences — one row per owner, shared by all their businesses. */
export const ownerSettings = pgTable('owner_settings', {
  ownerId: fk('owner_id')
    .primaryKey()
    .references(() => businessOwners.id, { onDelete: 'cascade' }),
  emailApprovals: boolean('email_approvals').notNull().default(true),
  weeklyReport: boolean('weekly_report').notNull().default(true),
  competitorPriceAlerts: boolean('competitor_price_alerts').notNull().default(false),
  updatedAt: updatedAt(),
});

/** Notification and display preferences. One row per user. */
export const userSettings = pgTable('user_settings', {
  userId: fk('user_id')
    .primaryKey()
    .references(() => users.id, { onDelete: 'cascade' }),
  priceAlerts: boolean('price_alerts').notNull().default(true),
  offerAlerts: boolean('offer_alerts').notNull().default(true),
  reviewReplyAlerts: boolean('review_reply_alerts').notNull().default(false),
  emailEnabled: boolean('email_enabled').notNull().default(true),
  pushEnabled: boolean('push_enabled').notNull().default(true),
  vegetarianOnly: boolean('vegetarian_only').notNull().default(false),
  updatedAt: updatedAt(),
});

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
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  varchar,
  check,
} from 'drizzle-orm/pg-core';
import {
  analyticsEventEnum,
  approvalActionEnum,
  approvalEntityEnum,
  jobRunStatusEnum,
  mediaKindEnum,
  notificationAudienceEnum,
  notificationTypeEnum,
  publicationStatusEnum,
  scanConfidenceEnum,
  scanJobStatusEnum,
  securityEventTypeEnum,
  securitySeverityEnum,
  webhookStatusEnum,
} from './_enums.js';
import { amountMinor, createdAt, fk, primaryId, timestamps } from './_shared.js';
import { businesses } from './business.js';
import { businessOwners, users } from './identity.js';
import { offerings } from './offering.js';

/* ---------------------------------------------------------------------------
 * Approvals — one queue, many entity types.
 *
 * Which is what the admin approvals screen already is: three tabs over one
 * pipeline. Modelling it as one table means "how long has this waited" and
 * "who decided what" are answerable across businesses, offerings and category
 * requests with one query.
 * ------------------------------------------------------------------------- */

export const approvalRequests = pgTable(
  'approval_requests',
  {
    id: primaryId(),
    entityType: approvalEntityEnum('entity_type').notNull(),
    entityId: fk('entity_id').notNull(),
    /** Denormalised for the queue view, which groups by business. */
    businessId: fk('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    status: publicationStatusEnum('status').notNull().default('PENDING_REVIEW'),
    submittedByUserId: fk('submitted_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    submittedAt: createdAt(),
    decidedByUserId: fk('decided_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' }),
    /** Required on rejection. The admin dialog will not submit empty. */
    reason: text('reason'),
  },
  (t) => [
    index('approval_requests_queue_idx')
      .on(t.entityType, t.submittedAt)
      .where(sql`status = 'PENDING_REVIEW'`),
    index('approval_requests_entity_idx').on(t.entityType, t.entityId),
    index('approval_requests_business_idx').on(t.businessId),
  ],
);

/** Every transition, append-only. The audit trail for a single submission. */
export const approvalActions = pgTable(
  'approval_actions',
  {
    id: primaryId(),
    approvalRequestId: fk('approval_request_id')
      .notNull()
      .references(() => approvalRequests.id, { onDelete: 'cascade' }),
    action: approvalActionEnum('action').notNull(),
    actorUserId: fk('actor_user_id').references(() => users.id, { onDelete: 'set null' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('approval_actions_request_idx').on(t.approvalRequestId, t.createdAt)],
);

/* ---------------------------------------------------------------------------
 * Notifications — three inboxes.
 * ------------------------------------------------------------------------- */

export const notifications = pgTable(
  'notifications',
  {
    id: primaryId(),
    audience: notificationAudienceEnum('audience').notNull(),
    /** Set for USER notifications. */
    userId: fk('user_id').references(() => users.id, { onDelete: 'cascade' }),
    /** Set for OWNER notifications, so they scope to the signed-in owner. */
    ownerId: fk('owner_id').references(() => businessOwners.id, { onDelete: 'cascade' }),
    /** Which business it concerns — the portal filters by the active one. */
    businessId: fk('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    type: notificationTypeEnum('type').notNull(),
    title: text('title').notNull(),
    body: text('body').notNull().default(''),
    /** Deep link followed when the row is clicked. */
    link: text('link'),
    readAt: timestamp('read_at', { withTimezone: true, mode: 'date' }),
    /**
     * `<outbox event id>:<recipient>` — delivery is at-least-once, so a
     * redelivered event must not notify anyone twice.
     */
    dedupeKey: text('dedupe_key'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('notifications_dedupe_uq').on(t.dedupeKey).where(sql`dedupe_key IS NOT NULL`),
    index('notifications_user_idx').on(t.audience, t.userId, t.createdAt.desc(), t.id.desc()),
    index('notifications_owner_idx').on(t.ownerId, t.createdAt.desc(), t.id.desc()),
    // Unread badge counts are read on EVERY page load, so they get their own
    // partial index rather than scanning the inbox.
    index('notifications_unread_idx')
      .on(t.audience, t.userId, t.ownerId)
      .where(sql`read_at IS NULL`),
  ],
);

/**
 * Transactional outbox for domain events ("business approved", "review
 * posted", "price dropped"…). The row is written in the SAME transaction as
 * the change, so an event exists if and only if the change committed; the
 * API then queues it, and a sweep re-queues anything Redis lost. Consumers
 * (notifications) are idempotent per event id.
 */
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: primaryId(),
    type: text('type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull().default({}),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true, mode: 'date' }),
    createdAt: createdAt(),
  },
  (t) => [index('outbox_events_pending_idx').on(t.createdAt).where(sql`dispatched_at IS NULL`)],
);

/* ---------------------------------------------------------------------------
 * Media
 * ------------------------------------------------------------------------- */

export interface MediaVariantRecord {
  key: string;
  width: number;
  height: number;
  bytes: number;
}

export const media = pgTable(
  'media',
  {
    id: primaryId(),
    kind: mediaKindEnum('kind').notNull(),
    /** Object-storage key. The bytes never pass through the API. */
    storageKey: text('storage_key').notNull(),
    mimeType: varchar('mime_type', { length: 128 }).notNull(),
    byteSize: integer('byte_size'),
    width: integer('width'),
    height: integer('height'),
    /**
     * Processed variants, written by the scheduler: `{ "medium.webp": { key,
     * width, height, bytes } }` — keys are under `public/<mediaId>/`.
     */
    variants: jsonb('variants').$type<Record<string, MediaVariantRecord>>().notNull().default({}),
    uploadedByUserId: fk('uploaded_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    /**
     * The business the upload was authorised for. Confirming checks the
     * caller still owns it — the id in the request is never trusted alone.
     */
    businessId: fk('business_id').references(() => businesses.id, { onDelete: 'cascade' }),
    /** PENDING (uploaded, unvalidated) → PROCESSING (validated) → READY (variants exist) | REJECTED. */
    status: text('status').notNull().default('PENDING'),
    /** The owner's own label for the file. Display only — never part of a key or path. */
    originalFilename: text('original_filename'),
    /** Tiny blurred preview (data URI) shown while the real image loads. */
    placeholder: text('placeholder'),
    rejectedReason: text('rejected_reason'),
    /** Null until the client confirms the upload; swept nightly if it stays null. */
    confirmedAt: timestamp('confirmed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [
    check('media_dimensions_ck', sql`(byte_size IS NULL OR byte_size > 0) AND (width IS NULL OR width > 0) AND (height IS NULL OR height > 0)`),
    check('media_status_ck', sql`status IN ('PENDING', 'PROCESSING', 'READY', 'REJECTED')`),
    index('media_business_idx').on(t.businessId, t.createdAt.desc()),
    uniqueIndex('media_storage_key_uq').on(t.storageKey),
    index('media_orphan_idx')
      .on(t.createdAt)
      .where(sql`confirmed_at IS NULL`),
  ],
);

/** Photos attached to a business, with one marked as the cover. */
export const businessPhotos = pgTable(
  'business_photos',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    mediaId: fk('media_id').references(() => media.id, { onDelete: 'cascade' }),
    /**
     * When null, the deterministic SVG illustration is rendered instead. That
     * fallback is why 120 seeded businesses look designed rather than empty,
     * and it stays in production for businesses with no photo yet.
     */
    artSeed: text('art_seed'),
    isCover: boolean('is_cover').notNull().default(false),
    sortOrder: integer('sort_order').notNull().default(0),
    createdAt: createdAt(),
  },
  (t) => [
    index('business_photos_business_idx').on(t.businessId, t.sortOrder),
    uniqueIndex('business_photos_one_cover_uq')
      .on(t.businessId)
      .where(sql`is_cover = true`),
  ],
);

/* ---------------------------------------------------------------------------
 * Menu scanning
 * ------------------------------------------------------------------------- */

export const scanJobs = pgTable(
  'scan_jobs',
  {
    id: primaryId(),
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    status: scanJobStatusEnum('status').notNull().default('QUEUED'),
    /** Up to five uploaded pages, as media ids. */
    imageMediaIds: jsonb('image_media_ids').$type<string[]>().notNull().default([]),
    provider: text('provider'),
    error: text('error'),
    createdByUserId: fk('created_by_user_id').references(() => users.id, { onDelete: 'set null' }),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
    ...timestamps(),
  },
  (t) => [index('scan_jobs_business_idx').on(t.businessId, t.createdAt.desc())],
);

/**
 * What the vision model extracted, before a human looks at it.
 *
 * AI output NEVER publishes anything. These rows are a proposal the owner
 * reviews and edits, and importing them creates offerings as DRAFT or
 * PENDING_REVIEW — there is no path from here to APPROVED that skips the
 * normal approval workflow.
 */
export const scanResults = pgTable(
  'scan_results',
  {
    id: primaryId(),
    scanJobId: fk('scan_job_id')
      .notNull()
      .references(() => scanJobs.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    amountMinor: amountMinor('amount_minor'),
    groupName: text('group_name'),
    description: text('description'),
    isVegetarian: boolean('is_vegetarian'),
    confidence: scanConfidenceEnum('confidence').notNull().default('HIGH'),
    /** Set when the business already lists this name — an update, not a new row. */
    matchedOfferingId: fk('matched_offering_id').references(() => offerings.id, {
      onDelete: 'set null',
    }),
    isSelected: boolean('is_selected').notNull().default(true),
    sortOrder: integer('sort_order').notNull().default(0),
  },
  (t) => [
    check('scan_results_amount_ck', sql`amount_minor IS NULL OR amount_minor BETWEEN 0 AND 1000000000`),index('scan_results_job_idx').on(t.scanJobId, t.sortOrder)],
);

/* ---------------------------------------------------------------------------
 * Audit, analytics and service bookkeeping
 * ------------------------------------------------------------------------- */

/** Every privileged mutation. Partitioned by month — it only grows. */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: fk('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    actorUserId: fk('actor_user_id'),
    actorRole: text('actor_role'),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: fk('entity_id'),
    before: jsonb('before').$type<Record<string, unknown>>(),
    after: jsonb('after').$type<Record<string, unknown>>(),
    ipAddress: varchar('ip_address', { length: 64 }),
    requestId: varchar('request_id', { length: 64 }),
    createdAt: createdAt(),
  },
  (t) => [
    index('audit_logs_entity_idx').on(t.entityType, t.entityId, t.createdAt.desc()),
    index('audit_logs_actor_idx').on(t.actorUserId, t.createdAt.desc()),
  ],
);

/**
 * Security events — who TRIED what: sign-ins, refreshes, denials, rate-limit
 * trips, webhook forgeries. Partitioned by month like audit_logs, and far
 * higher volume, which is why it is a separate table: an attack must not be
 * able to bury the privileged-change history in noise.
 *
 * Append-only. The application role has INSERT and SELECT here, never UPDATE
 * or DELETE (see src/db/grants.ts). Never holds a token, password or secret —
 * `metadata` carries ids and reasons only.
 */
export const securityEvents = pgTable(
  'security_events',
  {
    id: fk('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    type: securityEventTypeEnum('type').notNull(),
    severity: securitySeverityEnum('severity').notNull().default('INFO'),
    userId: fk('user_id'),
    sessionId: fk('session_id'),
    service: text('service').notNull(),
    ipAddress: varchar('ip_address', { length: 64 }),
    userAgent: text('user_agent'),
    requestId: varchar('request_id', { length: 64 }),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    index('security_events_user_idx').on(t.userId, t.occurredAt.desc()),
    index('security_events_type_idx').on(t.type, t.occurredAt.desc()),
    // "Everything this IP did in the last hour" — the first incident query.
    index('security_events_ip_idx').on(t.ipAddress, t.occurredAt.desc()),
  ],
);

/**
 * Raw analytics events. Partitioned by month and dropped after 90 days.
 *
 * `sessionHash` rather than a user id or IP: enough to count distinct visitors,
 * not enough to identify one (brief §24 — no unnecessary PII).
 */
export const analyticsEvents = pgTable(
  'analytics_events',
  {
    id: fk('id')
      .notNull()
      .default(sql`uuid_generate_v7()`),
    eventType: analyticsEventEnum('event_type').notNull(),
    businessId: fk('business_id'),
    offeringId: fk('offering_id'),
    areaId: fk('area_id'),
    sessionHash: varchar('session_hash', { length: 64 }),
    properties: jsonb('properties').$type<Record<string, unknown>>().notNull().default({}),
    occurredAt: timestamp('occurred_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [index('analytics_events_business_idx').on(t.businessId, t.occurredAt.desc())],
);

/**
 * The rollup the Business Portal actually reads.
 *
 * Scanning raw events to draw the owner funnel would be a table scan per page
 * load. The scheduler writes this nightly and incrementally during the day.
 */
export const businessDailyMetrics = pgTable(
  'business_daily_metrics',
  {
    businessId: fk('business_id')
      .notNull()
      .references(() => businesses.id, { onDelete: 'cascade' }),
    date: date('date').notNull(),
    /** "Saw you" — appeared in search results or a comparison. */
    impressions: integer('impressions').notNull().default(0),
    /** "Viewed" — opened the business page. */
    views: integer('views').notNull().default(0),
    offeringViews: integer('offering_views').notNull().default(0),
    comparisonAppearances: integer('comparison_appearances').notNull().default(0),
    /** "Headed to you" — tapped directions or called. */
    directions: integer('directions').notNull().default(0),
    calls: integer('calls').notNull().default(0),
    /** "Confirmed visits" — redeemed an offer code at the counter. */
    confirmedVisits: integer('confirmed_visits').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => [
    uniqueIndex('business_daily_metrics_pk').on(t.businessId, t.date),
    index('business_daily_metrics_date_idx').on(t.date),
  ],
);

/**
 * Platform-wide searches per day and query text, recomputed from SEARCH
 * events by the rollup (idempotent). The admin console reads this, never the
 * raw event log. `query` is '' for a filter-only search (no text typed).
 */
export const searchTermDaily = pgTable(
  'search_term_daily',
  {
    date: date('date', { mode: 'string' }).notNull(),
    query: varchar('query', { length: 120 }).notNull(),
    searches: integer('searches').notNull().default(0),
    visitors: integer('visitors').notNull().default(0),
  },
  (t) => [uniqueIndex('search_term_daily_pk').on(t.date, t.query)],
);

/**
 * Durable webhook event store.
 *
 * The UNIQUE constraint is the whole idempotency strategy: a duplicate delivery
 * is a no-op at the database level rather than a race in application code,
 * which is the only way this stays correct under concurrent provider retries.
 */
export const webhookEvents = pgTable(
  'webhook_events',
  {
    id: primaryId(),
    provider: text('provider').notNull(),
    /** The provider's own event id. */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
    signatureVerified: boolean('signature_verified').notNull().default(false),
    status: webhookStatusEnum('status').notNull().default('RECEIVED'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: createdAt(),
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => [
    check('webhook_events_attempts_ck', sql`attempts >= 0`),
    uniqueIndex('webhook_events_idempotency_uq').on(t.provider, t.eventId),
    // The backlog query: what has been received but never handled.
    index('webhook_events_pending_idx')
      .on(t.receivedAt)
      .where(sql`status IN ('RECEIVED', 'PROCESSING', 'FAILED')`),
  ],
);

/** One row per scheduled job run, so a silently-wedged worker is visible. */
export const jobRuns = pgTable(
  'job_runs',
  {
    id: primaryId(),
    jobName: text('job_name').notNull(),
    status: jobRunStatusEnum('status').notNull().default('RUNNING'),
    startedAt: createdAt(),
    finishedAt: timestamp('finished_at', { withTimezone: true, mode: 'date' }),
    error: text('error'),
    metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
  },
  (t) => [index('job_runs_name_idx').on(t.jobName, t.startedAt.desc())],
);

/** Platform settings. One row, enforced by a CHECK on a constant primary key. */
export const platformSettings = pgTable('platform_settings', {
  id: integer('id').primaryKey().default(1),
  siteName: text('site_name').notNull().default('Equato'),
  supportEmail: text('support_email').notNull().default('support@equato.com'),
  maxSearchRadiusKm: integer('max_search_radius_km').notNull().default(25),
  autoApproveMinorEdits: boolean('auto_approve_minor_edits').notNull().default(false),
  requireOfferingImage: boolean('require_offering_image').notNull().default(false),
  maintenanceMode: boolean('maintenance_mode').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
}, () => [
  // The "one row" promise, actually enforced.
  check('platform_settings_singleton_ck', sql`id = 1`),
  check('platform_settings_radius_ck', sql`max_search_radius_km BETWEEN 1 AND 100`),
]);
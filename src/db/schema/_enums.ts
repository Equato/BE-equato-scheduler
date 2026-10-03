/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { pgEnum } from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------------------
 * Controlled vocabularies.
 *
 * Postgres enums rather than text + CHECK: an invalid status becomes impossible
 * at the storage layer, and the values are discoverable from the database
 * itself. Adding a value is `ALTER TYPE ... ADD VALUE`, which is cheap;
 * removing one is deliberate work, which is the right cost for a status that
 * gates whether data reaches the public.
 *
 * These mirror src/shared/domain/status.ts. That file is the application's view
 * of the same vocabulary; a test asserts they cannot drift apart.
 * ------------------------------------------------------------------------- */

/** Where a record sits in the approval workflow. Distinct from operating status. */
export const publicationStatusEnum = pgEnum('publication_status', [
  'DRAFT',
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'ARCHIVED',
]);

export const ownerStatusEnum = pgEnum('owner_status', [
  'PENDING_REVIEW',
  'ACTIVE',
  'SUSPENDED',
]);

export const userStatusEnum = pgEnum('user_status', ['ACTIVE', 'BLOCKED']);

export const roleEnum = pgEnum('role', [
  'USER',
  'BUSINESS_OWNER',
  'REVIEWER',
  'MODERATOR',
  'ADMIN',
  'SUPER_ADMIN',
]);

export const authProviderEnum = pgEnum('auth_provider', [
  'PASSWORD',
  'GOOGLE',
  'APPLE',
  'PHONE',
]);

export const reviewStatusEnum = pgEnum('review_status', ['PUBLISHED', 'FLAGGED', 'HIDDEN']);

/** A review is about the place, or about one item. The two never mix. */
export const reviewTargetEnum = pgEnum('review_target', ['BUSINESS', 'OFFERING']);

/**
 * Offers carry only an owner-controlled switch. Expired and Scheduled are
 * derived from valid_from/valid_to at query time, never stored — a stored flag
 * would need a cron job to stay true and would still be wrong between runs.
 */
export const offerStatusEnum = pgEnum('offer_status', ['ACTIVE', 'PAUSED']);

export const categoryRequestStatusEnum = pgEnum('category_request_status', [
  'PENDING_REVIEW',
  'APPROVED',
  'REJECTED',
]);

export const reportStatusEnum = pgEnum('report_status', ['OPEN', 'RESOLVED']);

export const reportTargetEnum = pgEnum('report_target', [
  'REVIEW',
  'PRICE',
  'BUSINESS',
  'OFFERING',
]);

/** What an approval request is about. One queue, many entity types. */
export const approvalEntityEnum = pgEnum('approval_entity', [
  'BUSINESS',
  'OFFERING',
  'CATEGORY_REQUEST',
  'BUSINESS_EDIT',
  /** An edit to an APPROVED offering, held as a revision while the live version keeps showing. */
  'OFFERING_EDIT',
  /** A batch of offerings imported from a menu scan (Phase 15). */
  'SCAN_IMPORT',
]);

export const approvalActionEnum = pgEnum('approval_action', [
  'SUBMITTED',
  'RESUBMITTED',
  'APPROVED',
  'REJECTED',
  'SUSPENDED',
  'RESTORED',
  'ARCHIVED',
]);

/** How an offering behaves against the business's opening hours. */
export const availabilityModeEnum = pgEnum('availability_mode', [
  'ALWAYS',
  'WINDOW',
  'UNAVAILABLE',
]);

/** Manual entry versus bulk import from a scanned menu photo. */
export const offeringSourceEnum = pgEnum('offering_source', ['MANUAL', 'SCAN']);

export const scanJobStatusEnum = pgEnum('scan_job_status', [
  'QUEUED',
  'PROCESSING',
  'READY',
  'FAILED',
  'IMPORTED',
]);

export const scanConfidenceEnum = pgEnum('scan_confidence', ['HIGH', 'MEDIUM', 'LOW']);

/** Which inbox a notification belongs to. Three audiences, three inboxes. */
export const notificationAudienceEnum = pgEnum('notification_audience', [
  'USER',
  'OWNER',
  'ADMIN',
]);

export const notificationTypeEnum = pgEnum('notification_type', [
  'APPROVED',
  'REJECTED',
  'MESSAGE',
  'PRICE_DROP',
  'OFFER',
  'SAVED',
  'REVIEW',
  'BUSINESS',
  'OWNER',
  'PRODUCT',
  'USER',
  'REPORT',
]);

/** Rollout state of a city, so "coming soon" is data rather than a hardcoded list. */
export const cityStatusEnum = pgEnum('city_status', ['LIVE', 'COMING_SOON', 'PLANNED']);

export const mediaKindEnum = pgEnum('media_kind', [
  'BUSINESS_PHOTO',
  'BUSINESS_LOGO',
  'OFFERING_IMAGE',
  'OFFER_IMAGE',
  'SCAN_UPLOAD',
]);

export const removalStatusEnum = pgEnum('removal_status', [
  'OPEN',
  'REJECTED',
  'SUSPENDED',
  'ARCHIVED',
]);

/** Analytics event types. Mirrors the prototype's funnel: seen → viewed → headed → visited. */
export const analyticsEventEnum = pgEnum('analytics_event', [
  'IMPRESSION',
  'BUSINESS_VIEW',
  'OFFERING_VIEW',
  'COMPARISON_VIEW',
  'SEARCH',
  'DIRECTIONS',
  'CALL',
  'FAVORITE',
  'OFFER_CLAIM',
  'OFFER_REDEEM',
  // Content lifecycle (Phase 17): a review posted, an item/business submitted, a staff decision.
  'REVIEW',
  'SUBMISSION',
  'APPROVAL',
  'REJECTION',
]);

export const webhookStatusEnum = pgEnum('webhook_status', [
  'RECEIVED',
  'PROCESSING',
  'PROCESSED',
  'FAILED',
  'SKIPPED',
]);

export const jobRunStatusEnum = pgEnum('job_run_status', [
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
]);

/** Mirrors SessionAudience in src/shared/domain/status.ts. */
export const sessionAudienceEnum = pgEnum('session_audience', ['USER', 'BUSINESS', 'ADMIN']);

export const sessionRevocationReasonEnum = pgEnum('session_revocation_reason', [
  'LOGOUT',
  'USER_REVOKED',
  'PASSWORD_CHANGED',
  'REFRESH_REUSE',
  'SESSION_LIMIT',
  'ADMIN_FORCED',
  'ACCOUNT_BLOCKED',
  'IDLE_TIMEOUT',
  'SUSPICIOUS',
]);

export const securityEventTypeEnum = pgEnum('security_event_type', [
  'LOGIN_SUCCEEDED',
  'LOGIN_FAILED',
  'LOGIN_LOCKED',
  'LOGOUT',
  'TOKEN_REFRESHED',
  'REFRESH_REJECTED',
  'REFRESH_REUSE_DETECTED',
  'SESSION_REVOKED',
  'PASSWORD_CHANGED',
  'MFA_ENROLLED',
  'REAUTHENTICATED',
  'ROLE_CHANGED',
  'ACCESS_DENIED',
  'CROSS_BUSINESS_ACCESS',
  'RATE_LIMITED',
  'TEMPORARY_BLOCK',
  'CSRF_REJECTED',
  'QUERY_REJECTED',
  'WEBHOOK_SIGNATURE_FAILED',
  'WEBHOOK_REPLAY',
  'SUSPICIOUS_ACTIVITY',
]);

export const securitySeverityEnum = pgEnum('security_severity', ['INFO', 'WARNING', 'CRITICAL']);
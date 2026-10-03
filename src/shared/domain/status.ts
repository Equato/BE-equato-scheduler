/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Status vocabularies.
 *
 * Ported from the prototype's `js/store.js`, widened to the explicit enums the
 * production brief requires. The prototype's shorter names map 1:1 — see
 * ARCHITECTURE.md §7 for the table.
 */

/** Where a record sits in the approval workflow. */
export const PublicationStatus = {
  DRAFT: 'DRAFT',
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
  SUSPENDED: 'SUSPENDED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type PublicationStatus = (typeof PublicationStatus)[keyof typeof PublicationStatus];

/**
 * The only status in which a record is visible to shoppers.
 *
 * This is the production form of the prototype's `Store.isPublic()` /
 * `Store.publicItems()`. Brief rule #24: every public query respects it, and it
 * lives in exactly one place so it cannot drift.
 */
export const isPubliclyVisible = (status: PublicationStatus): boolean =>
  status === PublicationStatus.APPROVED;

export const OwnerStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type OwnerStatus = (typeof OwnerStatus)[keyof typeof OwnerStatus];

export const UserStatus = {
  ACTIVE: 'ACTIVE',
  BLOCKED: 'BLOCKED',
} as const;
export type UserStatus = (typeof UserStatus)[keyof typeof UserStatus];

export const ReviewStatus = {
  PUBLISHED: 'PUBLISHED',
  FLAGGED: 'FLAGGED',
  HIDDEN: 'HIDDEN',
} as const;
export type ReviewStatus = (typeof ReviewStatus)[keyof typeof ReviewStatus];

/**
 * Offers have no review step, so they carry only an owner-controlled switch.
 * Expired and Scheduled are *derived from dates*, never stored — the prototype
 * does the same (`offerExpired`, `offerScheduled`).
 */
export const OfferStatus = {
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
} as const;
export type OfferStatus = (typeof OfferStatus)[keyof typeof OfferStatus];

export const CategoryRequestStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type CategoryRequestStatus =
  (typeof CategoryRequestStatus)[keyof typeof CategoryRequestStatus];

export const ReportStatus = { OPEN: 'OPEN', RESOLVED: 'RESOLVED' } as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

export const ScanJobStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  READY: 'READY',
  FAILED: 'FAILED',
  IMPORTED: 'IMPORTED',
} as const;
export type ScanJobStatus = (typeof ScanJobStatus)[keyof typeof ScanJobStatus];

export const Role = {
  USER: 'USER',
  BUSINESS_OWNER: 'BUSINESS_OWNER',
  REVIEWER: 'REVIEWER',
  MODERATOR: 'MODERATOR',
  ADMIN: 'ADMIN',
  SUPER_ADMIN: 'SUPER_ADMIN',
} as const;
export type Role = (typeof Role)[keyof typeof Role];

/** Roles that may act on the admin console. */
export const STAFF_ROLES: readonly Role[] = [
  Role.REVIEWER,
  Role.MODERATOR,
  Role.ADMIN,
  Role.SUPER_ADMIN,
];

export const isStaff = (role: Role): boolean => STAFF_ROLES.includes(role);

/**
 * Legal transitions. Anything not listed is rejected by the workflow engine
 * rather than silently applied, so an invalid state change fails loudly.
 */
export const PUBLICATION_TRANSITIONS: Readonly<Record<PublicationStatus, readonly PublicationStatus[]>> =
  {
    DRAFT: [PublicationStatus.PENDING_REVIEW, PublicationStatus.ARCHIVED],
    PENDING_REVIEW: [
      PublicationStatus.APPROVED,
      PublicationStatus.REJECTED,
      PublicationStatus.DRAFT,
    ],
    // An approved record edited by its owner goes back for review — the
    // prototype's rule 3: "editing an approved item re-opens review".
    APPROVED: [
      PublicationStatus.PENDING_REVIEW,
      PublicationStatus.SUSPENDED,
      PublicationStatus.ARCHIVED,
    ],
    REJECTED: [PublicationStatus.PENDING_REVIEW, PublicationStatus.ARCHIVED],
    SUSPENDED: [PublicationStatus.APPROVED, PublicationStatus.ARCHIVED],
    ARCHIVED: [],
  };

export const canTransition = (from: PublicationStatus, to: PublicationStatus): boolean =>
  PUBLICATION_TRANSITIONS[from].includes(to);

/**
 * Which frontend a main session belongs to.
 *
 * One identity, three session kinds. A person who shops and runs businesses
 * has one account but separate USER and BUSINESS sessions, because the two
 * carry different lifetimes (USER longest, ADMIN shortest) and a stolen
 * shopper session must not open the Business Portal.
 */
export const SessionAudience = {
  USER: 'USER',
  BUSINESS: 'BUSINESS',
  ADMIN: 'ADMIN',
} as const;
export type SessionAudience = (typeof SessionAudience)[keyof typeof SessionAudience];

/** Why a session ended early. Recorded on the session row and in security events. */
export const SessionRevocationReason = {
  LOGOUT: 'LOGOUT',
  USER_REVOKED: 'USER_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  REFRESH_REUSE: 'REFRESH_REUSE',
  SESSION_LIMIT: 'SESSION_LIMIT',
  ADMIN_FORCED: 'ADMIN_FORCED',
  ACCOUNT_BLOCKED: 'ACCOUNT_BLOCKED',
  IDLE_TIMEOUT: 'IDLE_TIMEOUT',
  SUSPICIOUS: 'SUSPICIOUS',
} as const;
export type SessionRevocationReason =
  (typeof SessionRevocationReason)[keyof typeof SessionRevocationReason];

/**
 * Security events — high-volume, append-only, distinct from the audit log.
 * The audit log answers "who changed what"; this answers "who tried what".
 */
export const SecurityEventType = {
  LOGIN_SUCCEEDED: 'LOGIN_SUCCEEDED',
  LOGIN_FAILED: 'LOGIN_FAILED',
  LOGIN_LOCKED: 'LOGIN_LOCKED',
  LOGOUT: 'LOGOUT',
  TOKEN_REFRESHED: 'TOKEN_REFRESHED',
  REFRESH_REJECTED: 'REFRESH_REJECTED',
  REFRESH_REUSE_DETECTED: 'REFRESH_REUSE_DETECTED',
  SESSION_REVOKED: 'SESSION_REVOKED',
  PASSWORD_CHANGED: 'PASSWORD_CHANGED',
  MFA_ENROLLED: 'MFA_ENROLLED',
  REAUTHENTICATED: 'REAUTHENTICATED',
  ROLE_CHANGED: 'ROLE_CHANGED',
  ACCESS_DENIED: 'ACCESS_DENIED',
  CROSS_BUSINESS_ACCESS: 'CROSS_BUSINESS_ACCESS',
  RATE_LIMITED: 'RATE_LIMITED',
  TEMPORARY_BLOCK: 'TEMPORARY_BLOCK',
  CSRF_REJECTED: 'CSRF_REJECTED',
  QUERY_REJECTED: 'QUERY_REJECTED',
  WEBHOOK_SIGNATURE_FAILED: 'WEBHOOK_SIGNATURE_FAILED',
  WEBHOOK_REPLAY: 'WEBHOOK_REPLAY',
  SUSPICIOUS_ACTIVITY: 'SUSPICIOUS_ACTIVITY',
} as const;
export type SecurityEventType = (typeof SecurityEventType)[keyof typeof SecurityEventType];

export const SecuritySeverity = { INFO: 'INFO', WARNING: 'WARNING', CRITICAL: 'CRITICAL' } as const;
export type SecuritySeverity = (typeof SecuritySeverity)[keyof typeof SecuritySeverity];
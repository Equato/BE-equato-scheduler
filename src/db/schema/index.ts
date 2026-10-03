/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Drizzle schema — the executable form of IMPLEMENTATION_PLAN.md §4 and §5.
 *
 * Two rules hold across every table here:
 *
 *   1. Publication status is not operating status. Whether a business is
 *      approved is stored; whether it is open right now is derived from its
 *      hours at query time and never written down.
 *
 *   2. Only APPROVED rows are ever publicly visible, and that is enforced in
 *      one place rather than repeated per query.
 */
export * from './_enums.js';
export * from './_shared.js';
export * from './identity.js';
export * from './location.js';
export * from './category.js';
export * from './business.js';
export * from './offering.js';
export * from './review.js';
export * from './offer.js';
export * from './ops.js';
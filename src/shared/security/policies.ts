/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { z } from 'zod';
import type { LimitRule, RateDimension, RatePolicy } from './rate-limit.js';

/**
 * Every rate-limit policy in the platform, in one table.
 *
 * No single global limit: each operation is limited on the dimensions that
 * matter for it, so a scraper hammering search does not lock a shopper out of
 * login, and a login flood does not slow the Business Portal.
 *
 * These are starting values, sized for Surat launch traffic. Tune them with
 * RATE_LIMIT_OVERRIDES (JSON) rather than editing code under pressure —
 * see SECURITY.md §10.
 */

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const rule = (limit: number, windowMs: number): LimitRule => ({ limit, windowMs });

const policy = (p: RatePolicy): RatePolicy => p;

export const RATE_POLICIES = {
  /* ---------------- authentication ---------------- */

  // Brute force is caught per identifier (one account, many passwords);
  // credential stuffing and spraying per IP (many accounts, one source).
  'auth.login': policy({
    name: 'auth.login',
    rules: { ip: rule(30, 15 * MIN), identifier: rule(10, 15 * MIN) },
    block: { afterViolations: 3, baseMs: 15 * MIN, maxMs: DAY },
    failMode: 'closed',
  }),
  'auth.login.admin': policy({
    name: 'auth.login.admin',
    rules: { ip: rule(10, 15 * MIN), identifier: rule(5, 15 * MIN) },
    block: { afterViolations: 1, baseMs: 30 * MIN, maxMs: DAY },
    failMode: 'closed',
  }),
  'auth.register': policy({
    name: 'auth.register',
    rules: { ip: rule(5, HOUR) },
    block: { afterViolations: 3, baseMs: HOUR, maxMs: DAY },
    failMode: 'closed',
  }),
  'auth.passwordReset': policy({
    name: 'auth.passwordReset',
    rules: { ip: rule(5, HOUR), identifier: rule(3, HOUR) },
    block: { afterViolations: 3, baseMs: HOUR, maxMs: DAY },
    failMode: 'closed',
  }),
  // One tab refreshes every ~5 minutes. 30 in 5 minutes is a loop or an attack.
  'auth.refresh': policy({
    name: 'auth.refresh',
    rules: { session: rule(30, 5 * MIN), ip: rule(300, 5 * MIN) },
    failMode: 'open',
  }),

  /* ---------------- GraphQL ---------------- */

  'graphql.request': policy({
    name: 'graphql.request',
    rules: { anonymousIp: rule(300, MIN), user: rule(600, MIN), ip: rule(1_200, MIN) },
    block: { afterViolations: 5, baseMs: 5 * MIN, maxMs: HOUR },
    failMode: 'open',
  }),
  'graphql.mutation': policy({
    name: 'graphql.mutation',
    rules: { anonymousIp: rule(20, MIN), user: rule(60, MIN) },
    failMode: 'open',
  }),
  /** Operations whose cost was near the complexity ceiling. */
  'graphql.expensive': policy({
    name: 'graphql.expensive',
    rules: { anonymousIp: rule(20, MIN), user: rule(60, MIN) },
    failMode: 'open',
  }),

  /* ---------------- product surfaces ---------------- */

  search: policy({
    name: 'search',
    rules: { anonymousIp: rule(60, MIN), user: rule(120, MIN) },
    block: { afterViolations: 5, baseMs: 10 * MIN, maxMs: 6 * HOUR },
    failMode: 'open',
  }),
  nearby: policy({
    name: 'nearby',
    rules: { anonymousIp: rule(60, MIN), user: rule(120, MIN) },
    block: { afterViolations: 5, baseMs: 10 * MIN, maxMs: 6 * HOUR },
    failMode: 'open',
  }),
  comparison: policy({
    name: 'comparison',
    rules: { anonymousIp: rule(60, MIN), user: rule(120, MIN) },
    block: { afterViolations: 5, baseMs: 10 * MIN, maxMs: 6 * HOUR },
    failMode: 'open',
  }),
  'review.write': policy({
    name: 'review.write',
    rules: { user: rule(10, HOUR), ip: rule(30, HOUR) },
    failMode: 'closed',
  }),
  upload: policy({
    name: 'upload',
    rules: { user: rule(60, HOUR), resource: rule(200, DAY) },
    failMode: 'closed',
  }),
  // Menu scans cost real money per call to the vision provider.
  'menu.scan': policy({
    name: 'menu.scan',
    rules: { user: rule(10, DAY), resource: rule(10, DAY) },
    failMode: 'closed',
  }),

  // Registering businesses and requesting categories: a handful a day is a
  // busy owner; hundreds is spam.
  'business.register': policy({
    name: 'business.register',
    rules: { user: rule(10, DAY), ip: rule(30, DAY) },
    failMode: 'closed',
  }),

  // Call / Directions taps feed owners' funnels: bounded per IP and per business
  // so nobody can inflate a competitor's (or their own) numbers.
  engagement: policy({
    name: 'engagement',
    rules: { ip: rule(120, HOUR), resource: rule(2_000, HOUR) },
    failMode: 'open',
  }),
  'offer.claim': policy({
    name: 'offer.claim',
    rules: { user: rule(30, HOUR) },
    failMode: 'open',
  }),
  // Redeeming is how a code is guessed; cap it per owner session and IP.
  'offer.redeem': policy({
    name: 'offer.redeem',
    rules: { user: rule(120, HOUR), ip: rule(300, HOUR) },
    block: { afterViolations: 3, baseMs: HOUR, maxMs: DAY },
    failMode: 'closed',
  }),

  /* ---------------- privileged ---------------- */

  'admin.mutation': policy({
    name: 'admin.mutation',
    rules: { session: rule(60, MIN), user: rule(300, HOUR) },
    failMode: 'closed',
  }),

  /* ---------------- webhooks ---------------- */

  // `resource` is the provider. Providers retry in bursts; this caps a flood
  // without dropping a legitimate retry storm.
  'webhook.ingest': policy({
    name: 'webhook.ingest',
    rules: { resource: rule(3_000, MIN), ip: rule(600, MIN) },
    failMode: 'open',
  }),
} as const satisfies Record<string, RatePolicy>;

export type RatePolicyName = keyof typeof RATE_POLICIES;

const overrideSchema = z.record(
  z.string(),
  // partialRecord: z.record with an enum key demands EVERY key in Zod 4.
  z.partialRecord(
    z.enum(['ip', 'anonymousIp', 'user', 'session', 'identifier', 'resource']),
    z.object({ limit: z.number().int().min(1), windowMs: z.number().int().min(1_000) }),
  ),
);

/**
 * Applies RATE_LIMIT_OVERRIDES. An unknown policy name is an error, not a
 * no-op: a typo in an emergency override must not silently do nothing.
 */
export function resolveRatePolicies(overridesJson: string | undefined): Record<RatePolicyName, RatePolicy> {
  const policies: Record<string, RatePolicy> = { ...RATE_POLICIES };
  if (!overridesJson) return policies as Record<RatePolicyName, RatePolicy>;

  const parsed = overrideSchema.parse(JSON.parse(overridesJson));
  for (const [name, rules] of Object.entries(parsed)) {
    const base = policies[name];
    if (!base) throw new Error(`RATE_LIMIT_OVERRIDES names unknown policy "${name}"`);
    policies[name] = { ...base, rules: { ...base.rules, ...(rules as Partial<Record<RateDimension, LimitRule>>) } };
  }
  return policies as Record<RatePolicyName, RatePolicy>;
}
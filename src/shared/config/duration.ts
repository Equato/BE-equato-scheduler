/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Human-readable durations for configuration: `500ms`, `30s`, `5m`, `8h`, `30d`.
 *
 * Security TTLs are read from the environment as durations rather than bare
 * numbers, because `ADMIN_SESSION_TTL=28800` invites the question "seconds or
 * milliseconds?" at exactly the moment nobody should be guessing.
 */

const UNIT_MS = {
  ms: 1,
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
} as const;

const DURATION = /^(\d+)(ms|s|m|h|d)$/;

/** Parses a duration to milliseconds. Returns null for anything malformed. */
export function parseDuration(value: string): number | null {
  const match = DURATION.exec(value.trim());
  if (!match?.[1] || !match[2]) return null;
  const amount = Number(match[1]);
  const ms = amount * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  return Number.isSafeInteger(ms) && ms > 0 ? ms : null;
}
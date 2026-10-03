/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Small, boring crypto helpers. Everything security-sensitive that compares or
 * derives bytes goes through here so the constant-time and encoding choices
 * are made once.
 */

/** 256 bits from the OS CSPRNG, base64url. Used for refresh tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

export function sha256Hex(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

export function hmacHex(secret: string, value: string | Buffer): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

/**
 * Constant-time string comparison. Length is compared first — that leaks only
 * the length, which for a fixed-format digest is public anyway.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

/**
 * Keyed, truncated digest for identifiers that end up in Redis keys or logs:
 * an email address, an IP. Stable (so counters work), not reversible, and
 * useless to anyone who dumps Redis without also holding the secret.
 */
export function createIdentifierHasher(secret: string): (value: string) => string {
  return (value) => hmacHex(secret, `id:${value.trim().toLowerCase()}`).slice(0, 32);
}
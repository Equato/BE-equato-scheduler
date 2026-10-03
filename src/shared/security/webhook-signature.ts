/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { constantTimeEqual, hmacHex } from './crypto.js';

/**
 * Webhook signature verification.
 *
 * Scheme (the default for providers without their own): the provider sends
 *
 *   x-equato-timestamp: <unix seconds>
 *   x-equato-signature: v1=<hex HMAC-SHA256(secret, `${timestamp}.${rawBody}`)>
 *
 * Signing the timestamp together with the body is what makes replay
 * protection possible: an attacker who captured a valid delivery cannot
 * re-send it after the tolerance window, and cannot change the timestamp
 * without invalidating the signature. Inside the window, the event id's
 * idempotency key (Redis) and UNIQUE (provider, event_id) (Postgres) reject
 * the duplicate.
 *
 * Verification runs over the RAW bytes, before JSON parsing: a parser that
 * normalises whitespace or key order would verify a different message from
 * the one that was signed — and parsing untrusted input before authenticating
 * it is itself attack surface.
 *
 * Multiple `v1=` entries are accepted so a provider can rotate secrets.
 */

export type SignatureFailure = 'missing' | 'malformed' | 'stale' | 'mismatch';

export interface VerifyOptions {
  secrets: readonly string[];
  rawBody: Buffer;
  timestampHeader: string | undefined;
  signatureHeader: string | undefined;
  toleranceMs: number;
  now?: number;
}

export function signWebhook(secret: string, timestamp: number, rawBody: Buffer): string {
  return `v1=${hmacHex(secret, Buffer.concat([Buffer.from(`${timestamp}.`), rawBody]))}`;
}

export function verifyWebhookSignature(opts: VerifyOptions): { ok: true } | { ok: false; reason: SignatureFailure } {
  const { timestampHeader, signatureHeader } = opts;
  if (!timestampHeader || !signatureHeader) return { ok: false, reason: 'missing' };
  if (!/^\d{1,12}$/.test(timestampHeader)) return { ok: false, reason: 'malformed' };

  const timestamp = Number(timestampHeader);
  const now = opts.now ?? Date.now();
  if (Math.abs(now - timestamp * 1000) > opts.toleranceMs) return { ok: false, reason: 'stale' };

  const provided = signatureHeader
    .split(',')
    .map((p) => p.trim())
    .filter((p) => p.startsWith('v1='));
  if (provided.length === 0) return { ok: false, reason: 'malformed' };

  for (const secret of opts.secrets) {
    const expected = signWebhook(secret, timestamp, opts.rawBody);
    // Every candidate is compared, in constant time, even after a match.
    if (provided.some((p) => constantTimeEqual(p, expected))) return { ok: true };
  }
  return { ok: false, reason: 'mismatch' };
}
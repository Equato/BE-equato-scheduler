/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * The Redis keyspace.
 *
 * Redis is shared by all three backends, so every key is built here and
 * nowhere else. Six namespaces, never mixed:
 *
 *   <prefix>:cache:        derived data, safe to lose, always has a TTL
 *   <prefix>:auth:         session revocation markers (never evicted)
 *   <prefix>:rate:         rate-limit counters, violation counts, blocks
 *   <prefix>:queue:        BullMQ — owned entirely by the queue library
 *   <prefix>:lock:         distributed locks, always with a TTL
 *   <prefix>:idempotency:  "seen this before" markers, always with a TTL
 *
 * Why it matters: a cache flush (`SCAN … MATCH equato:cache:*` + UNLINK) must
 * never be able to drop a queue or un-revoke a session, and a key that contains
 * an email address must never exist — identifiers are HMAC'd before they reach
 * a key (see shared/security/crypto.ts).
 */

export const RedisNamespace = {
  CACHE: 'cache',
  AUTH: 'auth',
  RATE: 'rate',
  QUEUE: 'queue',
  LOCK: 'lock',
  IDEMPOTENCY: 'idempotency',
} as const;
export type RedisNamespace = (typeof RedisNamespace)[keyof typeof RedisNamespace];

/** Key parts are restricted so a user-controlled value cannot forge a separator. */
const SAFE_PART = /^[A-Za-z0-9._\-{}]+$/;

export function assertSafeKeyPart(part: string): string {
  if (!SAFE_PART.test(part) || part.length > 200) {
    throw new Error(`unsafe redis key part: ${JSON.stringify(part.slice(0, 40))}`);
  }
  return part;
}

export interface Keyspace {
  readonly prefix: string;
  key(namespace: RedisNamespace, ...parts: string[]): string;
  /** The BullMQ `prefix` option — BullMQ appends `:<queue>:<suffix>` itself. */
  readonly queuePrefix: string;
}

export function createKeyspace(prefix: string): Keyspace {
  assertSafeKeyPart(prefix);
  return {
    prefix,
    key: (namespace, ...parts) => [prefix, namespace, ...parts.map(assertSafeKeyPart)].join(':'),
    queuePrefix: `${prefix}:${RedisNamespace.QUEUE}`,
  };
}
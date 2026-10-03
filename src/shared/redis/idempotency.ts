/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { Redis } from 'ioredis';
import { RedisNamespace, type Keyspace } from './keys.js';

/**
 * "Have we already seen this?" — the fast front door for duplicate requests,
 * webhook replays and double-submitted mutations.
 *
 * This is a first line only. Anything whose duplication would corrupt data is
 * ALSO protected by a database UNIQUE constraint (e.g. webhook_events
 * (provider, event_id)), because a Redis key can be lost and a constraint
 * cannot.
 */
export async function claimIdempotencyKey(
  redis: Redis,
  keys: Keyspace,
  scope: string,
  id: string,
  ttlMs: number,
): Promise<'first' | 'duplicate'> {
  const key = keys.key(RedisNamespace.IDEMPOTENCY, scope, id);
  const ok = await redis.set(key, '1', 'PX', ttlMs, 'NX');
  return ok === 'OK' ? 'first' : 'duplicate';
}
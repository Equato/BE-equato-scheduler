/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import { RedisNamespace, type Keyspace } from './keys.js';

/**
 * Distributed lock: `SET NX PX` to take it, compare-and-delete to release.
 *
 * The release is a script because a plain DEL would free a lock that expired
 * and was re-taken by another worker in the meantime. The TTL is mandatory —
 * a lock held by a crashed process must free itself.
 */

const RELEASE = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0`;

export interface Lock {
  readonly key: string;
  release(): Promise<boolean>;
}

export async function acquireLock(
  redis: Redis,
  keys: Keyspace,
  name: string,
  ttlMs: number,
): Promise<Lock | null> {
  const key = keys.key(RedisNamespace.LOCK, name);
  const token = randomBytes(16).toString('hex');
  const ok = await redis.set(key, token, 'PX', ttlMs, 'NX');
  if (ok !== 'OK') return null;
  return {
    key,
    release: async () => (await redis.eval(RELEASE, 1, key, token)) === 1,
  };
}
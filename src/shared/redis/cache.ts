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
 * Redis caches — every key under `<prefix>:cache:`, every key with a TTL.
 *
 * Two kinds:
 *
 *   1. The GraphQL RESPONSE cache (for anonymous public reads), implementing
 *      the envelop response-cache `Cache` interface. Each response is indexed
 *      by the entities it contains (`Business:<id>`, `Offering:<id>`) and by
 *      typename, so a write invalidates exactly the responses that showed the
 *      changed data.
 *   2. Small APPLICATION caches (`getOrSet`) for reference data that every
 *      request reads (the area/category lookup table, platform settings).
 *
 * Why not the stock @envelop/response-cache-redis store: it writes keys
 * outside any namespace, invalidates typenames with KEYS (which blocks Redis
 * for the whole keyspace), and never expires its index sets — under the
 * `noeviction` policy that BullMQ and the revocation markers require, those
 * sets would grow until Redis refused writes. Here index sets expire with the
 * entries they point to, and invalidation only reads the index.
 *
 * Every read and write fails SOFT: an unavailable cache is a slower API, not
 * a broken one.
 */

export interface CacheEntityRecord {
  typename: string;
  id?: string | number;
}

/** The envelop response-cache `Cache` contract, structurally. */
export interface ResponseCache {
  get(responseId: string): Promise<unknown>;
  set(responseId: string, result: unknown, entities: Iterable<CacheEntityRecord>, ttlMs: number): Promise<void>;
  invalidate(entities: Iterable<CacheEntityRecord>): Promise<void>;
}

/**
 * The public-data EPOCH is part of every response cache key. When LIST
 * MEMBERSHIP changes — a business or category becomes public or stops being —
 * the epoch is bumped, and every cached public response (including "not
 * found" and empty results, which contain no entity to invalidate) is retired
 * in O(1), with no key scan. Old keys simply expire by TTL.
 */
export interface EpochCache {
  epoch(): Promise<string>;
  bumpEpoch(): Promise<void>;
}

export function createResponseCache(redis: Redis, keys: Keyspace, opts: { maxTtlMs: number }): ResponseCache & EpochCache & { stats: { hits: number; misses: number } } {
  const k = (...parts: string[]) => keys.key(RedisNamespace.CACHE, 'gql', ...parts);
  // Response ids and ids are hashes/uuids; typenames are GraphQL names — all key-safe.
  const respKey = (id: string) => k('resp', id.replace(/[^A-Za-z0-9_-]/g, '_'));
  const typeKey = (typename: string) => k('type', typename);
  const entityKey = (typename: string, id: string | number) => k('ent', typename, String(id).replace(/[^A-Za-z0-9_-]/g, '_'));
  const stats = { hits: 0, misses: 0 };
  const epochKey = k('epoch');
  // Far longer than any entry can live, refreshed on every bump. If it ever
  // expires, every entry written under the old epoch is long gone.
  const EPOCH_TTL = 7 * 24 * 3_600_000;

  return {
    stats,
    async epoch() {
      try {
        return (await redis.get(epochKey)) ?? '0';
      } catch {
        // Redis down: the cache itself is unreachable too, so any value is safe.
        return 'unavailable';
      }
    },
    async bumpEpoch() {
      try {
        await redis.multi().incr(epochKey).pexpire(epochKey, EPOCH_TTL).exec();
      } catch {
        // entries expire by TTL
      }
    },
    async get(responseId) {
      try {
        const raw = await redis.get(respKey(responseId));
        if (raw) stats.hits++;
        else stats.misses++;
        return raw ? JSON.parse(raw) : undefined;
      } catch {
        stats.misses++;
        return undefined;
      }
    },

    async set(responseId, result, entities, ttlMs) {
      const ttl = Math.max(1_000, Math.min(Number.isFinite(ttlMs) ? ttlMs : opts.maxTtlMs, opts.maxTtlMs));
      const rk = respKey(responseId);
      try {
        const p = redis.multi().set(rk, JSON.stringify(result), 'PX', ttl);
        for (const { typename, id } of entities) {
          const tk = typeKey(typename);
          // Index sets live as long as the longest entry they can point to.
          p.sadd(tk, rk).pexpire(tk, opts.maxTtlMs);
          if (id !== undefined && id !== null) {
            const ek = entityKey(typename, id);
            p.sadd(ek, rk).pexpire(ek, opts.maxTtlMs);
          }
        }
        await p.exec();
      } catch {
        // Not cached this time; nothing else to do.
      }
    },

    async invalidate(entities) {
      try {
        const indexKeys = [...entities].map((e) => (e.id === undefined || e.id === null ? typeKey(e.typename) : entityKey(e.typename, e.id)));
        if (!indexKeys.length) return;
        const members = await Promise.all(indexKeys.map((ik) => redis.smembers(ik)));
        const toDelete = [...new Set([...indexKeys, ...members.flat()])];
        // UNLINK: freeing large values happens off the main thread.
        for (let i = 0; i < toDelete.length; i += 500) await redis.unlink(...toDelete.slice(i, i + 500));
      } catch {
        // A failed invalidation leaves entries to expire by TTL — the backstop,
        // never the plan.
      }
    },
  };
}

/** Small typed application cache: read-through, JSON, TTL, explicit invalidation. */
export function createAppCache(redis: Redis, keys: Keyspace) {
  const k = (name: string, key: string) => keys.key(RedisNamespace.CACHE, 'app', name, key);
  return {
    async getOrSet<T>(name: string, key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      try {
        const raw = await redis.get(k(name, key));
        if (raw !== null) return JSON.parse(raw) as T;
      } catch {
        return load();
      }
      const value = await load();
      try {
        await redis.set(k(name, key), JSON.stringify(value), 'PX', ttlMs);
      } catch {
        // served uncached
      }
      return value;
    },
    async del(name: string, key: string) {
      try {
        await redis.unlink(k(name, key));
      } catch {
        // expires by TTL
      }
    },
  };
}

export type AppCache = ReturnType<typeof createAppCache>;
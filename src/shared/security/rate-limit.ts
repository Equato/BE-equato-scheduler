/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { Redis } from 'ioredis';
import { RedisNamespace, type Keyspace } from '../redis/keys.js';

/**
 * Distributed rate limiting, backed by Redis.
 *
 * Never in-memory: with N API replicas an in-memory limit is N times the
 * intended one, and resets on every deploy.
 *
 * Algorithm: sliding-window counter (current fixed window plus the previous
 * window weighted by how much of it still overlaps). Accurate to a few percent,
 * two small keys per subject, no per-request sorted-set growth.
 *
 * Every policy limits several DIMENSIONS independently — IP, user, session,
 * the targeted identifier (e.g. the email being logged into), a resource —
 * because each attack defeats a different one: credential stuffing rotates
 * IPs, so it is caught per identifier; password spraying rotates identifiers,
 * so it is caught per IP. A request must pass every dimension that applies.
 *
 * Progressive throttling: repeated violations on one dimension escalate into a
 * temporary block, doubling each time, capped. All checks for one request run
 * in ONE Lua script, so concurrent requests cannot slip between the check and
 * the increment.
 */

export type RateDimension = 'ip' | 'anonymousIp' | 'user' | 'session' | 'identifier' | 'resource';

export interface LimitRule {
  limit: number;
  windowMs: number;
}

export interface BlockRule {
  /** Violations inside the violation window before a block starts. */
  afterViolations: number;
  baseMs: number;
  maxMs: number;
}

export interface RatePolicy {
  readonly name: string;
  readonly rules: Partial<Record<RateDimension, LimitRule>>;
  readonly block?: BlockRule;
  /**
   * What to do when Redis is unreachable. `closed` for endpoints where an
   * unlimited attacker is worse than an outage (login, admin mutations);
   * `open` where refusing every shopper is worse than a few minutes unlimited.
   */
  readonly failMode: 'open' | 'closed';
}

export interface RateSubject {
  ip?: string | null;
  userId?: string | null;
  sessionId?: string | null;
  identifier?: string | null;
  resource?: string | null;
}

export type RateDecision =
  | { allowed: true }
  | {
      allowed: false;
      dimension: RateDimension | 'unavailable';
      retryAfterMs: number;
      /** True when this request STARTED a temporary block. */
      newlyBlocked: boolean;
      /** True when an existing block rejected it. */
      blocked: boolean;
    };

const SCRIPT = `
local now = tonumber(ARGV[1])
local cost = tonumber(ARGV[2])
local n = #KEYS / 4
for i = 0, n - 1 do
  local ttl = redis.call('PTTL', KEYS[i * 4 + 4])
  if ttl > 0 then return {0, i + 1, ttl, 1} end
end
for i = 0, n - 1 do
  local b = 3 + i * 5
  local limit = tonumber(ARGV[b])
  local window = tonumber(ARGV[b + 1])
  local curr = tonumber(redis.call('GET', KEYS[i * 4 + 1]) or '0')
  local prev = tonumber(redis.call('GET', KEYS[i * 4 + 2]) or '0')
  local elapsed = now % window
  local estimate = prev * ((window - elapsed) / window) + curr
  if estimate + cost > limit then
    local after = tonumber(ARGV[b + 2])
    if after > 0 then
      local base = tonumber(ARGV[b + 3])
      local max = tonumber(ARGV[b + 4])
      local v = redis.call('INCR', KEYS[i * 4 + 3])
      redis.call('PEXPIRE', KEYS[i * 4 + 3], math.max(window * 4, max))
      if v >= after then
        local dur = math.floor(math.min(max, base * (2 ^ (v - after))))
        redis.call('SET', KEYS[i * 4 + 4], '1', 'PX', dur)
        return {0, i + 1, dur, 2}
      end
    end
    return {0, i + 1, math.floor(window - elapsed), 0}
  end
end
for i = 0, n - 1 do
  local window = tonumber(ARGV[3 + i * 5 + 1])
  local c = redis.call('INCRBY', KEYS[i * 4 + 1], cost)
  if c == cost then redis.call('PEXPIRE', KEYS[i * 4 + 1], window * 2) end
end
return {1, 0, 0, 0}
`;

export interface RateLimiterDeps {
  redis: Redis;
  keys: Keyspace;
  /** Keyed hash, so no raw IP or email ever becomes part of a Redis key. */
  hash: (value: string) => string;
  now?: () => number;
}

export interface RateLimiter {
  consume(policy: RatePolicy, subject: RateSubject, cost?: number): Promise<RateDecision>;
  /** Clears one dimension, e.g. an identifier's failure count after a good login. */
  reset(policy: RatePolicy, dimension: RateDimension, value: string): Promise<void>;
}

function subjectValue(dimension: RateDimension, s: RateSubject): string | null {
  switch (dimension) {
    case 'ip':
      return s.ip ?? null;
    case 'anonymousIp':
      return s.userId ? null : (s.ip ?? null);
    case 'user':
      return s.userId ?? null;
    case 'session':
      return s.sessionId ?? null;
    case 'identifier':
      return s.identifier ?? null;
    case 'resource':
      return s.resource ?? null;
  }
}

export function createRateLimiter({ redis, keys, hash, now = Date.now }: RateLimiterDeps): RateLimiter {
  const k = (...parts: string[]) => keys.key(RedisNamespace.RATE, ...parts);

  return {
    async consume(policy, subject, cost = 1) {
      const t = now();
      const redisKeys: string[] = [];
      const args: (string | number)[] = [t, cost];
      const dims: RateDimension[] = [];

      for (const [dimension, rule] of Object.entries(policy.rules) as [RateDimension, LimitRule][]) {
        const raw = subjectValue(dimension, subject);
        if (raw === null) continue;
        const id = hash(raw);
        const w = Math.floor(t / rule.windowMs);
        redisKeys.push(
          k(policy.name, dimension, id, String(w)),
          k(policy.name, dimension, id, String(w - 1)),
          k('viol', policy.name, dimension, id),
          k('block', policy.name, dimension, id),
        );
        const b = policy.block;
        args.push(rule.limit, rule.windowMs, b?.afterViolations ?? 0, b?.baseMs ?? 0, b?.maxMs ?? 0);
        dims.push(dimension);
      }
      if (dims.length === 0) return { allowed: true };

      let result: [number, number, number, number];
      try {
        result = (await redis.eval(SCRIPT, redisKeys.length, ...redisKeys, ...args)) as typeof result;
      } catch {
        return policy.failMode === 'open'
          ? { allowed: true }
          : { allowed: false, dimension: 'unavailable', retryAfterMs: 5_000, newlyBlocked: false, blocked: false };
      }

      const [ok, index, retryAfterMs, flag] = result;
      if (ok === 1) return { allowed: true };
      return {
        allowed: false,
        dimension: dims[index - 1] ?? 'ip',
        retryAfterMs: Math.max(1, retryAfterMs),
        newlyBlocked: flag === 2,
        blocked: flag === 1,
      };
    },

    async reset(policy, dimension, value) {
      const rule = policy.rules[dimension];
      if (!rule) return;
      const id = hash(value);
      const w = Math.floor(now() / rule.windowMs);
      await redis.del(
        k(policy.name, dimension, id, String(w)),
        k(policy.name, dimension, id, String(w - 1)),
        k('viol', policy.name, dimension, id),
        k('block', policy.name, dimension, id),
      );
    },
  };
}
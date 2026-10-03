/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { Redis, type RedisOptions } from 'ioredis';

export type { Redis };

export interface RedisClientOptions {
  url: string;
  /** Shown in `CLIENT LIST`, so an operator can tell which service holds a connection. */
  name: string;
  /** BullMQ requires null (block forever); request paths want a bounded retry. */
  maxRetriesPerRequest?: number | null;
}

/**
 * Request-path Redis client.
 *
 * Fails fast rather than queueing commands while disconnected: a rate-limit or
 * revocation check that hangs for 20 s is worse than one that errors, because
 * each caller already has an explicit fail-open/fail-closed decision to make.
 */
export function createRedis({ url, name, maxRetriesPerRequest = 1 }: RedisClientOptions): Redis {
  const options: RedisOptions = {
    connectionName: name,
    maxRetriesPerRequest,
    enableOfflineQueue: maxRetriesPerRequest === null,
    connectTimeout: 5_000,
    commandTimeout: maxRetriesPerRequest === null ? undefined : 1_000,
    lazyConnect: false,
  };
  return new Redis(url, options);
}

/** Readiness probe. */
/** Bounded even on a connection that queues commands while offline (BullMQ's), which would otherwise wait for Redis to return. */
export async function pingRedis(redis: Redis, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      redis.ping().then((r) => r === 'PONG'),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
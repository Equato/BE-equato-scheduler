import type { Logger } from '../shared/config/index.js';
import type { Database } from '../db/index.js';
import type { Keyspace, Redis, ResponseCache } from '../shared/redis/index.js';
import type { StorageProvider } from '../shared/storage/index.js';
import type { QueueProducer } from '../shared/queue/index.js';
import type { MenuScanProvider } from '../scan/providers.js';
import type { PaymentProvider } from '../shared/billing/provider.js';

/**
 * What every job handler gets. Nothing here is per-process state that matters:
 * the source of truth is Postgres (and Redis for locks/dedupe), so any number
 * of scheduler replicas can run the same handlers concurrently.
 */
export interface JobContext {
  readonly db: Database;
  readonly redis: Redis;
  readonly keys: Keyspace;
  readonly log: Logger;
  readonly storage: StorageProvider;
  readonly mediaBucket: string;
  readonly scansBucket: string;
  /** The API's public response cache — jobs retire what they change. */
  readonly responseCache: Pick<ResponseCache, 'invalidate'>;
  readonly queue: QueueProducer;
  /** Menu-scan AI provider. Its API key exists only in the scheduler's env. */
  readonly scanProvider: MenuScanProvider;
  /** Billing payment provider (null = billing jobs are skipped). */
  readonly payments: PaymentProvider | null;
}

/** Which delivery this is, so a handler can give up cleanly on the last one. */
export interface JobMeta {
  attempt: number;
  maxAttempts: number;
}

/** A handler's outcome, logged with the job: `done`, or why nothing happened. */
export type JobOutcome = { status: 'done' | 'skipped'; detail?: string; [k: string]: unknown };

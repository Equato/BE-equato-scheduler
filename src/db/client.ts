/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';
import * as schema from './schema/index.js';

export type Database = PostgresJsDatabase<typeof schema>;

export interface DatabaseOptions {
  url: string;
  poolMax: number;
  statementTimeoutMs: number;
  /** Logs every statement. Development only — it is far too noisy otherwise. */
  debug?: boolean;
  /** Called once per statement. Tests use it to prove batching (no N+1). */
  onQuery?: (sql: string) => void;
  /**
   * Parallel workers per query (`max_parallel_workers_per_gather`); omit for the
   * server default. The API sets 0: its queries are small and many run at once,
   * and with parallelism the planner picked a parallel full scan for a
   * comparison page — 34 ms instead of 2 ms (measured, Phase 19).
   */
  parallelWorkersPerQuery?: number;
}

/**
 * One pool per process. PgBouncer sits in front in production, so `poolMax`
 * here is the per-replica share, not the database's total.
 */
export function createDatabase(opts: DatabaseOptions): { db: Database; close: () => Promise<void> } {
  const sql = postgres(opts.url, {
    max: opts.poolMax,
    // A query that has run this long is not going to help anyone; failing it
    // frees the connection rather than letting it pin the pool.
    connect_timeout: 10,
    idle_timeout: 30,
    max_lifetime: 60 * 30,
    prepare: true,
    connection: {
      statement_timeout: opts.statementTimeoutMs,
      // As a string: postgres.js drops a numeric 0 from the startup parameters (measured).
      ...(opts.parallelWorkersPerQuery !== undefined ? { max_parallel_workers_per_gather: String(opts.parallelWorkersPerQuery) } : {}),
    },
    onnotice: () => {},
  });

  return {
    db: drizzle(sql, {
      schema,
      logger: opts.onQuery ? { logQuery: (q: string) => opts.onQuery!(q) } : (opts.debug ?? false),
    }),
    close: () => sql.end({ timeout: 5 }),
  };
}

/** Cheap liveness probe for the /ready endpoint. */
/**
 * Bounded: a hung database (connections open, nothing answering) must turn
 * readiness red, not hang the probe — measured, Phase 20 (`docker pause`).
 */
export async function pingDatabase(db: Database, timeoutMs = 2_000): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      db.execute('select 1').then(() => true),
      new Promise<boolean>((resolve) => (timer = setTimeout(() => resolve(false), timeoutMs))),
    ]);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
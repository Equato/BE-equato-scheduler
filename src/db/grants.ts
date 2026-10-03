/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { Sql } from 'postgres';

/**
 * Least-privilege grants for the application role.
 *
 * All three backends connect as this ONE role to the ONE shared database. It
 * can read and write rows; it cannot change the schema, truncate, or rewrite
 * history:
 *
 *   - SELECT/INSERT/UPDATE/DELETE on application tables
 *   - SELECT/INSERT only on audit_logs and security_events (append-only)
 *   - nothing on the `drizzle` schema (migration bookkeeping)
 *   - no CREATE on any schema, no TRUNCATE, no ownership of anything
 *
 * Re-applied after every migration run, so a table added by a migration is
 * never left either inaccessible or over-granted. Idempotent.
 */

const APPEND_ONLY_TABLES = ['audit_logs', 'security_events'] as const;

const IDENTIFIER = /^[a-z_][a-z0-9_]{0,62}$/;

export async function applyApplicationGrants(sql: Sql, role: string): Promise<'applied' | 'role-missing'> {
  // The role name is interpolated as an identifier, so it is validated rather
  // than trusted — this is the one place in the codebase that builds SQL from
  // a string, and the string comes from deploy config, never from a request.
  if (!IDENTIFIER.test(role)) throw new Error(`invalid application role name: ${role}`);

  const [exists] = await sql`select 1 from pg_roles where rolname = ${role}`;
  if (!exists) return 'role-missing';

  const r = sql(role);

  await sql.begin(async (tx) => {
    await tx`revoke create on schema public from public`;
    await tx`grant usage on schema public to ${r}`;
    await tx`revoke all on schema drizzle from ${r}`;

    await tx`grant select, insert, update, delete on all tables in schema public to ${r}`;
    await tx`revoke truncate, references, trigger on all tables in schema public from ${r}`;
    await tx`grant usage, select on all sequences in schema public to ${r}`;

    // Partition maintenance is the one DDL-shaped thing the scheduler does,
    // through a whitelisted SECURITY DEFINER function (migration 0002).
    const [fn] = await tx`select to_regprocedure('ensure_monthly_partitions(text, date, date)') as oid`;
    if (fn?.oid) await tx`grant execute on function ensure_monthly_partitions(text, date, date) to ${r}`;
    const [drop] = await tx`select to_regprocedure('drop_expired_analytics_partitions(integer)') as oid`;
    if (drop?.oid) await tx`grant execute on function drop_expired_analytics_partitions(integer) to ${r}`;

    for (const table of APPEND_ONLY_TABLES) {
      await tx`revoke update, delete on ${tx(table)} from ${r}`;
      // Partitions are reached through the parent. Direct access to a
      // partition would let a query skip the parent's privilege check.
      const partitions = await tx<{ name: string }[]>`
        select c.relname as name
        from pg_inherits i
        join pg_class c on c.oid = i.inhrelid
        join pg_class p on p.oid = i.inhparent
        where p.relname = ${table}`;
      for (const { name } of partitions) {
        await tx`revoke all on ${tx(name)} from ${r}`;
      }
    }
  });

  return 'applied';
}
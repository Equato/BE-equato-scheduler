/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { sql } from 'drizzle-orm';
import { bigint, customType, text, timestamp, uuid } from 'drizzle-orm/pg-core';

/* ---------------------------------------------------------------------------
 * Column primitives used across every table.
 *
 * Defined once so that "how we store money" and "how we store a point" are
 * single decisions rather than thirty-five independent ones.
 * ------------------------------------------------------------------------- */

/**
 * Primary key: UUIDv7.
 *
 * Time-sortable, so B-tree inserts stay at the right edge of the index instead
 * of scattering writes across it the way UUIDv4 does. Also means a row's id
 * carries its creation order, which is what lets cursor pagination be stable.
 *
 * `uuid_generate_v7()` is created by the first migration — Postgres 17 has no
 * native uuidv7(), and having the database generate it keeps raw SQL inserts
 * and seed scripts consistent with the application.
 */
export const primaryId = () =>
  uuid('id').primaryKey().default(sql`uuid_generate_v7()`);

/** Foreign-key column with no default; nullability is decided per use. */
export const fk = (name: string) => uuid(name);

/**
 * Timestamps are always `timestamptz`. A local timestamp is a bug waiting for
 * the first customer outside one timezone, and this platform is built to
 * expand beyond Surat.
 */
export const createdAt = () =>
  timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

export const updatedAt = () =>
  timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow();

/** Soft delete. Null means live; every public query filters on it. */
export const deletedAt = () => timestamp('deleted_at', { withTimezone: true, mode: 'date' });

export const timestamps = () => ({ createdAt: createdAt(), updatedAt: updatedAt() });

/**
 * A readable reference for support and admin — `USR-2026-00000123` — beside
 * the UUID, never instead of it (links and foreign keys keep using the id).
 *
 * The number comes from a per-type sequence that never resets, so a code is
 * never issued twice, not even across years (the year is just when the row
 * was created); a UNIQUE index on the column backs that up. Padded to at
 * least 8 digits, growing past that rather than truncating.
 * Existing rows got theirs in creation order, with their creation year.
 */
export const readableCode = (prefix: string, sequence: string) =>
  text('code')
    .notNull()
    .default(
      // readable_code() is created by migration 0023; one nextval per row.
      sql.raw(`readable_code('${prefix}', nextval('${sequence}'))`),
    );

/**
 * Money, in minor units (paise).
 *
 * `bigint` with `mode: 'number'` — JavaScript integers are exact to 2^53, which
 * is ₹90 trillion. Floating point would round, and a price comparison product
 * that rounds prices has no reason to exist.
 */
export const amountMinor = (name: string) => bigint(name, { mode: 'number' });

/**
 * PostGIS geography point, SRID 4326.
 *
 * `geography` rather than `geometry` so ST_Distance returns metres on the
 * spheroid without us picking a projection — correct for "businesses within
 * 5 km" anywhere on earth, which matters when this leaves Gujarat.
 */
export const geoPoint = customType<{
  data: { lat: number; lng: number };
  driverData: string;
  config: never;
}>({
  dataType: () => 'geography(Point,4326)',
  toDriver: (value) => `SRID=4326;POINT(${assertCoordinates(value).lng} ${value.lat})`,
  fromDriver: (value) => parsePoint(value),
});

/**
 * Decodes a geography point as Postgres returns it: hex-encoded EWKB
 * (`0101000020E6100000…`), or WKT if the query cast it with ST_AsText.
 *
 * Never invents a location. The previous decoder only understood WKT and fell
 * back to {0,0} for everything else — so every ORM read of a location came
 * back as the Gulf of Guinea. Anything unparseable now throws.
 */
export function parsePoint(value: string): { lat: number; lng: number } {
  const wkt = /^(?:SRID=\d+;)?POINT\(([-\d.eE]+) ([-\d.eE]+)\)$/.exec(value);
  if (wkt?.[1] && wkt[2]) return { lng: Number(wkt[1]), lat: Number(wkt[2]) };

  if (/^[0-9a-fA-F]+$/.test(value) && value.length >= 42) {
    const buf = Buffer.from(value, 'hex');
    const le = buf[0] === 1;
    const type = le ? buf.readUInt32LE(1) : buf.readUInt32BE(1);
    const hasSrid = (type & 0x20000000) !== 0;
    if ((type & 0xff) === 1 && !(type & 0x80000000) && !(type & 0x40000000)) {
      const at = hasSrid ? 9 : 5;
      if (buf.length >= at + 16) {
        const lng = le ? buf.readDoubleLE(at) : buf.readDoubleBE(at);
        const lat = le ? buf.readDoubleLE(at + 8) : buf.readDoubleBE(at + 8);
        return { lat, lng };
      }
    }
  }
  throw new Error('unparseable geography value');
}

/**
 * PostGIS geography does NOT reject out-of-range input — it silently coerces
 * it (latitude 95 is stored as 85, longitude 200 as -160) before any CHECK
 * constraint can see the value. So the range check has to happen here, on the
 * way in, as well as in the Zod input schemas. The CHECK constraints on the
 * geography columns then catch (0,0) and anything written by raw SQL.
 */
export function assertCoordinates(value: { lat: number; lng: number }): { lat: number; lng: number } {
  const { lat, lng } = value;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    throw new RangeError(`coordinates out of range: lat=${lat}, lng=${lng}`);
  }
  if (lat === 0 && lng === 0) throw new RangeError('coordinates (0,0) are almost certainly a missing value');
  return value;
}

/** Full-text search vector. Populated by trigger, never written by hand. */
export const tsvector = customType<{ data: string; driverData: string; config: never }>({
  dataType: () => 'tsvector',
});

/** Time of day with no date, e.g. an opening time. */
export const clockTime = customType<{ data: string; driverData: string; config: never }>({
  dataType: () => 'time',
});

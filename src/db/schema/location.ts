/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { sql } from 'drizzle-orm';
import { index, integer, pgTable, text, uniqueIndex, varchar, check } from 'drizzle-orm/pg-core';
import { cityStatusEnum } from './_enums.js';
import { fk, geoPoint, primaryId, timestamps } from './_shared.js';

/* ---------------------------------------------------------------------------
 * Location: Country → State → City → Area
 *
 * The prototype hardcodes India / Gujarat / Surat and eight areas. Modelling
 * the full hierarchy now costs four small tables and is what makes expansion a
 * data change rather than a rewrite — which the brief asks for explicitly.
 *
 * Coordinates are geography(Point,4326), never strings (brief §7).
 * ------------------------------------------------------------------------- */

export const countries = pgTable(
  'countries',
  {
    id: primaryId(),
    name: text('name').notNull(),
    iso2: varchar('iso2', { length: 2 }).notNull(),
    currencyCode: varchar('currency_code', { length: 3 }).notNull().default('INR'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('countries_iso2_uq').on(t.iso2)],
);

export const states = pgTable(
  'states',
  {
    id: primaryId(),
    countryId: fk('country_id')
      .notNull()
      .references(() => countries.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** LIVE / COMING_SOON / PLANNED — the admin location tree renders this. */
    status: cityStatusEnum('status').notNull().default('PLANNED'),
    ...timestamps(),
  },
  (t) => [uniqueIndex('states_country_name_uq').on(t.countryId, t.name)],
);

export const cities = pgTable(
  'cities',
  {
    id: primaryId(),
    stateId: fk('state_id')
      .notNull()
      .references(() => states.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    centroid: geoPoint('centroid'),
    /**
     * How far from the centroid still counts as "in our service area".
     * The prototype hardcodes 40 km around Surat; here it is per-city data, so
     * a live GPS fix outside it falls back to the chosen area for distances.
     */
    serviceRadiusKm: integer('service_radius_km').notNull().default(40),
    /**
     * IANA zone the city's businesses keep their hours in. "Open now" is
     * computed in this zone, never in the server's.
     */
    timezone: text('timezone').notNull().default('Asia/Kolkata'),
    status: cityStatusEnum('status').notNull().default('PLANNED'),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex('cities_state_name_uq').on(t.stateId, t.name),
    index('cities_status_idx').on(t.status),
  ],
);

export const areas = pgTable(
  'areas',
  {
    id: primaryId(),
    cityId: fk('city_id')
      .notNull()
      .references(() => cities.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    slug: text('slug').notNull(),
    pinCode: varchar('pin_code', { length: 12 }),
    centroid: geoPoint('centroid').notNull(),
    /**
     * Position on the illustrative SVG map of Surat. Carried over from the
     * prototype's `x`/`y` so that map view keeps working — it is a drawing,
     * not a projection, so these cannot be derived from lat/lng.
     */
    mapX: integer('map_x'),
    mapY: integer('map_y'),
    ...timestamps(),
  },
  (t) => [
    check('areas_centroid_ck', sql`ST_Y(centroid::geometry) BETWEEN -90 AND 90 AND ST_X(centroid::geometry) BETWEEN -180 AND 180 AND NOT (ST_X(centroid::geometry) = 0 AND ST_Y(centroid::geometry) = 0)`),
    uniqueIndex('areas_city_slug_uq').on(t.cityId, t.slug),
    index('areas_city_idx').on(t.cityId),
  ],
);
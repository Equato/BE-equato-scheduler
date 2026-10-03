/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Opening hours — the prototype's hours engine (store.js `slotsOn`,
 * `openState`, `itemAvailableNow`), ported as pure functions.
 *
 * Rules preserved exactly:
 *   - a weekday has a list of slots; an empty list means closed that day
 *   - two slots on one day are a split shift (lunch, then dinner)
 *   - a slot whose close is at or before its open runs past midnight, and
 *     still counts as open after midnight on the next day
 *   - a special date overrides the weekday entirely (closed, or one slot)
 *   - "opens next" looks up to 7 days ahead
 *
 * One deliberate change: the prototype used a fixed demo clock (6:30 pm).
 * Production uses the real clock in the city's time zone (`localNow`).
 * Operating status is DERIVED here, never stored (ARCHITECTURE.md §7).
 */

/** 0 = Monday … 6 = Sunday, matching business_hours.day_of_week and the prototype's DAYS. */
export type DayIndex = 0 | 1 | 2 | 3 | 4 | 5 | 6;
export const DAY_LABELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'] as const;

export interface Slot {
  /** 'HH:MM' or 'HH:MM:SS' (Postgres `time`). */
  opensAt: string;
  closesAt: string;
}

export interface SpecialDay {
  /** 'YYYY-MM-DD' in the business's local calendar. */
  date: string;
  isClosed: boolean;
  opensAt?: string | null;
  closesAt?: string | null;
  reason?: string | null;
}

/** Seven slot lists, index 0 = Monday. */
export type WeeklyHours = readonly (readonly Slot[])[];

export interface LocalNow {
  date: string;
  dayIdx: DayIndex;
  /** Minutes since local midnight. */
  mins: number;
}

export type OpenState =
  | { open: true; closesAt: string; closedToday: false; special: SpecialDay | null; slots: readonly Slot[] }
  | {
      open: false;
      opensAt: string | null;
      opensInDays: number | null;
      opensDay: string | null;
      closedToday: boolean;
      special: SpecialDay | null;
      slots: readonly Slot[];
    };

export const toMinutes = (t: string): number => {
  const [h, m] = t.split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
};

/** 'HH:MM:SS' → 'HH:MM', the shape the prototype and the UI use. */
export const hhmm = (t: string): string => t.slice(0, 5);

/**
 * Constructing an Intl.DateTimeFormat is expensive (measured: 12% of API CPU
 * under load when built per call — every business card asks "open now?").
 * One formatter per time zone is reused, and the answer is cached per zone per
 * minute: LocalNow has minute precision and every real UTC offset is a whole
 * number of minutes, so the value can only change on a UTC minute boundary.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();
const minuteCache = new Map<string, LocalNow>();
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-GB', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' });
    formatters.set(timeZone, f);
  }
  return f;
}

/** The wall clock in `timeZone` at instant `at`. */
export function localNow(timeZone: string, at: Date = new Date()): LocalNow {
  const key = `${timeZone}|${Math.floor(at.getTime() / 60_000)}`;
  const hit = minuteCache.get(key);
  if (hit) return hit;
  const parts = Object.fromEntries(
    formatterFor(timeZone)
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  const value: LocalNow = Object.freeze({
    date: `${parts.year}-${parts.month}-${parts.day}`,
    dayIdx: WEEKDAYS.indexOf(parts.weekday!) as DayIndex,
    mins: Number(parts.hour) * 60 + Number(parts.minute),
  });
  // Bounded: a few zones × the current minute in practice; tests may ask for many instants.
  if (minuteCache.size >= 512) minuteCache.clear();
  minuteCache.set(key, value);
  return value;
}

/** Calendar arithmetic on 'YYYY-MM-DD', independent of the host time zone. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

export function slotsOn(weekly: WeeklyHours, special: readonly SpecialDay[], dayIdx: number, date: string): { slots: readonly Slot[]; special: SpecialDay | null } {
  const sp = special.find((s) => s.date === date);
  if (sp) {
    return {
      slots: sp.isClosed || !sp.opensAt || !sp.closesAt ? [] : [{ opensAt: sp.opensAt, closesAt: sp.closesAt }],
      special: sp,
    };
  }
  return { slots: weekly[((dayIdx % 7) + 7) % 7] ?? [], special: null };
}

export function openState(weekly: WeeklyHours, special: readonly SpecialDay[], now: LocalNow): OpenState {
  const today = slotsOn(weekly, special, now.dayIdx, now.date);

  for (const s of today.slots) {
    const o = toMinutes(s.opensAt);
    let c = toMinutes(s.closesAt);
    if (c <= o) c += 1440;
    if (now.mins >= o && now.mins < c) {
      return { open: true, closesAt: hhmm(s.closesAt), closedToday: false, special: today.special, slots: today.slots };
    }
  }

  // A slot that began yesterday and runs past midnight still counts as open.
  const yesterday = slotsOn(weekly, special, (now.dayIdx + 6) % 7, addDays(now.date, -1));
  for (const s of yesterday.slots) {
    const o = toMinutes(s.opensAt);
    const c = toMinutes(s.closesAt);
    if (c <= o && now.mins < c) {
      return { open: true, closesAt: hhmm(s.closesAt), closedToday: false, special: today.special, slots: today.slots };
    }
  }

  for (let k = 0; k <= 7; k++) {
    const { slots } = slotsOn(weekly, special, (now.dayIdx + k) % 7, addDays(now.date, k));
    for (const s of slots) {
      if (k === 0 && toMinutes(s.opensAt) <= now.mins) continue;
      return {
        open: false,
        opensAt: hhmm(s.opensAt),
        opensInDays: k,
        opensDay: DAY_LABELS[(now.dayIdx + k) % 7]!,
        closedToday: today.slots.length === 0,
        special: today.special,
        slots: today.slots,
      };
    }
  }
  return { open: false, opensAt: null, opensInDays: null, opensDay: null, closedToday: true, special: today.special, slots: today.slots };
}

/**
 * Is an offering orderable right now? The prototype's itemAvailableNow():
 * switched off → no; no window → yes; otherwise inside [from, to).
 */
export function offeringAvailableNow(
  mode: 'ALWAYS' | 'WINDOW' | 'UNAVAILABLE',
  from: string | null,
  to: string | null,
  mins: number,
): boolean {
  if (mode === 'UNAVAILABLE') return false;
  if (mode === 'ALWAYS' || !from || !to) return true;
  return mins >= toMinutes(from) && mins < toMinutes(to);
}

/**
 * Validates a weekly schedule before it is stored: seven days, well-formed
 * times, at most four slots a day, and no overlapping slots within a day.
 * Returns a problem message or null.
 */
export function validateWeeklyHours(weekly: WeeklyHours): string | null {
  if (weekly.length !== 7) return 'hours must list all seven days';
  const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (let d = 0; d < 7; d++) {
    const slots = weekly[d]!;
    if (slots.length > 4) return `${DAY_LABELS[d]} has more than four slots`;
    for (const s of slots) {
      if (!TIME.test(s.opensAt) || !TIME.test(s.closesAt)) return `${DAY_LABELS[d]} has an invalid time`;
      if (s.opensAt === s.closesAt) return `${DAY_LABELS[d]} has a slot that opens and closes at the same time`;
    }
    const spans = slots
      .map((s) => {
        const o = toMinutes(s.opensAt);
        let c = toMinutes(s.closesAt);
        if (c <= o) c += 1440;
        return [o, c] as const;
      })
      .sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < spans.length; i++) if (spans[i]![0] < spans[i - 1]![1]) return `${DAY_LABELS[d]} has overlapping slots`;
  }
  return null;
}
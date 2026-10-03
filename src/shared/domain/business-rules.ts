/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * Business rules ported from the prototype's store.js, as pure functions so
 * they are testable without a database and identical in every service.
 */

/* ---------------- offers ---------------- */

/**
 * The prototype's offerExpired / offerScheduled / offerLive. Expired and
 * scheduled are DERIVED from the dates, never stored (a stored flag would need
 * a cron job and still be wrong between runs). Dates are local 'YYYY-MM-DD'.
 */
export type OfferState = 'LIVE' | 'PAUSED' | 'SCHEDULED' | 'EXPIRED';

export function offerState(status: 'ACTIVE' | 'PAUSED', validFrom: string | null, validTo: string | null, today: string): OfferState {
  if (validTo && validTo < today) return 'EXPIRED';
  if (status === 'PAUSED') return 'PAUSED';
  if (validFrom && validFrom > today) return 'SCHEDULED';
  return 'LIVE';
}

/**
 * Publicly visible offer: LIVE, and its business approved, and its category
 * active. Offers need no review — this gate is what keeps them honest.
 */
export const offerIsPublic = (state: OfferState, businessApproved: boolean, categoryActive: boolean): boolean =>
  state === 'LIVE' && businessApproved && categoryActive;

/* ---------------- features (owner-added amenities) ---------------- */

export const FEATURE_MAX = 40;

/** addFeature(): trim, collapse whitespace, 1–40 chars. Returns null when unusable. */
export function normalizeFeature(name: string): string | null {
  const n = name.trim().replace(/\s+/g, ' ');
  return n && n.length <= FEATURE_MAX ? n : null;
}

/* ---------------- duplicate detection ---------------- */

const STOP = new Set(['and', 'the', 'of', 'a', 'co', 'shop', 'store', 'surat']);
const norm = (t: string | null | undefined) =>
  String(t ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
const tokens = (t: string | null | undefined) => new Set(norm(t).split(' ').filter((w) => w && !STOP.has(w)));
const overlap = (a: Set<string>, b: Set<string>) => {
  if (!a.size || !b.size) return 0;
  let hit = 0;
  a.forEach((w) => {
    if (b.has(w)) hit++;
  });
  return hit / Math.min(a.size, b.size);
};
const phoneTail = (p: string | null | undefined) => String(p ?? '').replace(/\D/g, '').slice(-10);

export interface SimilarityCandidate {
  id: string;
  name: string;
  phone: string | null;
  address: string | null;
}

/**
 * findSimilar(): a new business must not look like one already listed. Same
 * name (or ≥ 65% token overlap, ignoring filler words), same phone (last 10
 * digits), or an address sharing its first 18 characters. At most three.
 */
export function findSimilar<C extends SimilarityCandidate>(
  input: { name: string; phone?: string | null; address?: string | null },
  candidates: readonly C[],
): C[] {
  const n = norm(input.name);
  if (!n) return [];
  const tn = tokens(input.name);
  const phone = phoneTail(input.phone);
  const addr = norm(input.address);
  return candidates
    .filter((b) => {
      const sameName = norm(b.name) === n || overlap(tn, tokens(b.name)) >= 0.65;
      const samePhone = phone.length >= 7 && phoneTail(b.phone) === phone;
      const sameAddr = addr.length > 12 && norm(b.address).includes(addr.slice(0, 18));
      return sameName || samePhone || sameAddr;
    })
    .slice(0, 3);
}

/* ---------------- profile completeness ---------------- */

export interface CompletenessInput {
  name: string;
  hasCategory: boolean;
  hasArea: boolean;
  addressLine: string;
  phone: string | null;
  email: string | null;
  description: string;
  hasHours: boolean;
  photoCount: number;
  amenityCount: number;
  liveOfferingCount: number;
}

/**
 * The prototype's COMPLETE checklist, minus the logo line: logos arrive with
 * media uploads (Phase 16) and are added back to this list then.
 */
const CHECKS: readonly [string, (b: CompletenessInput) => boolean][] = [
  ['Business name', (b) => !!b.name],
  ['Category', (b) => b.hasCategory],
  ['Location and address', (b) => b.hasArea && !!b.addressLine],
  ['Phone number', (b) => !!b.phone],
  ['Email address', (b) => !!b.email],
  ['Description', (b) => b.description.length > 40],
  ['Opening hours', (b) => b.hasHours],
  ['Cover photo', (b) => b.photoCount > 0],
  ['At least 4 gallery photos', (b) => b.photoCount >= 4],
  ['Amenities', (b) => b.amenityCount > 0],
  ['At least one live price', (b) => b.liveOfferingCount > 0],
];

export function completeness(b: CompletenessInput): { pct: number; done: string[]; missing: string[] } {
  const done = CHECKS.filter(([, fn]) => fn(b)).map(([label]) => label);
  const missing = CHECKS.filter(([, fn]) => !fn(b)).map(([label]) => label);
  return { pct: Math.round((done.length / CHECKS.length) * 100), done, missing };
}

/* ---------------- offer codes ---------------- */

/**
 * redeemClaim() accepts "EQ-4821", "eq4821", "4821". Normalise to the digits
 * the code is keyed on.
 */
export const normalizeClaimCode = (code: string): string =>
  String(code).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^EQ/, '');
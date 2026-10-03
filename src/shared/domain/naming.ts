/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/* ---------------------------------------------------------------------------
 * Comparison identity.
 *
 * The prototype compares two offerings when their trimmed, lowercased names
 * match inside one category. That is the behaviour being preserved — so with
 * no variant tokens present, this produces exactly the same groupings.
 *
 * What it adds is pulling size and quantity OUT of the name into structured
 * attributes, so "Cold Coffee" and "Cold Coffee 300ml" stop being the same
 * string by accident and become two deliberately different products.
 * ------------------------------------------------------------------------- */

/** Size, quantity and duration tokens worth extracting rather than matching on. */
const VARIANT_PATTERNS: { key: string; re: RegExp }[] = [
  { key: 'volume', re: /\b(\d+(?:\.\d+)?)\s?(ml|l|litre|liter|ltr)\b/i },
  { key: 'weight', re: /\b(\d+(?:\.\d+)?)\s?(g|gm|gms|kg|kgs)\b/i },
  { key: 'count', re: /\b(\d+)\s?(pc|pcs|piece|pieces|pack)\b/i },
  { key: 'duration', re: /\b(\d+)\s?(min|mins|minute|minutes|hr|hrs|hour|hours|month|months|year|years)\b/i },
  { key: 'size', re: /\b(small|medium|large|regular|xl|jumbo|mini|half|full)\b/i },
];

export interface ComparisonIdentity {
  /** What gets matched on, after tokens are removed. */
  normalizedName: string;
  /** The display name, cleaned of stray whitespace. */
  canonicalName: string;
  /** Extracted tokens. Two offerings compare only when these agree. */
  variantAttrs: Record<string, string>;
  slug: string;
}

/**
 * Lowercase, strip accents and punctuation, collapse whitespace.
 * Deliberately close to the prototype's `normName` so nothing regroups.
 */
export function normalizeName(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '') // fold accents: Café → Cafe
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ') // punctuation is never meaningful here
    .replace(/\s+/g, ' ')
    .trim();
}

export function slugify(raw: string): string {
  return normalizeName(raw).replace(/\s/g, '-').slice(0, 120) || 'item';
}

export function comparisonIdentity(rawName: string): ComparisonIdentity {
  const canonicalName = rawName.replace(/\s+/g, ' ').trim();
  let working = ` ${canonicalName} `;
  const variantAttrs: Record<string, string> = {};

  for (const { key, re } of VARIANT_PATTERNS) {
    const match = re.exec(working);
    if (!match) continue;
    // Normalise the token itself so "300 ml" and "300ml" agree.
    variantAttrs[key] = match.slice(1).filter(Boolean).join('').toLowerCase();
    working = working.replace(match[0], ' ');
  }

  const normalizedName = normalizeName(working);
  return {
    normalizedName,
    canonicalName,
    variantAttrs,
    slug: slugify(canonicalName),
  };
}

/**
 * Stable key for a comparison group. Offerings sharing this key compare.
 * Variant attributes are sorted so key order cannot change the identity.
 */
export function comparisonKey(
  categorySlug: string,
  identity: ComparisonIdentity,
  unit: string,
): string {
  const attrs = Object.keys(identity.variantAttrs)
    .sort()
    .map((k) => `${k}=${identity.variantAttrs[k]}`)
    .join('&');
  return `${categorySlug}|${identity.normalizedName}|${unit}|${attrs}`;
}
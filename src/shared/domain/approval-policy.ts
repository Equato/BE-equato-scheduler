/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
/**
 * What needs admin review, and what goes live immediately.
 *
 * This is the single most dangerous rule set to get wrong. Mark something
 * reviewable that is not, and owners are blocked on trivial edits; mark
 * something instant that is not, and unreviewed content reaches shoppers.
 *
 * Every row is taken from behaviour already implemented in the prototype's
 * `js/store.js` — not from assumption. The `evidence` field names the function
 * or UI copy it came from, so a future reader can check the claim.
 */

export const ChangeKind = {
  BUSINESS_CREATE: 'BUSINESS_CREATE',
  BUSINESS_IDENTITY_EDIT: 'BUSINESS_IDENTITY_EDIT',
  BUSINESS_CONTACT_EDIT: 'BUSINESS_CONTACT_EDIT',
  OFFERING_CREATE: 'OFFERING_CREATE',
  OFFERING_EDIT: 'OFFERING_EDIT',
  OFFERING_BULK_IMPORT: 'OFFERING_BULK_IMPORT',
  OFFERING_AVAILABILITY: 'OFFERING_AVAILABILITY',
  CATEGORY_REQUEST: 'CATEGORY_REQUEST',
  BUSINESS_FEATURE: 'BUSINESS_FEATURE',
  OFFER: 'OFFER',
  PHOTO: 'PHOTO',
  HOURS: 'HOURS',
  MENU_GROUP: 'MENU_GROUP',
} as const;
export type ChangeKind = (typeof ChangeKind)[keyof typeof ChangeKind];

export interface ApprovalRule {
  readonly kind: ChangeKind;
  /** True when an admin must approve before the change is publicly visible. */
  readonly requiresReview: boolean;
  /** Why, in the words the product itself uses. */
  readonly rationale: string;
  /** Where in the prototype this behaviour is implemented. */
  readonly evidence: string;
}

export const APPROVAL_POLICY: readonly ApprovalRule[] = [
  {
    kind: ChangeKind.BUSINESS_CREATE,
    requiresReview: true,
    rationale: 'A new listing must be checked before it appears in search or comparisons.',
    evidence: "registerBusiness() sets status 'pending'",
  },
  {
    kind: ChangeKind.BUSINESS_IDENTITY_EDIT,
    requiresReview: true,
    rationale: 'Name, category and description are what shoppers match against.',
    evidence: 'owner.js: "Name, category and description changes are reviewed before they appear publicly."',
  },
  {
    kind: ChangeKind.BUSINESS_CONTACT_EDIT,
    requiresReview: false,
    rationale: 'A corrected phone number should not wait a day to take effect.',
    evidence: 'owner.js: "Contact details and hours update immediately."',
  },
  {
    kind: ChangeKind.OFFERING_CREATE,
    requiresReview: true,
    rationale: 'Prices are the product. Nothing reaches a shopper unreviewed.',
    evidence: "saveItem(f, 'pending') — the form offers only Save as draft / Submit for approval",
  },
  {
    kind: ChangeKind.OFFERING_EDIT,
    requiresReview: true,
    rationale:
      'Editing a live price returns it to review; the previously approved version keeps showing until the new one is approved.',
    evidence: 'prototype core rule 3',
  },
  {
    kind: ChangeKind.OFFERING_BULK_IMPORT,
    requiresReview: true,
    rationale: 'AI-extracted rows are a proposal, never a publication.',
    evidence: "saveItems(rows, status) — only ever called with 'draft' or 'pending'",
  },
  {
    kind: ChangeKind.OFFERING_AVAILABILITY,
    requiresReview: false,
    rationale: 'Running out of something is not a content change.',
    evidence: 'toggleAvail() saves directly',
  },
  {
    kind: ChangeKind.CATEGORY_REQUEST,
    requiresReview: true,
    rationale: 'A category changes what every owner on the platform can list under.',
    evidence:
      'owner.js: "A whole new category is different: that changes what every owner can list under, so it needs our approval."',
  },
  {
    kind: ChangeKind.BUSINESS_FEATURE,
    requiresReview: false,
    rationale: 'A feature describes one business only, so there is nothing to review.',
    evidence:
      'addFeature() has no notify/approval path; owner.js: "Features appear straight away — they only describe this business."',
  },
  {
    kind: ChangeKind.OFFER,
    requiresReview: false,
    rationale:
      'Offers publish instantly, but are only visible while the business is approved and the category active.',
    evidence: 'owner.js: "No review needed."; visibility gated by offerLive()',
  },
  {
    kind: ChangeKind.PHOTO,
    requiresReview: false,
    rationale: 'Imagery is owner-controlled.',
    evidence: 'addPhoto / setCover / setLogo save directly',
  },
  {
    kind: ChangeKind.HOURS,
    requiresReview: false,
    rationale: 'Opening hours change constantly and are not a trust surface.',
    evidence: 'setHours / addSpecial save directly',
  },
  {
    kind: ChangeKind.MENU_GROUP,
    requiresReview: false,
    rationale: 'Grouping is presentation, scoped to one business.',
    evidence: 'addGroup / renameGroup / deleteGroup / moveGroup save directly',
  },
];

const BY_KIND = new Map<ChangeKind, ApprovalRule>(APPROVAL_POLICY.map((r) => [r.kind, r]));

export function approvalRuleFor(kind: ChangeKind): ApprovalRule {
  const rule = BY_KIND.get(kind);
  // A new ChangeKind added without a policy row must fail loudly rather than
  // silently defaulting to "no review needed".
  if (!rule) throw new Error(`No approval rule defined for change kind: ${kind}`);
  return rule;
}

export const requiresReview = (kind: ChangeKind): boolean => approvalRuleFor(kind).requiresReview;
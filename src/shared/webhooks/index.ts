/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { z } from 'zod';

/**
 * The webhook contract, shared by equato-webhooks (validates on receipt) and
 * equato-scheduler (validates again before acting). One envelope for every
 * provider:
 *
 *   { "id": "<provider event id>", "type": "<event type>", "data": { … } }
 *
 * signed with the Equato scheme (x-equato-timestamp + x-equato-signature =
 * HMAC-SHA256 over `${timestamp}.${rawBody}`), each provider with its own
 * secret. A third-party provider with its own format gets an adapter in
 * equato-webhooks that turns its delivery into this envelope after verifying
 * its native signature.
 *
 * Types not listed for a provider are stored as SKIPPED (providers send many
 * event kinds; we only act on these). Listed types whose `data` doesn't match
 * the schema are refused with 400 — the provider sees the failure.
 */

const email = () => z.string().trim().toLowerCase().email().max(254);
const uuid = () => z.uuid();
const providerRef = () => z.string().min(3).max(120).regex(/^[\w.:-]+$/);

/** One item extracted from a menu photo — becomes a DRAFT offering, never a live one. */
export const scannedItem = z.strictObject({
  name: z.string().trim().min(1).max(80),
  priceMinor: z.number().int().min(1).max(100_000_000).nullable(),
  group: z.string().trim().max(40).nullable().optional(),
  description: z.string().trim().max(300).nullable().optional(),
  isVegetarian: z.boolean().nullable().optional(),
  confidence: z.number().min(0).max(1).optional(),
});
export type ScannedItem = z.infer<typeof scannedItem>;

export const WEBHOOK_EVENTS = {
  /** Transactional email provider: delivery outcomes. */
  email: {
    'email.delivered': z.strictObject({ email: email(), messageId: z.string().max(200).optional() }),
    'email.bounced': z.strictObject({ email: email(), bounceType: z.enum(['hard', 'soft']), messageId: z.string().max(200).optional() }),
    'email.complained': z.strictObject({ email: email(), messageId: z.string().max(200).optional() }),
  },
  /** Asynchronous AI menu-scan provider: results for a scan job we submitted. */
  'scan-ai': {
    'scan.completed': z.strictObject({ scanJobId: uuid(), providerJobId: z.string().max(200).optional(), items: z.array(scannedItem).max(500) }),
    'scan.failed': z.strictObject({ scanJobId: uuid(), providerJobId: z.string().max(200).optional(), error: z.string().max(500) }),
  },
  /**
   * Payment provider (billing). Events carry REFERENCES only: the scheduler
   * reads the authoritative state back from the provider's API before acting,
   * so even a valid signature cannot make Equato believe a payment succeeded.
   * A real provider's adapter maps its native events onto these three.
   */
  payments: {
    'checkout.updated': z.strictObject({ checkoutRef: providerRef() }),
    'payment.updated': z.strictObject({ paymentRef: providerRef() }),
    'mandate.updated': z.strictObject({ mandateRef: providerRef() }),
  },
  /** Connectivity checks and tests. */
  default: {
    'test.ping': z.looseObject({}),
  },
} as const;

export type WebhookProvider = keyof typeof WEBHOOK_EVENTS;
export const WEBHOOK_PROVIDERS = Object.keys(WEBHOOK_EVENTS) as WebhookProvider[];

export const webhookEnvelope = z.strictObject({
  id: z.string().min(1).max(200).regex(/^[\w.:-]+$/, 'event ids are letters, digits and . _ : -'),
  type: z.string().min(1).max(100).regex(/^[a-z0-9_.-]+$/),
  data: z.record(z.string(), z.unknown()).default({}),
});
export type WebhookEnvelope = z.infer<typeof webhookEnvelope>;

export type ValidationOutcome =
  | { ok: true; known: true; data: Record<string, unknown> }
  | { ok: true; known: false }
  | { ok: false; issues: string[] };

/** Validates `data` for a (provider, type). Unknown types are acceptable but not acted on. */
export function validateEvent(provider: string, type: string, data: unknown): ValidationOutcome {
  const schemas = (WEBHOOK_EVENTS as Record<string, Record<string, z.ZodTypeAny>>)[provider];
  const schema = schemas?.[type];
  if (!schema) return { ok: true, known: false };
  const r = schema.safeParse(data);
  if (!r.success) return { ok: false, issues: r.error.issues.slice(0, 5).map((i) => `${i.path.join('.') || 'data'}: ${i.message}`) };
  return { ok: true, known: true, data: r.data as Record<string, unknown> };
}

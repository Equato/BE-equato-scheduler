/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { z } from 'zod';

/**
 * Shared input validation.
 *
 * Every mutation input is parsed through these schemas at the boundary. The
 * frontends use the same rules for instant feedback, but ONLY the server's
 * parse counts — frontend validation is a convenience for honest users, not a
 * control against dishonest ones.
 *
 * Objects are strict: an unexpected field is an error, not silently dropped.
 * A client sending `role` or `ownerId` in an input is either buggy or probing,
 * and either way it should hear "no".
 */

export class InputValidationError extends Error {
  constructor(readonly issues: readonly { path: string; message: string }[]) {
    super('Invalid input');
    this.name = 'InputValidationError';
  }
}

/**
 * Parse or throw. The error carries paths and messages only — never the
 * offending value, which may be a password someone typed into the wrong field.
 */
export function parseInput<T extends z.ZodTypeAny>(schema: T, value: unknown): z.infer<T> {
  const result = schema.safeParse(value);
  if (result.success) return result.data;
  throw new InputValidationError(
    result.error.issues.slice(0, 20).map((i) => ({ path: i.path.join('.'), message: i.message })),
  );
}

/** `z.strictObject` under a name that says why. */
export const strictInput = <S extends z.ZodRawShape>(shape: S) => z.strictObject(shape);

/* ---------------- primitives ---------------- */

export const id = () => z.uuid({ message: 'must be a valid id' });

// C0/C1 control characters and bidi overrides (the "Trojan Source" set) are
// never legitimate in a business name or a review. Newline and tab are
// allowed only where multiline text is expected.
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F‪-‮⁦-⁩]/;
const CONTROL_CHARS_SINGLE_LINE = /[\u0000-\u001F\u007F-\u009F‪-‮⁦-⁩]/;

export const boundedText = (opts: { max: number; min?: number; multiline?: boolean }) =>
  z
    .string()
    .transform((v) => v.normalize('NFC').trim())
    .pipe(
      z
        .string()
        .min(opts.min ?? 0, `must be at least ${opts.min ?? 0} characters`)
        .max(opts.max, `must be at most ${opts.max} characters`)
        .refine((v) => !(opts.multiline ? CONTROL_CHARS : CONTROL_CHARS_SINGLE_LINE).test(v), 'contains control characters'),
    );

export const email = () =>
  z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .pipe(z.email({ message: 'must be a valid email address' }));

export const latitude = () => z.number().finite().min(-90).max(90);
export const longitude = () => z.number().finite().min(-180).max(180);
export const coordinates = () => strictInput({ lat: latitude(), lng: longitude() });

/** Minor units (paise). Integers only — a float price is always a bug. ₹1 crore ceiling. */
export const MAX_PRICE_MINOR = 1_000_000_000;
export const priceMinor = () =>
  z.number().int('price must be whole paise').min(0, 'price cannot be negative').max(MAX_PRICE_MINOR, 'price is implausibly large');

/** Search radius, bounded so "nearby" cannot become "everything". */
export const radiusKm = (max: number) => z.number().finite().min(0.1).max(max);

/* ---------------- pagination ---------------- */

/** No list in the API is unbounded. Public lists cap lower than admin ones. */
export const PAGE_SIZE = { default: 20, publicMax: 50, adminMax: 100 } as const;

export const pagination = (max: number = PAGE_SIZE.publicMax) =>
  strictInput({
    first: z.number().int().min(1).max(max).default(PAGE_SIZE.default),
    after: z.string().max(200).regex(/^[A-Za-z0-9_-]+$/, 'invalid cursor').optional(),
  });

/* ---------------- URLs ---------------- */

/**
 * A URL a user may store (a business website). https only, no embedded
 * credentials, no IP-literal hosts, no internal-looking hostnames.
 * This validates the SHAPE. Before the server ever FETCHES a URL, it must also
 * pass `assertPublicDestination`, which checks where the name resolves.
 */
export const publicUrl = () =>
  z
    .string()
    .trim()
    .max(2048)
    .pipe(z.url({ message: 'must be a valid URL' }))
    .refine((v) => {
      // Zod still runs this refinement when the URL check above failed, so a
      // value like "example.com" must not reach `new URL` and throw.
      let u: URL;
      try {
        u = new URL(v);
      } catch {
        return false;
      }
      if (u.protocol !== 'https:') return false;
      if (u.username || u.password) return false;
      const host = u.hostname.replace(/^\[|\]$/g, '');
      if (isIP(host)) return false;
      if (host === 'localhost' || /\.(local|internal|localhost|lan|home|corp)$/i.test(host)) return false;
      return host.includes('.');
    }, 'must be a public https URL');

const PRIVATE_RANGES = new BlockList();
for (const [net, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) PRIVATE_RANGES.addSubnet(net, prefix, 'ipv4');
// Not ::ffff:0:0/96 — BlockList matches every IPv4 address against that
// range. IPv4-mapped IPv6 is unwrapped below and checked as IPv4 instead.
for (const [net, prefix] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8], ['64:ff9b::', 96]] as const)
  PRIVATE_RANGES.addSubnet(net, prefix, 'ipv6');

const IPV4_MAPPED = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i;

export function isPrivateAddress(address: string): boolean {
  const mapped = IPV4_MAPPED.exec(address);
  if (mapped?.[1]) return isPrivateAddress(mapped[1]);
  const family = isIP(address);
  if (family === 0) return true;
  return PRIVATE_RANGES.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/**
 * SSRF guard for any server-side fetch of a URL that came from outside.
 * Resolves the name and rejects it if ANY address is private, loopback,
 * link-local (169.254.169.254 is the cloud metadata service) or reserved.
 *
 * Callers must fetch the address this returns — not re-resolve the hostname —
 * or a DNS-rebinding attacker answers differently the second time.
 */
export async function assertPublicDestination(url: string): Promise<{ address: string; family: 4 | 6 }> {
  const u = new URL(url);
  if (u.protocol !== 'https:') throw new Error('only https destinations are allowed');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addresses = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true });
  if (addresses.length === 0) throw new Error('destination does not resolve');
  for (const a of addresses) {
    if (isPrivateAddress(a.address)) throw new Error('destination resolves to a non-public address');
  }
  const first = addresses[0]!;
  return { address: first.address, family: first.family === 6 ? 6 : 4 };
}

/* ---------------- files ---------------- */

export const IMAGE_MIME_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const;
const EXTENSION_FOR: Record<(typeof IMAGE_MIME_TYPES)[number], readonly string[]> = {
  'image/jpeg': ['jpg', 'jpeg'],
  'image/png': ['png'],
  'image/webp': ['webp'],
};

/**
 * A client-supplied filename is a label, never a path: it is shown back to
 * the owner and nothing else. Storage keys are generated server-side. Still,
 * reject anything that could be mistaken for a path or smuggle an extension.
 */
export const safeFilename = () =>
  z
    .string()
    .max(120)
    .regex(/^[A-Za-z0-9][A-Za-z0-9 ._()-]*$/, 'filename contains unsupported characters')
    .refine((v) => !v.includes('..'), 'filename cannot contain ".."')
    .refine((v) => (v.match(/\./g) ?? []).length === 1, 'filename must have exactly one extension');

/** An upload REQUEST — validated before a presigned URL is issued. */
export const uploadRequest = (maxBytes: number) =>
  strictInput({
    filename: safeFilename(),
    contentType: z.enum(IMAGE_MIME_TYPES),
    byteSize: z.number().int().min(1).max(maxBytes),
  }).refine((v) => {
    const ext = v.filename.split('.').pop()?.toLowerCase() ?? '';
    return EXTENSION_FOR[v.contentType].includes(ext);
  }, 'file extension does not match its content type');

/**
 * Magic-byte sniff. The declared content type is a claim; this checks it
 * against the first bytes of the object once it lands in storage.
 */
export function sniffImageType(head: Buffer): (typeof IMAGE_MIME_TYPES)[number] | null {
  if (head.length >= 3 && head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff) return 'image/jpeg';
  if (head.length >= 8 && head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (head.length >= 12 && head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return null;
}
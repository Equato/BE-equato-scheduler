/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import sharp, { type Metadata } from 'sharp';
import { IMAGE_MIME_TYPES, sniffImageType } from '../validation/index.js';

/**
 * Image rules shared by the API (validates an upload before accepting it) and
 * the scheduler (turns an accepted original into variants).
 *
 * What an upload must prove, from its BYTES — never its filename or the
 * browser's claimed type:
 *   - the magic bytes are JPEG, PNG or WebP, and match the declared type;
 *   - it decodes as an image of that format (sharp reads the header; a
 *     truncated or polyglot file fails here);
 *   - dimensions are within bounds, and total pixels are capped so a tiny
 *     file cannot expand into gigabytes of memory (decompression bomb).
 */

export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

export const IMAGE_LIMITS = {
  minSide: 200,
  maxSide: 12_000,
  maxPixels: 40_000_000,
} as const;

/** Variant widths (px). The card, list and gallery sizes used by the frontends. */
export const VARIANTS = [
  { name: 'thumb', width: 160 },
  { name: 'small', width: 320 },
  { name: 'medium', width: 640 },
  { name: 'large', width: 1280 },
] as const;
export type VariantName = (typeof VARIANTS)[number]['name'];
export const VARIANT_FORMATS = ['avif', 'webp', 'jpeg'] as const;
export type VariantFormat = (typeof VARIANT_FORMATS)[number];

export type InspectResult =
  | { ok: true; mime: ImageMime; width: number; height: number }
  | { ok: false; reason: 'NOT_AN_IMAGE' | 'TYPE_MISMATCH' | 'CORRUPT' | 'TOO_SMALL' | 'TOO_LARGE' };

const SHARP_FORMAT: Record<string, ImageMime> = { jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp' };

export async function inspectImage(bytes: Buffer, declared: ImageMime): Promise<InspectResult> {
  const sniffed = sniffImageType(bytes.subarray(0, 16));
  if (!sniffed) return { ok: false, reason: 'NOT_AN_IMAGE' };
  if (sniffed !== declared) return { ok: false, reason: 'TYPE_MISMATCH' };
  let meta: Metadata;
  try {
    meta = await sharp(bytes, { limitInputPixels: IMAGE_LIMITS.maxPixels, failOn: 'error' }).metadata();
  } catch (e) {
    return { ok: false, reason: /pixel limit/i.test(String(e)) ? 'TOO_LARGE' : 'CORRUPT' };
  }
  if (!meta.format || SHARP_FORMAT[meta.format] !== sniffed || !meta.width || !meta.height) return { ok: false, reason: 'CORRUPT' };
  // EXIF orientation 5–8 means the stored width/height are swapped on display.
  const [w, h] = (meta.orientation ?? 1) >= 5 ? [meta.height, meta.width] : [meta.width, meta.height];
  if (Math.min(w, h) < IMAGE_LIMITS.minSide) return { ok: false, reason: 'TOO_SMALL' };
  if (Math.max(w, h) > IMAGE_LIMITS.maxSide || w * h > IMAGE_LIMITS.maxPixels) return { ok: false, reason: 'TOO_LARGE' };
  return { ok: true, mime: sniffed, width: w, height: h };
}

export const INSPECT_MESSAGES: Record<Exclude<InspectResult, { ok: true }>['reason'], string> = {
  NOT_AN_IMAGE: 'That file is not a JPEG, PNG or WebP image.',
  TYPE_MISMATCH: 'The file’s contents don’t match its type.',
  CORRUPT: 'That image could not be read — it may be damaged.',
  TOO_SMALL: `Images must be at least ${IMAGE_LIMITS.minSide} px on each side.`,
  TOO_LARGE: 'That image is too large. Use one under 12,000 px on each side.',
};

export interface GeneratedVariant {
  name: VariantName;
  format: VariantFormat;
  width: number;
  height: number;
  bytes: Buffer;
}

/**
 * Re-encodes a validated original into every variant. Re-encoding (not
 * copying) is itself a security step: metadata (EXIF GPS!) and anything
 * appended to the file are dropped, and what we serve is bytes we produced.
 * A variant is never wider than the original (no upscaling).
 */
export async function generateVariants(original: Buffer): Promise<{ variants: GeneratedVariant[]; placeholder: string; width: number; height: number }> {
  const base = sharp(original, { limitInputPixels: IMAGE_LIMITS.maxPixels }).rotate();
  const meta = await base.clone().metadata();
  const oriented = (meta.orientation ?? 1) >= 5;
  const srcW = (oriented ? meta.height : meta.width) ?? 0;
  const srcH = (oriented ? meta.width : meta.height) ?? 0;
  const variants: GeneratedVariant[] = [];
  const widths = new Set<number>();
  for (const v of VARIANTS) {
    const width = Math.min(v.width, srcW);
    if (widths.has(width) && width === srcW) continue; // a smaller original: stop at its own size
    widths.add(width);
    const resized = base.clone().resize({ width, withoutEnlargement: true });
    const encoded = await Promise.all([
      resized.clone().avif({ quality: 55, effort: 4 }).toBuffer({ resolveWithObject: true }),
      resized.clone().webp({ quality: 78 }).toBuffer({ resolveWithObject: true }),
      resized.clone().jpeg({ quality: 80, mozjpeg: true, progressive: true }).toBuffer({ resolveWithObject: true }),
    ]);
    VARIANT_FORMATS.forEach((format, i) => variants.push({ name: v.name, format, width: encoded[i]!.info.width, height: encoded[i]!.info.height, bytes: encoded[i]!.data }));
  }
  // A ~20 px blurred preview, inlined by the client while the real image loads.
  const tiny = await base.clone().resize({ width: 20 }).blur(1).webp({ quality: 40 }).toBuffer();
  return { variants, placeholder: `data:image/webp;base64,${tiny.toString('base64')}`, width: srcW, height: srcH };
}

export const variantKey = (mediaId: string, v: { name: string; format: string }) => `public/${mediaId}/${v.name}.${v.format === 'jpeg' ? 'jpg' : v.format}`;
export const MIME_OF: Record<VariantFormat, string> = { avif: 'image/avif', webp: 'image/webp', jpeg: 'image/jpeg' };
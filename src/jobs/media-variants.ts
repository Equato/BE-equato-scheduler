import { and, eq } from 'drizzle-orm';
import { businessPhotos, media } from '../db/schema/index.js';
import { generateVariants, MIME_OF, variantKey } from '../shared/media/index.js';
import { acquireLock } from '../shared/redis/index.js';
import type { JobContext, JobOutcome } from './context.js';

/**
 * media-variants: a validated original → thumb/small/medium/large ×
 * AVIF/WebP/JPEG under public/, then READY.
 *
 * Idempotent and safe to run twice at once:
 *   - READY or deleted media is a no-op;
 *   - a Redis lock keeps two workers from encoding the same image together;
 *   - the final UPDATE is conditional on status = PROCESSING, so a photo the
 *     owner deleted mid-encode is not resurrected (its fresh objects are
 *     removed instead);
 *   - object keys are deterministic, so a retry overwrites, never duplicates.
 */
export async function mediaVariants(ctx: JobContext, payload: { mediaId: string }): Promise<JobOutcome> {
  const [m] = await ctx.db.select().from(media).where(eq(media.id, payload.mediaId)).limit(1);
  if (!m) return { status: 'skipped', detail: 'media deleted' };
  if (m.status === 'READY') return { status: 'skipped', detail: 'already processed' };
  if (m.status !== 'PROCESSING') return { status: 'skipped', detail: `status ${m.status}` };

  const lock = await acquireLock(ctx.redis, ctx.keys, `media.${m.id}`, 5 * 60_000);
  if (!lock) throw new Error('another worker is processing this media'); // retried with backoff
  try {
    const original = await ctx.storage.get(ctx.mediaBucket, m.storageKey, { maxBytes: 60_000_000 });
    const out = await generateVariants(original);
    const records: Record<string, { key: string; width: number; height: number; bytes: number }> = {};
    for (const v of out.variants) {
      const key = variantKey(m.id, v);
      // Keys never change for a given media id, so these can be cached forever.
      await ctx.storage.put(ctx.mediaBucket, key, v.bytes, { contentType: MIME_OF[v.format], cacheControl: 'public, max-age=31536000, immutable' });
      records[`${v.name}.${v.format === 'jpeg' ? 'jpg' : v.format}`] = { key, width: v.width, height: v.height, bytes: v.bytes.length };
    }
    const updated = await ctx.db
      .update(media)
      .set({ status: 'READY', variants: records, placeholder: out.placeholder, width: out.width, height: out.height, updatedAt: new Date() })
      .where(and(eq(media.id, m.id), eq(media.status, 'PROCESSING')))
      .returning({ id: media.id });
    if (!updated.length) {
      for (const r of Object.values(records)) await ctx.storage.delete(ctx.mediaBucket, r.key).catch(() => {});
      return { status: 'skipped', detail: 'media changed while processing' };
    }
    if (m.businessId) {
      // Photo or logo: the business's cached public pages now have a new image.
      const [photo] = await ctx.db.select({ id: businessPhotos.id }).from(businessPhotos).where(eq(businessPhotos.mediaId, m.id)).limit(1);
      await ctx.responseCache.invalidate([{ typename: 'Business', id: m.businessId }, ...(photo ? [{ typename: 'Photo', id: photo.id }] : [])]);
    }
    const bytesOut = Object.values(records).reduce((a, r) => a + r.bytes, 0);
    return { status: 'done', variants: out.variants.length, originalBytes: original.length, variantBytes: bytesOut };
  } finally {
    await lock.release();
  }
}

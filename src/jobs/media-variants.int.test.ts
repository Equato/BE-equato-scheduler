import sharp from 'sharp';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businesses, media } from '../db/schema/index.js';
import { testContext } from '../test/context.js';
import { mediaVariants } from './media-variants.js';
import { maintenance } from './maintenance.js';

let t: Awaited<ReturnType<typeof testContext>>;
let businessId: string;
const created: string[] = [];

beforeAll(async () => {
  t = await testContext();
  [{ id: businessId }] = (await t.ctx.db.select({ id: businesses.id }).from(businesses).limit(1)) as [{ id: string }];
});
afterAll(async () => {
  for (const id of created) await t.ctx.db.delete(media).where(eq(media.id, id));
  await t?.close();
});

async function processingMedia(width: number, height: number) {
  const original = await sharp({ create: { width, height, channels: 3, background: '#F0A231' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'x' } } }).toBuffer();
  const [row] = await t.ctx.db.insert(media).values({ kind: 'BUSINESS_PHOTO', storageKey: `originals/test-${Date.now()}-${Math.random()}.jpg`, mimeType: 'image/jpeg', byteSize: original.length, businessId, status: 'PROCESSING', width, height }).returning();
  created.push(row!.id);
  await t.ctx.storage.put(t.ctx.mediaBucket, row!.storageKey, original, { contentType: 'image/jpeg' });
  return row!;
}

describe('media-variants', () => {
  it('writes every size × format under public/, publicly fetchable, and marks READY', async () => {
    const m = await processingMedia(1600, 1200);
    const out = await mediaVariants(t.ctx, { mediaId: m.id });
    expect(out.status).toBe('done');
    const [row] = await t.ctx.db.select().from(media).where(eq(media.id, m.id));
    expect(row!.status).toBe('READY');
    expect(Object.keys(row!.variants).sort()).toEqual(['large', 'medium', 'small', 'thumb'].flatMap((n) => ['avif', 'jpg', 'webp'].map((f) => `${n}.${f}`)).sort());
    expect(row!.variants['thumb.webp']!.width).toBe(160);
    expect(row!.variants['large.jpg']!.width).toBe(1280);
    expect(row!.placeholder).toMatch(/^data:image\/webp;base64,/);

    const res = await fetch(t.ctx.storage.publicUrl(row!.variants['medium.avif']!.key));
    expect(res.status).toBe(200);
    const bytes = Buffer.from(await res.arrayBuffer());
    const meta = await sharp(bytes).metadata();
    expect(meta).toMatchObject({ format: 'heif', width: 640 });
    // Re-encoded: the original's EXIF is gone.
    const jpg = Buffer.from(await (await fetch(t.ctx.storage.publicUrl(row!.variants['large.jpg']!.key))).arrayBuffer());
    expect((await sharp(jpg).metadata()).exif).toBeUndefined();
    // Much smaller than the original for a card-sized request.
    expect(row!.variants['small.webp']!.bytes).toBeLessThan(m.byteSize!);

    // Idempotent: a duplicate delivery does nothing.
    expect((await mediaVariants(t.ctx, { mediaId: m.id })).status).toBe('skipped');
  });

  it('never upscales a small original', async () => {
    const m = await processingMedia(300, 240);
    await mediaVariants(t.ctx, { mediaId: m.id });
    const [row] = await t.ctx.db.select().from(media).where(eq(media.id, m.id));
    expect(Math.max(...Object.values(row!.variants).map((v) => v.width))).toBe(300);
  });

  it('skips media that was deleted or rejected', async () => {
    expect((await mediaVariants(t.ctx, { mediaId: '01a0db02-0000-7000-8000-000000000000' })).status).toBe('skipped');
  });

  it('maintenance deletes only media-shaped keys in our buckets', async () => {
    const m = await processingMedia(400, 300);
    await mediaVariants(t.ctx, { mediaId: m.id });
    const [row] = await t.ctx.db.select().from(media).where(eq(media.id, m.id));
    const keys = [row!.storageKey, ...Object.values(row!.variants).map((v) => v.key), '../../etc/passwd', 'secrets/x'];
    const out = await maintenance(t.ctx, { task: 'delete-objects', bucket: 'someone-elses-bucket', keys });
    expect(out.deleted).toBe(keys.length - 2);
    expect(await t.ctx.storage.head(t.ctx.mediaBucket, row!.variants['thumb.webp']!.key)).toBeNull();
  });
});

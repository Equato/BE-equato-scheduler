import { and, eq, inArray, lt, ne, or } from 'drizzle-orm';
import sharp from 'sharp';
import { businesses, categories, cities, countries, states, areas, media, notifications, offerings, scanJobs, scanResults } from '../db/schema/index.js';
import { normalizeName } from '../shared/domain/naming.js';
import { acquireLock } from '../shared/redis/index.js';
import { scannedItem, type ScannedItem } from '../shared/webhooks/index.js';
import { ScanProviderError } from '../scan/providers.js';
import type { JobContext, JobMeta, JobOutcome } from './context.js';
import { registerWebhookHandler } from './webhooks.js';

/**
 * menu-scan: uploaded menu pages → AI provider → scan_results (a proposal).
 *
 *   QUEUED ─claim→ PROCESSING ─results→ READY ─owner imports→ IMPORTED
 *                      └──────── FAILED (bad input, provider gave up, stale)
 *
 * AI output is never trusted: every item is re-validated and length-capped
 * here, low-confidence and unpriced items start unselected, and nothing is
 * written to `offerings` — the owner reviews the table and the API's import
 * creates offerings as DRAFT/PENDING_REVIEW for the normal approval flow.
 *
 * Idempotent under at-least-once delivery:
 *   - finished jobs (READY/FAILED/IMPORTED) are a no-op;
 *   - a Redis lock stops two workers calling the (paid) provider together;
 *   - results are replaced per job inside one transaction, and READY is set
 *     only WHERE status = 'PROCESSING', so a retry or a late webhook can't
 *     duplicate rows or overwrite a job the owner already imported.
 */

export const SCAN_LIMITS = {
  maxPages: 5,
  maxPageBytes: 25_000_000,
  /** Claude's vision sweet spot; larger images are downscaled server-side anyway. */
  maxEdgePx: 1568,
  maxItems: 300,
  /** A job still QUEUED/PROCESSING after this is marked FAILED by the sweep. */
  staleAfterMs: 60 * 60_000,
} as const;

const DONE = ['READY', 'FAILED', 'IMPORTED'] as const;

export async function menuScan(ctx: JobContext, payload: { scanJobId: string }, meta?: JobMeta): Promise<JobOutcome> {
  const [job] = await ctx.db.select().from(scanJobs).where(eq(scanJobs.id, payload.scanJobId)).limit(1);
  if (!job) return { status: 'skipped', detail: 'scan deleted' };
  if ((DONE as readonly string[]).includes(job.status)) return { status: 'skipped', detail: `already ${job.status}` };

  const lock = await acquireLock(ctx.redis, ctx.keys, `scan.${job.id}`, 10 * 60_000);
  if (!lock) throw new Error('another worker is reading this scan'); // retried with backoff
  try {
    const [claimed] = await ctx.db
      .update(scanJobs)
      .set({ status: 'PROCESSING', provider: ctx.scanProvider.name, error: null, updatedAt: new Date() })
      .where(and(eq(scanJobs.id, job.id), inArray(scanJobs.status, ['QUEUED', 'PROCESSING'])))
      .returning({ id: scanJobs.id });
    if (!claimed) return { status: 'skipped', detail: 'scan changed before it was claimed' };

    const [biz] = await ctx.db
      .select({ ownerId: businesses.ownerId, category: categories.name, currency: countries.currencyCode })
      .from(businesses)
      .innerJoin(categories, eq(categories.id, businesses.categoryId))
      .innerJoin(areas, eq(areas.id, businesses.areaId))
      .innerJoin(cities, eq(cities.id, areas.cityId))
      .innerJoin(states, eq(states.id, cities.stateId))
      .innerJoin(countries, eq(countries.id, states.countryId))
      .where(eq(businesses.id, job.businessId))
      .limit(1);
    if (!biz) return failScan(ctx, job.id, 'The business no longer exists');

    const ids = job.imageMediaIds.slice(0, SCAN_LIMITS.maxPages);
    // The ids came from the API, but they're checked again here: same business, a scan upload, validated.
    const rows = ids.length
      ? await ctx.db
          .select({ id: media.id, storageKey: media.storageKey })
          .from(media)
          .where(and(inArray(media.id, ids), eq(media.businessId, job.businessId), eq(media.kind, 'SCAN_UPLOAD'), inArray(media.status, ['PROCESSING', 'READY'])))
      : [];
    if (!ids.length || rows.length !== ids.length) return failScan(ctx, job.id, 'Some menu photos are missing or were rejected — upload them again');
    const byId = new Map(rows.map((r) => [r.id, r]));

    const pages = [];
    for (const id of ids) {
      const original = await ctx.storage.get(ctx.scansBucket, byId.get(id)!.storageKey, { maxBytes: SCAN_LIMITS.maxPageBytes });
      // Re-encode: honours EXIF orientation, then drops all metadata, and bounds the size we send.
      const bytes = await sharp(original, { limitInputPixels: 40_000_000 })
        .rotate()
        .resize({ width: SCAN_LIMITS.maxEdgePx, height: SCAN_LIMITS.maxEdgePx, fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 85 })
        .toBuffer();
      pages.push({ bytes, mime: 'image/jpeg' as const });
    }

    const items = await ctx.scanProvider.extract(pages, { currency: biz.currency, category: biz.category }, AbortSignal.timeout(5 * 60_000));
    return await storeScanResults(ctx, job.id, items);
  } catch (error) {
    const final = !meta || meta.attempt >= meta.maxAttempts;
    if (error instanceof ScanProviderError && (!error.retryable || final)) return failScan(ctx, job.id, error.message);
    if (final) {
      ctx.log.error({ scanJobId: job.id, error: (error as Error).message }, 'menu scan failed');
      return failScan(ctx, job.id, 'We could not read these photos — please try again');
    }
    throw error;
  } finally {
    await lock.release();
  }
}

/**
 * Validate, clean and store a provider's items for a PROCESSING job — shared
 * by the in-process provider path and the async `scan.completed` webhook.
 */
export async function storeScanResults(ctx: JobContext, scanJobId: string, raw: unknown[]): Promise<JobOutcome> {
  const items = sanitize(raw);
  if (!items.length) return failScan(ctx, scanJobId, 'No priced items were found in these photos');

  const [job] = await ctx.db.select({ businessId: scanJobs.businessId }).from(scanJobs).where(eq(scanJobs.id, scanJobId)).limit(1);
  if (!job) return { status: 'skipped', detail: 'scan deleted' };

  // Same name as something already listed → the row proposes an update, not a duplicate.
  const existing = await ctx.db
    .select({ id: offerings.id, name: offerings.name })
    .from(offerings)
    .where(and(eq(offerings.businessId, job.businessId), ne(offerings.publicationStatus, 'ARCHIVED')))
    .limit(5_000);
  const byName = new Map(existing.map((o) => [normalizeName(o.name), o.id]));

  const stored = await ctx.db.transaction(async (tx) => {
    const [ready] = await tx
      .update(scanJobs)
      .set({ status: 'READY', error: null, completedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(scanJobs.id, scanJobId), eq(scanJobs.status, 'PROCESSING')))
      .returning({ id: scanJobs.id, businessId: scanJobs.businessId });
    if (!ready) return null;
    await tx.delete(scanResults).where(eq(scanResults.scanJobId, scanJobId));
    await tx.insert(scanResults).values(
      items.map((item, i) => {
        const confidence = item.priceMinor === null ? 'LOW' : (item.confidence ?? 1) >= 0.85 ? 'HIGH' : (item.confidence ?? 1) >= 0.6 ? 'MEDIUM' : 'LOW';
        return {
          scanJobId,
          name: item.name,
          amountMinor: item.priceMinor,
          groupName: item.group ?? null,
          description: item.description ?? null,
          isVegetarian: item.isVegetarian ?? null,
          confidence,
          matchedOfferingId: byName.get(normalizeName(item.name)) ?? null,
          // A human opts IN to anything the model wasn't sure about.
          isSelected: confidence !== 'LOW',
          sortOrder: i,
        } as const;
      }),
    );
    return ready;
  });
  if (!stored) return { status: 'skipped', detail: 'scan is no longer processing' };

  await notifyOwner(ctx, stored.businessId, scanJobId, 'Menu scan ready', `${items.length} item${items.length === 1 ? '' : 's'} found — review them before they are submitted.`, 'ready');
  return { status: 'done', items: items.length };
}

/** Mark FAILED with a message safe to show the owner (never a provider response body). */
export async function failScan(ctx: JobContext, scanJobId: string, message: string): Promise<JobOutcome> {
  const [failed] = await ctx.db
    .update(scanJobs)
    .set({ status: 'FAILED', error: message.slice(0, 300), completedAt: new Date(), updatedAt: new Date() })
    .where(and(eq(scanJobs.id, scanJobId), inArray(scanJobs.status, ['QUEUED', 'PROCESSING'])))
    .returning({ businessId: scanJobs.businessId });
  if (!failed) return { status: 'skipped', detail: 'scan already finished' };
  await notifyOwner(ctx, failed.businessId, scanJobId, 'Menu scan failed', message, 'failed');
  return { status: 'done', failed: true, reason: message };
}

/** Jobs stuck QUEUED/PROCESSING (a lost queue entry, a crashed worker past its retries). */
export async function failStaleScans(ctx: JobContext): Promise<JobOutcome> {
  const stale = await ctx.db
    .select({ id: scanJobs.id })
    .from(scanJobs)
    .where(and(or(eq(scanJobs.status, 'QUEUED'), eq(scanJobs.status, 'PROCESSING')), lt(scanJobs.updatedAt, new Date(Date.now() - SCAN_LIMITS.staleAfterMs))))
    .limit(500);
  for (const s of stale) await failScan(ctx, s.id, 'This scan took too long — please try again');
  return { status: 'done', failed: stale.length };
}

function sanitize(raw: unknown[]): ScannedItem[] {
  const out: ScannedItem[] = [];
  const seen = new Set<string>();
  for (const candidate of raw.slice(0, SCAN_LIMITS.maxItems * 2)) {
    if (!candidate || typeof candidate !== 'object') continue;
    const c = candidate as Record<string, unknown>;
    const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) || null : null);
    const parsed = scannedItem.safeParse({
      name: text(c.name, 80) ?? '',
      priceMinor: typeof c.priceMinor === 'number' && Number.isInteger(c.priceMinor) && c.priceMinor >= 1 && c.priceMinor <= 100_000_000 ? c.priceMinor : null,
      group: text(c.group, 40),
      description: text(c.description, 300),
      isVegetarian: typeof c.isVegetarian === 'boolean' ? c.isVegetarian : null,
      ...(typeof c.confidence === 'number' && c.confidence >= 0 && c.confidence <= 1 ? { confidence: c.confidence } : {}),
    });
    if (!parsed.success) continue;
    const key = `${normalizeName(parsed.data.name)}|${parsed.data.priceMinor ?? ''}`;
    if (!normalizeName(parsed.data.name) || seen.has(key)) continue;
    seen.add(key);
    out.push(parsed.data);
    if (out.length >= SCAN_LIMITS.maxItems) break;
  }
  return out;
}

async function notifyOwner(ctx: JobContext, businessId: string, scanJobId: string, title: string, body: string, outcome: 'ready' | 'failed') {
  const [b] = await ctx.db.select({ ownerId: businesses.ownerId }).from(businesses).where(eq(businesses.id, businessId)).limit(1);
  if (!b) return;
  await ctx.db
    .insert(notifications)
    .values({ audience: 'OWNER', ownerId: b.ownerId, businessId, type: 'PRODUCT', title, body, link: `/b/${businessId}/scan?id=${scanJobId}`, dedupeKey: `scan:${scanJobId}:${outcome}` })
    .onConflictDoNothing()
    .catch((e: Error) => ctx.log.warn({ scanJobId, error: e.message }, 'scan notification failed'));
}

/*
 * Asynchronous providers answer through the webhook service (signature,
 * replay window, dedupe and the shared `scan-ai` contract are checked there).
 * The result goes through exactly the same validation and the same
 * PROCESSING-only transition as an in-process result.
 */
registerWebhookHandler('scan-ai', 'scan.completed', async (ctx, d) => {
  const outcome = await storeScanResults(ctx, String(d.scanJobId), Array.isArray(d.items) ? d.items : []);
  return { action: 'scan-results', ...outcome };
});
registerWebhookHandler('scan-ai', 'scan.failed', async (ctx, d) => {
  // The provider's text is not shown to owners; it is logged for us.
  ctx.log.warn({ scanJobId: d.scanJobId, providerError: String(d.error).slice(0, 200) }, 'scan provider reported failure');
  const outcome = await failScan(ctx, String(d.scanJobId), 'We could not read these photos — please try again');
  return { action: 'scan-failed', ...outcome };
});

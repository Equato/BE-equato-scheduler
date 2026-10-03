import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import Anthropic from '@anthropic-ai/sdk';
import sharp from 'sharp';
import { eq, inArray } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { businesses, media, notifications, scanJobs, scanResults } from '../db/schema/index.js';
import { testContext } from '../test/context.js';
import { anthropicProvider, ScanProviderError, type MenuScanProvider } from '../scan/providers.js';
import { menuScan, storeScanResults } from './menu-scan.js';
import { WEBHOOK_HANDLERS } from './webhooks.js';

let t: Awaited<ReturnType<typeof testContext>>;
let businessId: string;
const jobIds: string[] = [];
const mediaIds: string[] = [];

beforeAll(async () => {
  t = await testContext();
  [{ id: businessId }] = (await t.ctx.db.select({ id: businesses.id }).from(businesses).where(eq(businesses.publicationStatus, 'APPROVED')).limit(1)) as [{ id: string }];
});
afterAll(async () => {
  if (jobIds.length) {
    await t.ctx.db.delete(notifications).where(inArray(notifications.link, jobIds.map((id) => `/b/${businessId}/scan?id=${id}`)));
    await t.ctx.db.delete(scanJobs).where(inArray(scanJobs.id, jobIds));
  }
  if (mediaIds.length) await t.ctx.db.delete(media).where(inArray(media.id, mediaIds));
  await t?.close();
});

/** A validated scan page in the private bucket, and a QUEUED job over it. */
async function queuedScan(pages = 1, opts: { otherBusiness?: boolean } = {}) {
  const ids: string[] = [];
  for (let i = 0; i < pages; i++) {
    const bytes = await sharp({ create: { width: 2400, height: 3200, channels: 3, background: '#faf6ee' } }).jpeg().withMetadata({ exif: { IFD0: { Copyright: 'x' } } }).toBuffer();
    const key = `scans/${businessId}/test-${Date.now()}-${Math.random()}.jpg`;
    const [m] = await t.ctx.db
      .insert(media)
      .values({ kind: 'SCAN_UPLOAD', storageKey: key, mimeType: 'image/jpeg', byteSize: bytes.length, businessId: opts.otherBusiness ? null : businessId, status: 'READY', width: 2400, height: 3200 })
      .returning();
    await t.ctx.storage.put(t.ctx.scansBucket, key, bytes, { contentType: 'image/jpeg' });
    mediaIds.push(m!.id);
    ids.push(m!.id);
  }
  const [job] = await t.ctx.db.insert(scanJobs).values({ businessId, status: 'QUEUED', imageMediaIds: ids }).returning();
  jobIds.push(job!.id);
  return job!;
}

const withProvider = (p: MenuScanProvider) => ({ ...t.ctx, scanProvider: p });
const status = async (id: string) => (await t.ctx.db.select().from(scanJobs).where(eq(scanJobs.id, id)))[0]!;
const results = (id: string) => t.ctx.db.select().from(scanResults).where(eq(scanResults.scanJobId, id)).orderBy(scanResults.sortOrder);

describe('menu-scan job', () => {
  it('reads the pages, stores a proposal (READY), and leaves unsure items unselected', async () => {
    const job = await queuedScan(2);
    const out = await menuScan(t.ctx, { scanJobId: job.id });
    expect(out).toMatchObject({ status: 'done', items: 5 });
    const row = await status(job.id);
    expect(row).toMatchObject({ status: 'READY', provider: 'mock', error: null });
    const items = await results(job.id);
    expect(items.map((i) => i.name)).toEqual(['Masala Dosa', 'Idli Sambar', 'Paneer Butter Masala', 'Chicken Biryani', 'Filter Coffee']);
    const unpriced = items.find((i) => i.amountMinor === null)!;
    expect(unpriced).toMatchObject({ confidence: 'LOW', isSelected: false });
    expect(items.filter((i) => i.confidence === 'HIGH').every((i) => i.isSelected)).toBe(true);

    // Idempotent: a second delivery is a no-op and rows are not duplicated.
    expect((await menuScan(t.ctx, { scanJobId: job.id })).status).toBe('skipped');
    expect(await results(job.id)).toHaveLength(5);
  });

  it('sends the provider normalised JPEGs: EXIF gone, long edge ≤ 1568', async () => {
    const seen: Buffer[] = [];
    const job = await queuedScan(1);
    await menuScan(withProvider({ name: 'spy', extract: async (pages) => (seen.push(...pages.map((p) => p.bytes)), [{ name: 'Tea', priceMinor: 2000 }]) }), { scanJobId: job.id });
    const meta = await sharp(seen[0]!).metadata();
    expect(meta.format).toBe('jpeg');
    expect(Math.max(meta.width!, meta.height!)).toBe(1568);
    expect(meta.exif).toBeUndefined();
  });

  it('never trusts provider output: junk is dropped, text is capped, duplicates merged', async () => {
    const job = await queuedScan(1);
    const junk = [
      { name: '  Cold   Coffee\u0000 ', priceMinor: 9000, group: 'Beverages', description: 'x'.repeat(1000) },
      { name: 'Cold coffee', priceMinor: 9000 }, // same item twice
      { name: '', priceMinor: 100 },
      { name: 'Price is ₹-5', priceMinor: -500 },
      { name: 'Huge', priceMinor: 1e12 },
      'not an object',
      { name: 'x'.repeat(500), priceMinor: 100, isVegetarian: 'yes', confidence: 7 },
    ];
    await menuScan(withProvider({ name: 'junk', extract: async () => junk as never }), { scanJobId: job.id });
    const items = await results(job.id);
    expect(items[0]).toMatchObject({ name: 'Cold Coffee', amountMinor: 9000, groupName: 'Beverages' });
    expect(items[0]!.description!.length).toBe(300);
    expect(items.filter((i) => i.name.toLowerCase() === 'cold coffee')).toHaveLength(1);
    // Negative / absurd prices become "unreadable", never a stored price.
    expect(items.find((i) => i.name.startsWith('Price is'))).toMatchObject({ amountMinor: null, isSelected: false });
    expect(items.find((i) => i.name === 'Huge')).toMatchObject({ amountMinor: null });
    const long = items.find((i) => i.name.startsWith('xxx'))!;
    expect(long.name.length).toBe(80);
    expect(long.isVegetarian).toBeNull();
  });

  it('fails cleanly — with a safe message and an owner notification — on a permanent provider error', async () => {
    const job = await queuedScan(1);
    const out = await menuScan(withProvider({ name: 'bad', extract: async () => Promise.reject(new ScanProviderError('AI provider rejected our credentials', false)) }), { scanJobId: job.id }, { attempt: 1, maxAttempts: 5 });
    expect(out).toMatchObject({ status: 'done', failed: true });
    expect(await status(job.id)).toMatchObject({ status: 'FAILED', error: 'AI provider rejected our credentials' });
    const [n] = await t.ctx.db.select().from(notifications).where(eq(notifications.link, `/b/${businessId}/scan?id=${job.id}`));
    expect(n).toMatchObject({ audience: 'OWNER', title: 'Menu scan failed' });
  });

  it('retries a transient error, and gives up on the last attempt', async () => {
    const job = await queuedScan(1);
    const flaky: MenuScanProvider = { name: 'flaky', extract: async () => Promise.reject(new ScanProviderError('AI provider rate limit', true)) };
    await expect(menuScan(withProvider(flaky), { scanJobId: job.id }, { attempt: 1, maxAttempts: 3 })).rejects.toThrow('rate limit');
    expect((await status(job.id)).status).toBe('PROCESSING'); // BullMQ will retry
    const last = await menuScan(withProvider(flaky), { scanJobId: job.id }, { attempt: 3, maxAttempts: 3 });
    expect(last).toMatchObject({ failed: true });
    expect((await status(job.id)).status).toBe('FAILED');
  });

  it('refuses pages that do not belong to the scan’s business', async () => {
    const job = await queuedScan(1, { otherBusiness: true });
    const out = await menuScan(t.ctx, { scanJobId: job.id });
    expect(out).toMatchObject({ failed: true });
    expect((await status(job.id)).error).toMatch(/missing or were rejected/);
  });

  it('a late result cannot overwrite an imported scan', async () => {
    const job = await queuedScan(1);
    await menuScan(t.ctx, { scanJobId: job.id });
    await t.ctx.db.update(scanJobs).set({ status: 'IMPORTED' }).where(eq(scanJobs.id, job.id));
    const out = await storeScanResults(t.ctx, job.id, [{ name: 'Injected', priceMinor: 100 }]);
    expect(out.status).toBe('skipped');
    expect((await results(job.id)).some((r) => r.name === 'Injected')).toBe(false);
  });

  it('accepts async results through the scan-ai webhook with the same checks', async () => {
    const job = await queuedScan(1);
    await t.ctx.db.update(scanJobs).set({ status: 'PROCESSING' }).where(eq(scanJobs.id, job.id));
    const done = await WEBHOOK_HANDLERS['scan-ai']!['scan.completed']!(t.ctx, { scanJobId: job.id, items: [{ name: 'Vada Pav', priceMinor: 2500 }] });
    expect(done).toMatchObject({ action: 'scan-results', status: 'done', items: 1 });
    expect((await status(job.id)).status).toBe('READY');
    // A replayed/late failure for a finished scan changes nothing.
    const failed = await WEBHOOK_HANDLERS['scan-ai']!['scan.failed']!(t.ctx, { scanJobId: job.id, error: 'boom' });
    expect(failed).toMatchObject({ status: 'skipped' });
    expect((await status(job.id)).status).toBe('READY');
  });
});

/**
 * The Claude provider against a local stub of the Messages API: request
 * shape, structured-output parsing, price conversion, and error mapping.
 * No network, no key.
 */
describe('anthropic provider', () => {
  let server: Server;
  let reply: (body: any) => { status: number; body: unknown };
  const requests: any[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      let data = '';
      req.on('data', (c) => (data += c));
      req.on('end', () => {
        const body = JSON.parse(data);
        requests.push({ headers: req.headers, body });
        const r = reply(body);
        res.writeHead(r.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(r.body));
      });
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
  });
  afterAll(() => new Promise<void>((ok) => server.close(() => ok())));

  const provider = () => {
    const client = new Anthropic({ apiKey: 'sk-ant-test-not-a-real-key', baseURL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, maxRetries: 0 });
    return anthropicProvider({ apiKey: 'unused', model: 'claude-opus-5', timeoutMs: 10_000, client });
  };
  const message = (text: string, stop_reason = 'end_turn') => ({
    id: 'msg_test',
    type: 'message',
    role: 'assistant',
    model: 'claude-opus-5',
    content: [{ type: 'text', text }],
    stop_reason,
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  });
  const page = { bytes: Buffer.from([0xff, 0xd8, 0xff, 0xd9]), mime: 'image/jpeg' as const };

  it('sends images + a strict JSON schema, and converts prices to minor units', async () => {
    reply = () => ({
      status: 200,
      body: message(
        JSON.stringify({
          items: [
            { name: 'Masala Dosa', price: 120.5, group: 'South Indian', description: null, isVegetarian: true, confidence: 'high' },
            { name: 'Lassi', price: null, group: null, description: null, isVegetarian: null, confidence: 'medium' },
          ],
        }),
      ),
    });
    const items = await provider().extract([page, page], { currency: 'INR', category: 'Restaurant' });
    expect(items).toEqual([
      { name: 'Masala Dosa', priceMinor: 12050, group: 'South Indian', description: null, isVegetarian: true, confidence: 0.95 },
      { name: 'Lassi', priceMinor: null, group: null, description: null, isVegetarian: null, confidence: 0.4 },
    ]);
    const sent = requests.at(-1)!;
    expect(sent.body.model).toBe('claude-opus-5');
    expect(sent.body.fallbacks).toBe('default');
    expect(String(sent.headers['anthropic-beta'])).toContain('server-side-fallback-2026-07-01');
    expect(sent.body.output_config.format.type).toBe('json_schema');
    expect(sent.body.messages[0].content.filter((b: any) => b.type === 'image')).toHaveLength(2);
    expect(sent.body.messages[0].content[0].source).toMatchObject({ type: 'base64', media_type: 'image/jpeg' });
  });

  it('maps failures to retry or give up', async () => {
    const attempt = async (status: number) => {
      reply = () => ({ status, body: { type: 'error', error: { type: 'x', message: 'nope' } } });
      return provider().extract([page], { currency: 'INR' }).catch((e) => e);
    };
    expect(await attempt(429)).toMatchObject({ retryable: true });
    expect(await attempt(529)).toMatchObject({ retryable: true });
    expect(await attempt(500)).toMatchObject({ retryable: true });
    expect(await attempt(401)).toMatchObject({ retryable: false, message: 'AI provider rejected our credentials' });
    expect(await attempt(400)).toMatchObject({ retryable: false });
    // The key never appears in what we would store or show.
    expect(JSON.stringify(await attempt(401))).not.toContain('sk-ant');

    reply = () => ({ status: 200, body: { ...message(''), content: [], stop_reason: 'refusal' } });
    expect(await provider().extract([page], { currency: 'INR' }).catch((e) => e)).toMatchObject({ retryable: false });
    reply = () => ({ status: 200, body: message('{"items": [', 'max_tokens') });
    expect(await provider().extract([page], { currency: 'INR' }).catch((e) => e)).toMatchObject({ retryable: false, message: expect.stringMatching(/too long/) });
  });
});

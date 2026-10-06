import { and, eq, isNull, lt, sql } from 'drizzle-orm';
import { businesses, categoryRequests, notifications, offerings, outboxEvents } from '../db/schema/index.js';
import type { JobContext, JobOutcome } from './context.js';

/**
 * notifications: one domain event from the transactional outbox → in-app
 * notifications for whoever should hear about it.
 *
 *   - The event row is the input (written in the same transaction as the
 *     change); a missing row means the change rolled back → nothing to do.
 *   - Every notification carries dedupe_key = `<event id>:<recipient>` with a
 *     unique index, so redelivery (at-least-once queue, the sweep, a crash
 *     between insert and ack) never notifies anyone twice.
 *   - Preferences are read at delivery time: a shopper who turned price
 *     alerts off gets none, even for events queued before they did.
 *   - Fan-out to shoppers is ONE INSERT … SELECT, not a loop per person.
 *   - Owner-controlled text (business and item names) is stored as text and
 *     rendered as text; links are fixed in-app paths built from ids here.
 */

export const OUTBOX = { maxAttempts: 10, sweepAfterMs: 60_000, sweepBatch: 500 } as const;
/**
 * Fan-out runs in chunks of recipients (keyset on user id), so each statement
 * stays far below the statement timeout however many people follow a
 * business. Measured: one statement for 50,000 recipients took 4.75 s — a
 * business with ~100k followers would have timed out on every retry.
 */
export const FANOUT = { chunk: 10_000 };

type Audience = 'USER' | 'OWNER' | 'ADMIN';
type NotificationType = 'APPROVED' | 'REJECTED' | 'MESSAGE' | 'PRICE_DROP' | 'OFFER' | 'SAVED' | 'REVIEW' | 'BUSINESS' | 'OWNER' | 'PRODUCT' | 'USER' | 'REPORT' | 'BILLING';
interface Draft {
  audience: Audience;
  /** Stable per recipient — part of the dedupe key. */
  recipient: string;
  userId?: string | null;
  ownerId?: string | null;
  businessId?: string | null;
  type: NotificationType;
  title: string;
  body?: string;
  link: string;
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const rupees = (minor: number) => `₹${(minor / 100).toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
const DECISION_WORD: Record<string, string> = { APPROVE: 'approved', REJECT: 'not approved', SUSPEND: 'suspended', RESTORE: 'restored', ARCHIVE: 'archived' };

async function businessOf(ctx: JobContext, id: string | null | undefined) {
  if (!id) return null;
  const [b] = await ctx.db.select({ id: businesses.id, name: businesses.name, slug: businesses.slug, ownerId: businesses.ownerId, status: businesses.publicationStatus, isActive: businesses.isActive }).from(businesses).where(eq(businesses.id, id)).limit(1);
  return b ?? null;
}

const toOwner = (b: { id: string; ownerId: string }, d: Omit<Draft, 'audience' | 'recipient' | 'ownerId' | 'businessId'>): Draft => ({ audience: 'OWNER', recipient: `owner:${b.ownerId}`, ownerId: b.ownerId, businessId: b.id, ...d });
const toStaff = (d: Omit<Draft, 'audience' | 'recipient'>): Draft => ({ audience: 'ADMIN', recipient: 'staff', userId: null, ...d });

type Handler = (ctx: JobContext, p: Record<string, any>, eventId: string) => Promise<{ drafts: Draft[]; fanout?: number }>;

const fmtDate = (iso: unknown) => (typeof iso === 'string' && iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' }) : '');

/** Owner-facing wording for each billing event (shared/billing/lifecycle.ts). Amounts and dates come from the event, not from input. */
function billingText(p: Record<string, any>): { title: string; body: string } | null {
  const amount = typeof p.amountMinor === 'number' ? rupees(p.amountMinor) : '';
  const plan = typeof p.planName === 'string' ? clip(p.planName, 60) : 'your plan';
  const date = fmtDate(p.date);
  const detail = typeof p.detail === 'string' ? clip(p.detail, 200) : '';
  switch (p.kind) {
    case 'TRIAL_STARTED': return { title: `Free trial started — ${plan}`, body: date ? `Your trial runs until ${date}.` : '' };
    case 'TRIAL_ENDING': return { title: `Your free trial ends on ${date}`, body: detail };
    case 'ACTIVATED': return { title: `${plan} is active`, body: date ? `Next renewal on ${date}.` : '' };
    case 'RENEWED': return { title: `Renewed — ${plan}`, body: `${amount ? `Paid ${amount}. ` : ''}${date ? `Next renewal on ${date}.` : ''}`.trim() };
    case 'PAYMENT_SUCCEEDED': return { title: `Payment received — ${amount}`, body: date ? `${plan} is paid until ${date}.` : '' };
    case 'PAYMENT_FAILED': return { title: `Payment failed${amount ? ` — ${amount}` : ''}`, body: `${detail}${date ? ` Next attempt or deadline: ${date}.` : ''}`.trim() };
    case 'PAST_DUE': return { title: `Renewal due — ${amount}`, body: `Renew by ${date} to keep ${plan}.` };
    case 'RENEWAL_REMINDER': return { title: `${plan} renews on ${date}`, body: `${amount}. ${detail}`.trim() };
    case 'CANCEL_SCHEDULED': return { title: `Your subscription ends on ${date}`, body: 'AutoPay has been turned off. You can resume any time before then.' };
    case 'CANCELLED': return { title: 'Subscription cancelled', body: detail };
    case 'RESUMED': return { title: 'Subscription resumed', body: date ? `It continues past ${date}.` : '' };
    case 'EXPIRED': return { title: 'Subscription ended', body: detail };
    case 'PLAN_CHANGE_SCHEDULED': return { title: `Plan change scheduled — ${plan}`, body: `Starts on ${date}${amount ? ` at ${amount}` : ''}.` };
    case 'PLAN_CHANGED': return { title: `You're now on ${plan}`, body: amount ? `${amount} per period.` : '' };
    case 'MANDATE_CREATED': return { title: 'AutoPay is set up', body: `Up to ${amount} each period${date ? `, first on ${date}` : ''}. Cancel any time from Subscription & Billing.` };
    case 'MANDATE_CANCELLED': return { title: 'AutoPay turned off', body: detail };
    case 'PAUSED': return { title: 'Subscription paused', body: 'Renewals are on hold.' };
    case 'REFUNDED': return { title: `Refund issued — ${amount}`, body: '' };
    default: return null;
  }
}

const HANDLERS: Record<string, Handler> = {
  /** Subscription & billing → the business's owner (in-app, scoped to that business). */
  'billing.event': async (ctx, p) => {
    const b = await businessOf(ctx, p.businessId);
    const text = billingText(p);
    if (!b || !text) return { drafts: [] };
    return { drafts: [toOwner(b, { type: 'BILLING', title: clip(text.title, 160), body: clip(text.body, 400), link: `/b/${b.id}/billing` })] };
  },
  /** Something entered the approval queue: the shared staff inbox hears about new businesses and category requests. */
  'approval.submitted': async (ctx, p) => {
    if (p.entityType === 'BUSINESS') {
      const b = await businessOf(ctx, p.entityId);
      if (!b) return { drafts: [] };
      return { drafts: [toStaff({ businessId: b.id, type: 'BUSINESS', title: clip(`${p.resubmission ? 'Resubmitted' : 'New'} business to review: ${b.name}`, 160), link: '/approvals?tab=businesses' })] };
    }
    if (p.entityType === 'CATEGORY_REQUEST') {
      const [r] = await ctx.db.select({ name: categoryRequests.name }).from(categoryRequests).where(eq(categoryRequests.id, p.entityId)).limit(1);
      if (!r) return { drafts: [] };
      return { drafts: [toStaff({ type: 'BUSINESS', title: clip(`New category requested: ${r.name}`, 160), link: '/approvals?tab=categories' })] };
    }
    return { drafts: [] }; // items and edits: visible in the queue counts, not worth an inbox row each
  },

  /** A staff decision → the owner of the business it concerns. */
  'approval.decided': async (ctx, p) => {
    const b = await businessOf(ctx, p.businessId);
    if (!b) return { drafts: [] };
    const word = DECISION_WORD[p.action] ?? String(p.action).toLowerCase();
    const good = p.action === 'APPROVE' || p.action === 'RESTORE';
    const type: NotificationType = good ? 'APPROVED' : p.action === 'REJECT' ? 'REJECTED' : 'BUSINESS';
    const body = p.reason ? clip(`Reason: ${p.reason}`, 500) : '';
    switch (p.entityType) {
      case 'BUSINESS':
        return { drafts: [toOwner(b, { type, title: clip(good && p.action === 'APPROVE' ? `${b.name} is live on Equato` : `${b.name} was ${word}`, 160), body, link: `/b/${b.id}/approvals` })] };
      case 'BUSINESS_EDIT':
        return { drafts: [toOwner(b, { type, title: clip(`Your changes to ${b.name} were ${word}`, 160), body, link: `/b/${b.id}/profile` })] };
      case 'OFFERING':
      case 'OFFERING_EDIT': {
        // For an edit, entityId is the revision; the offering is found through it.
        const [o] =
          p.entityType === 'OFFERING'
            ? await ctx.db.select({ id: offerings.id, name: offerings.name }).from(offerings).where(eq(offerings.id, p.entityId)).limit(1)
            : ((await ctx.db.execute(sql`SELECT o.id, o.name FROM offering_revisions r JOIN offerings o ON o.id = r.offering_id WHERE r.id = ${p.entityId}::uuid`)) as unknown as { id: string; name: string }[]);
        if (!o) return { drafts: [] };
        const what = p.entityType === 'OFFERING_EDIT' ? `Your change to “${o.name}”` : `“${o.name}”`;
        const title = p.action === 'APPROVE' ? (p.entityType === 'OFFERING' ? `“${o.name}” is live at ${b.name}` : `${what} is live`) : `${what} was ${word}`;
        return { drafts: [toOwner(b, { type, title: clip(title, 160), body, link: `/b/${b.id}/offerings/${o.id}` })] };
      }
      default:
        return { drafts: [] };
    }
  },

  'review.created': async (ctx, p) => {
    const b = await businessOf(ctx, p.businessId);
    if (!b) return { drafts: [] };
    return { drafts: [toOwner(b, { type: 'REVIEW', title: clip(`New ${'★'.repeat(Math.max(1, Math.min(5, Number(p.rating) || 1)))} review for ${b.name}`, 160), link: `/b/${b.id}/reviews` })] };
  },

  /** The business answered a shopper's review — only if that shopper wants reply alerts (off by default). */
  'review.replied': async (ctx, p) => {
    const [r] = (await ctx.db.execute(sql`
      SELECT r.user_id, b.name, b.slug FROM reviews r
      JOIN businesses b ON b.id = r.business_id
      LEFT JOIN user_settings s ON s.user_id = r.user_id
      WHERE r.id = ${p.reviewId}::uuid AND r.user_id IS NOT NULL AND coalesce(s.review_reply_alerts, false)`)) as unknown as { user_id: string; name: string; slug: string }[];
    if (!r) return { drafts: [] };
    return { drafts: [{ audience: 'USER', recipient: `user:${r.user_id}`, userId: r.user_id, businessId: p.businessId, type: 'MESSAGE', title: clip(`${r.name} replied to your review`, 160), link: `/business/${r.slug}` }] };
  },

  /** Price drops and new offers fan out to everyone who saved the business and wants that alert. */
  'price.dropped': async (ctx, p, eventId) => {
    const [o] = await ctx.db.select({ name: offerings.name, status: offerings.publicationStatus, groupId: offerings.comparisonGroupId }).from(offerings).where(eq(offerings.id, p.offeringId)).limit(1);
    const b = await businessOf(ctx, p.businessId);
    if (!o || !b || o.status !== 'APPROVED' || b.status !== 'APPROVED' || !b.isActive) return { drafts: [] };
    const title = clip(`Price drop at ${b.name}: ${o.name} ${rupees(p.oldAmountMinor)} → ${rupees(p.newAmountMinor)}`, 160);
    return { drafts: [], fanout: await fanOut(ctx, eventId, { businessId: b.id, comparisonGroupId: o.groupId }, { type: 'PRICE_DROP', title, link: `/item/${p.offeringId}` }, 'price_alerts') };
  },
  'offer.published': async (ctx, p, eventId) => {
    const [offer] = (await ctx.db.execute(sql`SELECT title, status FROM offers WHERE id = ${p.offerId}::uuid`)) as unknown as { title: string; status: string }[];
    const b = await businessOf(ctx, p.businessId);
    if (!offer || !b || offer.status !== 'ACTIVE' || b.status !== 'APPROVED' || !b.isActive) return { drafts: [] };
    return { drafts: [], fanout: await fanOut(ctx, eventId, { businessId: b.id }, { type: 'OFFER', title: clip(`New offer at ${b.name}: ${offer.title}`, 160), link: `/business/${b.slug}` }, 'offer_alerts') };
  },

  'report.created': async (_ctx, p) => ({ drafts: [toStaff({ type: 'REPORT', title: clip(`New report (${String(p.targetType).toLowerCase()})`, 160), link: '/reports' })] }),
};

/**
 * Everyone who asked to hear about this business: they saved it (favourite),
 * or — for price drops — they saved a comparison this item is part of (in the
 * business's area, or with no area pinned). Deduplicated per person, filtered
 * by the preference, one INSERT … SELECT however many there are.
 */
async function fanOut(
  ctx: JobContext,
  eventId: string,
  target: { businessId: string; comparisonGroupId?: string | null },
  n: { type: NotificationType; title: string; link: string },
  pref: 'price_alerts' | 'offer_alerts',
) {
  const prefColumn = sql.raw(pref); // one of two literals above, never input
  const group = target.comparisonGroupId ?? null;
  let after = '00000000-0000-0000-0000-000000000000';
  let inserted = 0;
  for (;;) {
    // One chunk of the audience, in user-id order. Already-delivered rows
    // conflict and are skipped, so a redelivered event resumes cheaply.
    const [r] = (await ctx.db.execute(sql`
      WITH b AS (SELECT area_id FROM businesses WHERE id = ${target.businessId}::uuid),
      audience AS (
        SELECT f.user_id FROM favorites f WHERE f.business_id = ${target.businessId}::uuid AND f.user_id > ${after}::uuid
        UNION
        SELECT c.user_id FROM saved_comparisons c, b
        WHERE ${group}::uuid IS NOT NULL AND c.comparison_group_id = ${group}::uuid AND (c.area_id IS NULL OR c.area_id = b.area_id) AND c.user_id > ${after}::uuid
      ),
      chunk AS (SELECT user_id FROM audience ORDER BY user_id LIMIT ${FANOUT.chunk}),
      ins AS (
        INSERT INTO notifications (audience, user_id, business_id, type, title, body, link, dedupe_key)
        SELECT 'USER', a.user_id, ${target.businessId}::uuid, ${n.type}::notification_type, ${n.title}, '', ${n.link}, ${eventId} || ':user:' || a.user_id
        FROM chunk a
        JOIN users u ON u.id = a.user_id AND u.status = 'ACTIVE' AND u.deleted_at IS NULL
        LEFT JOIN user_settings s ON s.user_id = a.user_id
        WHERE coalesce(s.${prefColumn}, true)
        ON CONFLICT (dedupe_key) WHERE dedupe_key IS NOT NULL DO NOTHING
        RETURNING 1
      )
      SELECT (SELECT count(*) FROM chunk)::int AS seen, (SELECT max(user_id::text) FROM chunk) AS last, (SELECT count(*) FROM ins)::int AS added`)) as unknown as [{ seen: number; last: string | null; added: number }];
    inserted += r.added;
    if (r.seen < FANOUT.chunk || !r.last) return inserted;
    after = r.last;
  }
}

export async function processOutboxEvent(ctx: JobContext, payload: { outboxEventId: string }): Promise<JobOutcome> {
  const [ev] = await ctx.db.select().from(outboxEvents).where(eq(outboxEvents.id, payload.outboxEventId)).limit(1);
  if (!ev) return { status: 'skipped', detail: 'event not found (rolled back)' };
  if (ev.dispatchedAt) return { status: 'skipped', detail: 'already delivered' };
  const handler = HANDLERS[ev.type];
  try {
    const { drafts, fanout = 0 } = handler ? await handler(ctx, ev.payload as Record<string, any>, ev.id) : { drafts: [] };
    let inserted = 0;
    if (drafts.length) {
      const rows = await ctx.db
        .insert(notifications)
        .values(drafts.map(({ recipient, ...d }) => ({ ...d, body: d.body ?? '', dedupeKey: `${ev.id}:${recipient}` })))
        .onConflictDoNothing()
        .returning({ id: notifications.id });
      inserted = rows.length;
    }
    await ctx.db.update(outboxEvents).set({ dispatchedAt: new Date(), lastError: null }).where(eq(outboxEvents.id, ev.id));
    return { status: 'done', type: ev.type, notified: inserted + fanout, ...(handler ? {} : { detail: 'no handler' }) };
  } catch (error) {
    await ctx.db.update(outboxEvents).set({ attempts: sql`${outboxEvents.attempts} + 1`, lastError: (error as Error).message.slice(0, 500) }).where(eq(outboxEvents.id, ev.id));
    throw error;
  }
}

/**
 * Re-queues events the API committed but never managed to queue (Redis down,
 * a crash after commit). Job ids include the attempt count, so a retry is not
 * swallowed by BullMQ's dedupe of an earlier failed job.
 */
export async function dispatchOutbox(ctx: JobContext): Promise<JobOutcome> {
  const pending = await ctx.db
    .select({ id: outboxEvents.id, attempts: outboxEvents.attempts })
    .from(outboxEvents)
    .where(and(isNull(outboxEvents.dispatchedAt), lt(outboxEvents.createdAt, new Date(Date.now() - OUTBOX.sweepAfterMs)), lt(outboxEvents.attempts, OUTBOX.maxAttempts)))
    .orderBy(outboxEvents.createdAt)
    .limit(OUTBOX.sweepBatch);
  for (const e of pending) await ctx.queue.add('notifications', `outbox:${e.id}:sweep${e.attempts}`, { outboxEventId: e.id });
  return { status: 'done', requeued: pending.length };
}


import { outboxEvents } from '../db/schema/index.js';
import {
  reconcile,
  runBillingCycle,
  sendReminders,
  syncCheckout,
  syncMandate,
  syncPayment,
  type BillingDeps,
  type BillingEventPayload,
} from '../shared/billing/index.js';
import type { JobContext, JobOutcome } from './context.js';
import { trackedRun } from './runs.js';
import { registerWebhookHandler } from './webhooks.js';

/**
 * Subscription billing in the scheduler (never in the API):
 *
 *   billing:cycle      every 5 min — trial ends, renewals, retries, grace expiry
 *   billing:reminders  hourly       — renewal / trial-ending reminders (once per period)
 *   billing:reconcile  every 5 min  — OPEN checkouts and PENDING charges are read back
 *                                     from the provider (a lost webhook can't strand money)
 *
 * Plus the `payments` webhook handlers. All of it is idempotent and safe to
 * run on several replicas at once: subscriptions are claimed with
 * FOR UPDATE SKIP LOCKED, and UNIQUE keys (one invoice per period, one
 * transaction per idempotency key) make repeats no-ops.
 */

/** Outbox events written here are queued for the notification worker right after commit (the sweep covers a crash in between). */
export function billingDepsFor(ctx: JobContext): BillingDeps | null {
  if (!ctx.payments) return null;
  const queued: string[] = [];
  return {
    db: ctx.db,
    provider: ctx.payments,
    log: ctx.log,
    emit: async (tx, payload: BillingEventPayload) => {
      const [row] = await tx.insert(outboxEvents).values({ type: 'billing.event', payload: payload as unknown as Record<string, unknown> }).returning({ id: outboxEvents.id });
      queued.push(row!.id);
      // Queued after a short delay so the transaction has committed by the time the worker reads it.
      setTimeout(() => void ctx.queue.add('notifications', `outbox:${row!.id}`, { outboxEventId: row!.id }).catch(() => {}), 250);
    },
  };
}

export async function billing(ctx: JobContext, payload: { task: 'cycle' | 'reminders' | 'reconcile' }): Promise<JobOutcome> {
  const deps = billingDepsFor(ctx);
  if (!deps) return { status: 'skipped', detail: 'no payment provider configured' };
  switch (payload.task) {
    case 'cycle':
      return trackedRun(ctx, 'billing-cycle', 10 * 60_000, async () => ({ status: 'done', ...(await runBillingCycle(deps)) }));
    case 'reminders':
      return trackedRun(ctx, 'billing-reminders', 10 * 60_000, async () => ({ status: 'done', ...(await sendReminders(deps)) }));
    case 'reconcile':
      return trackedRun(ctx, 'billing-reconcile', 10 * 60_000, async () => ({ status: 'done', ...(await reconcile(deps)) }));
    default:
      return { status: 'skipped', detail: 'unknown task' };
  }
}

/** Payment webhooks carry references only; each handler reads the provider back before changing anything. */
export function registerBillingWebhooks(ctxDeps: (ctx: JobContext) => BillingDeps | null = billingDepsFor) {
  const need = (ctx: JobContext) => {
    const d = ctxDeps(ctx);
    if (!d) throw new Error('payments webhook received but no payment provider is configured');
    return d;
  };
  registerWebhookHandler('payments', 'checkout.updated', async (ctx, d) => {
    const r = await syncCheckout(need(ctx), String(d.checkoutRef));
    return { action: r ? `checkout ${r.status}${r.changed ? '' : ' (unchanged)'}` : 'unknown checkout' };
  });
  registerWebhookHandler('payments', 'payment.updated', async (ctx, d) => ({ action: `payment ${String(await syncPayment(need(ctx), String(d.paymentRef)))}` }));
  registerWebhookHandler('payments', 'mandate.updated', async (ctx, d) => ({ action: `mandate ${String(await syncMandate(need(ctx), String(d.mandateRef)))}` }));
}

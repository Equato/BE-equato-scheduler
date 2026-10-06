/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';
import type { BillingInterval, MandateStatus, PaymentMethodType, PaymentStatus } from '../domain/billing.js';
import { RedisNamespace, type Keyspace } from '../redis/index.js';
import { signWebhook } from '../security/webhook-signature.js';
import {
  ProviderError,
  type ChargeRequest,
  type CheckoutRequest,
  type CheckoutResult,
  type CheckoutSession,
  type MandateResult,
  type Money,
  type PaymentProvider,
  type PaymentResult,
} from './provider.js';

/**
 * A stand-in payment provider for local development and tests — NOT a
 * payment processor. It moves no money and talks to no bank. It behaves like
 * a hosted-checkout provider so the whole Equato flow can be exercised end to
 * end:
 *
 *   createCheckout → a hosted page URL (served by equato-api under /dev/…,
 *   only when PAYMENT_PROVIDER=mock and not in production) → the developer
 *   picks "approve" or "decline" there → this object records the outcome and
 *   POSTs a SIGNED webhook to equato-webhooks, exactly like a real provider →
 *   the owner is redirected back and Equato reads the result back
 *   server-side with retrieveCheckout().
 *
 * Its own state lives in Redis (it simulates an EXTERNAL system; Equato's
 * records stay in Postgres). Refused at boot in production.
 */

interface CheckoutState {
  ref: string;
  checkoutId: string;
  idempotencyKey: string;
  method: PaymentMethodType;
  recurring: boolean;
  amount: Money;
  recurringAmount: Money | null;
  interval: BillingInterval;
  intervalCount: number;
  description: string;
  returnUrl: string;
  expiresAt: string;
  status: 'OPEN' | 'COMPLETED' | 'FAILED';
  paymentRef: string | null;
  mandateRef: string | null;
  failureCode: string | null;
  failureMessage: string | null;
}
interface PaymentState extends PaymentResult {
  mandateRef: string | null;
}
interface MandateState {
  ref: string;
  status: MandateStatus;
  method: PaymentMethodType;
  maxAmount: Money;
  displayLabel: string | null;
  validUntil: string | null;
  /** Test control: decline this many upcoming debits. */
  failNextCharges: number;
}

const TTL_S = 90 * 24 * 3600;
const id = (prefix: string) => `${prefix}_mock_${randomBytes(9).toString('base64url')}`;

/** "rahul.patel@okhdfc" → "ra•••@okhdfc" — the full VPA is never kept. */
export const maskVpa = (vpa: string) => {
  const [user = '', handle = ''] = vpa.trim().toLowerCase().split('@');
  return `${user.slice(0, 2)}•••@${handle.replace(/[^a-z0-9.-]/g, '').slice(0, 20) || 'upi'}`;
};

export interface MockProviderOptions {
  redis: Redis;
  keys: Keyspace;
  /** The hosted-page URL for a checkout ref. */
  hostedUrl: (ref: string) => string;
  /** Where to POST signed webhooks (equato-webhooks /webhooks/payments). Null in tests that drive webhooks themselves. */
  webhook: { url: string; secret: string } | null;
  log?: { warn(obj: unknown, msg?: string): void };
}

export class MockPaymentProvider implements PaymentProvider {
  readonly name = 'mock';
  readonly capabilities = { upiAutopay: true, cardRecurring: true, pauseMandate: true, refunds: true };

  constructor(private readonly o: MockProviderOptions) {}

  private k(...parts: string[]) {
    // Key parts must be key-safe; idempotency keys contain ':' — hash those.
    const safe = (p: string) => (/^[\w-]{1,100}$/.test(p) ? p : createHash('sha256').update(p).digest('hex'));
    return this.o.keys.key(RedisNamespace.CACHE, 'mockpay', ...parts.map(safe));
  }
  private async get<T>(kind: string, ref: string): Promise<T | null> {
    const raw = await this.o.redis.get(this.k(kind, ref));
    return raw ? (JSON.parse(raw) as T) : null;
  }
  private async put(kind: string, ref: string, v: unknown) {
    await this.o.redis.set(this.k(kind, ref), JSON.stringify(v), 'EX', TTL_S);
  }

  /** Sends a signed event to equato-webhooks, like a real provider. Best effort: reconciliation covers a lost one. */
  async sendWebhook(type: 'checkout.updated' | 'payment.updated' | 'mandate.updated', data: Record<string, string>) {
    const w = this.o.webhook;
    if (!w) return;
    const body = Buffer.from(JSON.stringify({ id: id('evt'), type, data }));
    const ts = Math.floor(Date.now() / 1000);
    try {
      await fetch(w.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-equato-timestamp': String(ts), 'x-equato-signature': signWebhook(w.secret, ts, body) },
        body,
        signal: AbortSignal.timeout(3000),
      });
    } catch (error) {
      this.o.log?.warn({ err: (error as Error).message, type }, 'mock provider webhook not delivered (reconciliation will pick it up)');
    }
  }

  async ensureCustomer(input: { businessId: string }) {
    return `cust_mock_${input.businessId.replace(/-/g, '').slice(0, 20)}`;
  }

  async createCheckout(req: CheckoutRequest): Promise<CheckoutSession> {
    // Idempotent like a real provider: the same key returns the same session.
    const existing = await this.o.redis.get(this.k('idem', req.idempotencyKey));
    if (existing) return { providerCheckoutRef: existing, redirectUrl: this.o.hostedUrl(existing) };
    const ref = id('co');
    const state: CheckoutState = {
      ref,
      checkoutId: req.checkoutId,
      idempotencyKey: req.idempotencyKey,
      method: req.method,
      recurring: req.recurring,
      amount: req.amount,
      recurringAmount: req.recurringAmount,
      interval: req.interval,
      intervalCount: req.intervalCount,
      description: req.description,
      returnUrl: req.returnUrl,
      expiresAt: req.expiresAt.toISOString(),
      status: 'OPEN',
      paymentRef: null,
      mandateRef: null,
      failureCode: null,
      failureMessage: null,
    };
    await this.put('co', ref, state);
    await this.o.redis.set(this.k('idem', req.idempotencyKey), ref, 'EX', TTL_S);
    return { providerCheckoutRef: ref, redirectUrl: this.o.hostedUrl(ref) };
  }

  /** For the hosted page: what to show. */
  async describeCheckout(ref: string) {
    return this.get<CheckoutState>('co', ref);
  }

  /**
   * DEV/TEST CONTROL — what the person on the hosted page decided. In a real
   * provider this is the bank/UPI app's answer; here a developer clicks it.
   */
  async simulateCheckout(ref: string, outcome: 'APPROVE' | 'DECLINE' | 'CANCEL', detail: { vpa?: string; cardLast4?: string; cardBrand?: string } = {}): Promise<CheckoutState> {
    const s = await this.get<CheckoutState>('co', ref);
    if (!s) throw new ProviderError('unknown checkout', 'NOT_FOUND');
    if (s.status !== 'OPEN') return s;
    if (new Date(s.expiresAt) < new Date()) throw new ProviderError('checkout expired', 'INVALID');
    if (outcome === 'APPROVE') {
      if (s.recurring) {
        const label = s.method === 'UPI' ? maskVpa(detail.vpa || 'owner@upi') : `${detail.cardBrand || 'Visa'} •••• ${(detail.cardLast4 || '4242').replace(/\D/g, '').slice(-4)}`;
        const m: MandateState = { ref: id('mdt'), status: 'ACTIVE', method: s.method, maxAmount: s.recurringAmount ?? s.amount, displayLabel: label, validUntil: new Date(Date.now() + 5 * 365 * 86_400_000).toISOString(), failNextCharges: 0 };
        await this.put('mdt', m.ref, m);
        s.mandateRef = m.ref;
      }
      if (s.amount.amountMinor > 0) {
        const p: PaymentState = { providerPaymentRef: id('pay'), status: 'SUCCEEDED', amount: s.amount, method: s.method, mandateRef: s.mandateRef };
        await this.put('pay', p.providerPaymentRef, p);
        s.paymentRef = p.providerPaymentRef;
      }
      s.status = 'COMPLETED';
    } else {
      s.status = 'FAILED';
      s.failureCode = outcome === 'CANCEL' ? 'USER_CANCELLED' : s.method === 'UPI' ? 'UPI_DECLINED' : 'CARD_DECLINED';
      s.failureMessage = outcome === 'CANCEL' ? 'You cancelled the payment.' : s.method === 'UPI' ? 'The UPI app declined the request.' : 'The card was declined.';
      if (s.amount.amountMinor > 0) {
        const p: PaymentState = { providerPaymentRef: id('pay'), status: 'FAILED', amount: s.amount, method: s.method, mandateRef: null, failureCode: s.failureCode, failureMessage: s.failureMessage };
        await this.put('pay', p.providerPaymentRef, p);
        s.paymentRef = p.providerPaymentRef;
      }
    }
    await this.put('co', ref, s);
    void this.sendWebhook('checkout.updated', { checkoutRef: ref });
    return s;
  }

  async retrieveCheckout(ref: string): Promise<CheckoutResult> {
    const s = await this.get<CheckoutState>('co', ref);
    if (!s) throw new ProviderError('unknown checkout', 'NOT_FOUND');
    const status = s.status === 'OPEN' && new Date(s.expiresAt) < new Date() ? 'EXPIRED' : s.status;
    return {
      status,
      payment: s.paymentRef ? await this.retrievePayment(s.paymentRef) : null,
      mandate: s.mandateRef ? await this.retrieveMandate(s.mandateRef) : null,
      failureCode: s.failureCode,
      failureMessage: s.failureMessage,
    };
  }

  async retrievePayment(ref: string): Promise<PaymentResult> {
    const p = await this.get<PaymentState>('pay', ref);
    if (!p) throw new ProviderError('unknown payment', 'NOT_FOUND');
    const { mandateRef: _m, ...out } = p;
    return out;
  }

  async retrieveMandate(ref: string): Promise<MandateResult> {
    const m = await this.get<MandateState>('mdt', ref);
    if (!m) throw new ProviderError('unknown mandate', 'NOT_FOUND');
    return { providerMandateRef: m.ref, status: m.status, method: m.method, maxAmount: m.maxAmount, displayLabel: m.displayLabel, validUntil: m.validUntil ? new Date(m.validUntil) : null };
  }

  async chargeMandate(req: ChargeRequest): Promise<PaymentResult> {
    const prior = await this.o.redis.get(this.k('chargeidem', req.idempotencyKey));
    if (prior) return this.retrievePayment(prior);
    const m = await this.get<MandateState>('mdt', req.providerMandateRef);
    if (!m) throw new ProviderError('unknown mandate', 'NOT_FOUND');
    let status: PaymentStatus = 'SUCCEEDED';
    let failureCode: string | null = null;
    let failureMessage: string | null = null;
    if (m.status !== 'ACTIVE') [status, failureCode, failureMessage] = ['FAILED', 'MANDATE_INACTIVE', 'The AutoPay mandate is not active.'];
    else if (req.amount.amountMinor > m.maxAmount.amountMinor) [status, failureCode, failureMessage] = ['FAILED', 'AMOUNT_EXCEEDS_MANDATE', 'The amount is above the authorised AutoPay limit.'];
    else if (m.failNextCharges > 0) {
      [status, failureCode, failureMessage] = ['FAILED', 'INSUFFICIENT_FUNDS', 'The bank declined the debit.'];
      m.failNextCharges -= 1;
      await this.put('mdt', m.ref, m);
    }
    const p: PaymentState = { providerPaymentRef: id('pay'), status, amount: req.amount, method: m.method, mandateRef: m.ref, failureCode, failureMessage };
    await this.put('pay', p.providerPaymentRef, p);
    await this.o.redis.set(this.k('chargeidem', req.idempotencyKey), p.providerPaymentRef, 'EX', TTL_S);
    void this.sendWebhook('payment.updated', { paymentRef: p.providerPaymentRef });
    return this.retrievePayment(p.providerPaymentRef);
  }

  private async setMandate(ref: string, from: MandateStatus[], to: MandateStatus): Promise<MandateResult> {
    const m = await this.get<MandateState>('mdt', ref);
    if (!m) throw new ProviderError('unknown mandate', 'NOT_FOUND');
    if (m.status !== to) {
      if (!from.includes(m.status)) throw new ProviderError(`mandate is ${m.status}`, 'INVALID');
      m.status = to;
      await this.put('mdt', ref, m);
      void this.sendWebhook('mandate.updated', { mandateRef: ref });
    }
    return this.retrieveMandate(ref);
  }
  cancelMandate(ref: string) {
    return this.setMandate(ref, ['ACTIVE', 'PAUSED', 'PENDING', 'CREATED'], 'CANCELLED');
  }
  pauseMandate(ref: string) {
    return this.setMandate(ref, ['ACTIVE'], 'PAUSED');
  }
  resumeMandate(ref: string) {
    return this.setMandate(ref, ['PAUSED'], 'ACTIVE');
  }

  async refund(input: { providerPaymentRef: string; amount: Money; idempotencyKey: string }) {
    const p = await this.get<PaymentState>('pay', input.providerPaymentRef);
    if (!p) throw new ProviderError('unknown payment', 'NOT_FOUND');
    if (p.status !== 'SUCCEEDED' && p.status !== 'REFUNDED') throw new ProviderError('only a successful payment can be refunded', 'INVALID');
    p.status = 'REFUNDED';
    await this.put('pay', p.providerPaymentRef, p);
    void this.sendWebhook('payment.updated', { paymentRef: p.providerPaymentRef });
    return { providerRefundRef: `rfnd_${input.idempotencyKey.slice(0, 24)}`, status: 'REFUNDED' as PaymentStatus };
  }

  /** TEST CONTROL: decline the next `n` debits on a mandate (insufficient funds). */
  async failNextCharges(mandateRef: string, n: number) {
    const m = await this.get<MandateState>('mdt', mandateRef);
    if (!m) throw new ProviderError('unknown mandate', 'NOT_FOUND');
    m.failNextCharges = n;
    await this.put('mdt', mandateRef, m);
  }

  /** TEST CONTROL: the customer revoked the mandate in their UPI app / bank. */
  async revokeFromBank(mandateRef: string) {
    return this.setMandate(mandateRef, ['ACTIVE', 'PAUSED'], 'CANCELLED');
  }
}

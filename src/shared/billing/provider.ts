/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { BillingInterval, MandateStatus, PaymentMethodType, PaymentStatus } from '../domain/billing.js';

/**
 * The payment-provider boundary. Equato never sees card numbers, CVVs or UPI
 * PINs, never talks to banks or card networks, and never decides on its own
 * that money moved: every state here comes from the provider, read back
 * server-side (`retrieveCheckout`, `retrievePayment`) or delivered as a
 * signature-verified webhook (equato-webhooks → scheduler).
 *
 * A real provider (Razorpay, Cashfree, PayU, Stripe India …) is an adapter
 * implementing this interface; nothing else in the billing domain names a
 * provider. `MockPaymentProvider` implements it for local development and
 * tests and is refused in production. SUBSCRIPTIONS.md §10 lists exactly
 * which provider capabilities an adapter must supply.
 */

export interface Money {
  amountMinor: number;
  currency: string;
}

export interface CheckoutRequest {
  /** Our checkout id — the provider echoes it back so events can be matched. */
  checkoutId: string;
  /** Sent to the provider so a retried create never opens two payments. */
  idempotencyKey: string;
  businessId: string;
  customerRef: string | null;
  method: PaymentMethodType;
  /** true → set up a recurring authorisation (UPI AutoPay mandate / card e-mandate). */
  recurring: boolean;
  /** Charged now (0 for a free trial that only sets up the mandate). */
  amount: Money;
  /** The most each later debit may take (recurring only). */
  recurringAmount: Money | null;
  interval: BillingInterval;
  intervalCount: number;
  /** The exact consent sentence shown to the owner; providers that support it display it too. */
  description: string;
  returnUrl: string;
  expiresAt: Date;
}

export interface CheckoutSession {
  providerCheckoutRef: string;
  /** Provider-hosted page (card entry / UPI app choice). Equato never renders card fields. */
  redirectUrl: string;
}

/** What the provider says happened to a checkout. */
export interface CheckoutResult {
  status: 'OPEN' | 'COMPLETED' | 'FAILED' | 'EXPIRED';
  payment: PaymentResult | null;
  mandate: MandateResult | null;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface PaymentResult {
  providerPaymentRef: string;
  status: PaymentStatus;
  amount: Money;
  method: PaymentMethodType;
  failureCode?: string | null;
  failureMessage?: string | null;
}

export interface MandateResult {
  providerMandateRef: string;
  status: MandateStatus;
  method: PaymentMethodType;
  maxAmount: Money;
  /** Masked by the provider — "ra•••@okhdfc", "Visa •••• 4242". */
  displayLabel: string | null;
  validUntil: Date | null;
}

export interface ChargeRequest {
  providerMandateRef: string;
  amount: Money;
  /** Unique per (subscription, period, attempt): a retried job never debits twice. */
  idempotencyKey: string;
  description: string;
}

export interface ProviderCapabilities {
  upiAutopay: boolean;
  cardRecurring: boolean;
  pauseMandate: boolean;
  refunds: boolean;
}

export interface PaymentProvider {
  readonly name: string;
  readonly capabilities: ProviderCapabilities;
  /** Find or create the provider's customer for a business. */
  ensureCustomer(input: { businessId: string; name: string; email: string | null; phone: string | null }): Promise<string>;
  /** Hosted checkout: one-time payment, or payment + recurring authorisation. */
  createCheckout(input: CheckoutRequest): Promise<CheckoutSession>;
  /** Authoritative read-back; used after the owner returns and by reconciliation. */
  retrieveCheckout(providerCheckoutRef: string): Promise<CheckoutResult>;
  retrievePayment(providerPaymentRef: string): Promise<PaymentResult>;
  /** Debit an active mandate. The result may be PENDING — the webhook settles it. */
  chargeMandate(input: ChargeRequest): Promise<PaymentResult>;
  retrieveMandate(providerMandateRef: string): Promise<MandateResult>;
  cancelMandate(providerMandateRef: string): Promise<MandateResult>;
  pauseMandate(providerMandateRef: string): Promise<MandateResult>;
  resumeMandate(providerMandateRef: string): Promise<MandateResult>;
  refund(input: { providerPaymentRef: string; amount: Money; idempotencyKey: string; reason: string }): Promise<{ providerRefundRef: string; status: PaymentStatus }>;
}

export class ProviderError extends Error {
  constructor(
    message: string,
    readonly code: 'UNSUPPORTED' | 'NOT_FOUND' | 'DECLINED' | 'UNAVAILABLE' | 'INVALID',
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}

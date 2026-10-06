/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { Redis } from 'ioredis';
import type { Keyspace } from '../redis/index.js';
import { MockPaymentProvider } from './mock-provider.js';
import type { PaymentProvider } from './provider.js';

export * from './provider.js';
export * from './pricing.js';
export * from './rules.js';
export * from './lifecycle.js';
export { MockPaymentProvider, maskVpa } from './mock-provider.js';

export interface PaymentProviderConfig {
  PAYMENT_PROVIDER: 'mock' | 'none';
  NODE_ENV: string;
  /** Mock only: where its hosted page lives and where it delivers signed webhooks. */
  PAYMENT_MOCK_HOSTED_URL?: string | undefined;
  PAYMENT_MOCK_WEBHOOK_URL?: string | undefined;
  WEBHOOK_SECRET_PAYMENTS?: string | undefined;
}

/**
 * The configured provider, or null when billing payments are switched off.
 * A real provider adapter is added here (SUBSCRIPTIONS.md §10); the mock is
 * refused in production so it can never stand in for real payments.
 */
export function createPaymentProvider(env: PaymentProviderConfig, deps: { redis: Redis; keys: Keyspace; log?: { warn(o: unknown, m?: string): void } }): PaymentProvider | null {
  if (env.PAYMENT_PROVIDER === 'none') return null;
  if (env.PAYMENT_PROVIDER === 'mock') {
    if (env.NODE_ENV === 'production') throw new Error('PAYMENT_PROVIDER=mock is not allowed in production — configure a real payment provider adapter');
    const hosted = (env.PAYMENT_MOCK_HOSTED_URL ?? 'http://127.0.0.1:4010/dev/mock-pay').replace(/\/$/, '');
    return new MockPaymentProvider({
      redis: deps.redis,
      keys: deps.keys,
      hostedUrl: (ref) => `${hosted}/${encodeURIComponent(ref)}`,
      webhook: env.PAYMENT_MOCK_WEBHOOK_URL && env.WEBHOOK_SECRET_PAYMENTS ? { url: env.PAYMENT_MOCK_WEBHOOK_URL, secret: env.WEBHOOK_SECRET_PAYMENTS } : null,
      ...(deps.log ? { log: deps.log } : {}),
    });
  }
  throw new Error(`unknown PAYMENT_PROVIDER "${String(env.PAYMENT_PROVIDER)}"`);
}

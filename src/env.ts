import {
  baseEnvSchema,
  checkProductionSafety,
  parseEnv,
  postgresEnvSchema,
  redisEnvSchema,
  serverEnvSchema,
  storageEnvSchema,
} from './shared/config/index.js';
import { z } from 'zod';

const schema = baseEnvSchema
  .merge(serverEnvSchema)
  .merge(postgresEnvSchema)
  .merge(redisEnvSchema)
  .merge(storageEnvSchema)
  .extend({
    SERVICE_NAME: z.string().default('equato-scheduler'),
    PORT: z.coerce.number().int().default(4100),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(50).default(5),
    /** Menu-scan AI. `mock` is deterministic and offline; production must choose a real provider. */
    SCAN_AI_PROVIDER: z.enum(['mock', 'anthropic']).default('mock'),
    ANTHROPIC_API_KEY: z.string().min(20).optional(),
    SCAN_AI_MODEL: z.string().min(3).default('claude-opus-5'),
    SCAN_AI_TIMEOUT_MS: z.coerce.number().int().min(10_000).max(600_000).default(180_000),
  });

export type SchedulerEnv = z.infer<typeof schema>;
export const env: SchedulerEnv = parseEnv(schema, process.env, [
  (e) => checkProductionSafety(e),
  // A burst of jobs must not be able to exhaust the connection pool.
  (e) => (e.NODE_ENV === 'production' && e.SCAN_AI_PROVIDER === 'mock' ? 'SCAN_AI_PROVIDER=mock is not allowed in production' : null),
  (e) => (e.SCAN_AI_PROVIDER === 'anthropic' && !e.ANTHROPIC_API_KEY ? 'SCAN_AI_PROVIDER=anthropic needs ANTHROPIC_API_KEY' : null),
  (e) => (e.WORKER_CONCURRENCY > e.DATABASE_POOL_MAX ? 'WORKER_CONCURRENCY must not exceed DATABASE_POOL_MAX' : null),
]);

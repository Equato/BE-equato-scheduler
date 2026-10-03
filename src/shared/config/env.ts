/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { z } from 'zod';
import { parseDuration } from './duration.js';

/**
 * Environment parsing.
 *
 * Every service validates its environment at boot and exits if anything is
 * missing or malformed. A service that starts with a broken config and fails on
 * the first request is far harder to diagnose than one that refuses to start.
 *
 * Each app picks the slices it needs rather than every service demanding every
 * variable — the webhook service has no business knowing the SMTP password.
 *
 * Security values (TTLs, secrets) have NO defaults. A missing session TTL is a
 * deployment mistake, and silently falling back to a value someone typed into
 * this file is how a production admin ends up with a 30-day session.
 */

const nodeEnv = z.enum(['development', 'test', 'production']).default('development');

/** A duration string (`5m`, `8h`, `30d`) parsed to milliseconds. */
export const duration = () =>
  z.string().transform((value, ctx) => {
    const ms = parseDuration(value);
    if (ms === null) {
      ctx.addIssue({ code: 'custom', message: `"${value}" is not a duration like 5m, 8h or 30d` });
      return z.NEVER;
    }
    return ms;
  });

const bool = (fallback: 'true' | 'false') =>
  z
    .enum(['true', 'false'])
    .default(fallback)
    .transform((v) => v === 'true');

/** A secret: long enough to resist brute force, never a placeholder in production. */
const secret = (name: string) => z.string().min(32, `${name} must be at least 32 characters`);

/** Shared by every service. */
export const baseEnvSchema = z.object({
  NODE_ENV: nodeEnv,
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  SERVICE_NAME: z.string().min(1),
});

/**
 * All three backends connect to the SAME database. They differ only in pool
 * size and statement timeout. DATABASE_URL is the least-privilege application
 * role (DML only); MIGRATION_DATABASE_URL is the schema owner and is read only
 * by the migration runner — no request path ever holds DDL rights.
 */
export const postgresEnvSchema = z.object({
  DATABASE_URL: z.string().url(),
  /** Keep well under Postgres max_connections once every replica is counted. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(100).default(10),
  DATABASE_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(10_000),
});

export const redisEnvSchema = z.object({
  REDIS_URL: z.string().url(),
  /**
   * Root of every key this service writes. Namespaces hang off it
   * (`equato:cache:`, `equato:auth:` …) — see shared/redis/keys.ts. Tests set
   * a unique prefix so they never touch development data.
   */
  REDIS_KEY_PREFIX: z
    .string()
    .regex(/^[a-z0-9-]+$/, 'REDIS_KEY_PREFIX may contain only a-z, 0-9 and -')
    .default('equato'),
});

export const authEnvSchema = z.object({
  /**
   * Signs the short-lived access token. The PREVIOUS secret is accepted for
   * verification only, so a rotation does not log everyone out: deploy with
   * the new secret + PREVIOUS=old, wait one ACCESS_TOKEN_TTL, remove PREVIOUS.
   */
  JWT_ACCESS_SECRET: secret('JWT_ACCESS_SECRET'),
  JWT_ACCESS_SECRET_PREVIOUS: secret('JWT_ACCESS_SECRET_PREVIOUS').optional(),
  /**
   * Keys the HMAC used for refresh-token hashes and for identifiers that end
   * up in Redis keys (an email address must not appear in a rate-limit key).
   */
  SECURITY_HMAC_SECRET: secret('SECURITY_HMAC_SECRET'),

  /** The short-lived bearer token every role uses. Target: 5m. */
  ACCESS_TOKEN_TTL: duration(),
  /** Absolute main-session lifetimes. Product rule: USER > BUSINESS > ADMIN. */
  USER_SESSION_TTL: duration(),
  BUSINESS_SESSION_TTL: duration(),
  ADMIN_SESSION_TTL: duration(),
  /** An admin session that has not refreshed for this long is dead. */
  ADMIN_SESSION_IDLE_TTL: duration(),
  /** Sensitive admin actions need a re-authentication at most this old. */
  ADMIN_REAUTH_MAX_AGE: duration(),
  /**
   * How long an already-rotated refresh token is tolerated. Two tabs sharing
   * one cookie jar can race a rotation; inside this window the loser receives
   * an access token (never a second refresh token) instead of tripping reuse
   * detection and logging the user out. Outside it, reuse means theft.
   */
  REFRESH_REUSE_GRACE: duration(),

  USER_MAX_SESSIONS: z.coerce.number().int().min(1).max(100),
  BUSINESS_MAX_SESSIONS: z.coerce.number().int().min(1).max(100),
  ADMIN_MAX_SESSIONS: z.coerce.number().int().min(1).max(20),

  /** Architecture is MFA-ready; flipping this makes every admin guard demand it. */
  ADMIN_MFA_REQUIRED: bool('false'),
  /** Only ever false on plain-http localhost. Forced true in production. */
  COOKIE_SECURE: bool('true'),
});

export const storageEnvSchema = z.object({
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().default('us-east-1'),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),
  S3_BUCKET_MEDIA: z.string().min(1),
  S3_BUCKET_SCANS: z.string().min(1),
  /** MinIO needs path-style addressing; most cloud providers do not. */
  S3_FORCE_PATH_STYLE: bool('true'),
  /**
   * The endpoint BROWSERS use for presigned uploads, when it differs from the
   * one services use (a container hostname, a private network). Defaults to
   * S3_ENDPOINT.
   */
  S3_PUBLIC_ENDPOINT: z.string().url().optional(),
  /**
   * Base URL of the PUBLIC media prefix (a CDN in production). Only processed
   * variants under `public/` are ever served from here; uploads and originals
   * stay private.
   */
  MEDIA_PUBLIC_BASE_URL: z.string().url(),
  /** Largest upload accepted, in bytes. Clients compress first; this is the hard cap. */
  MEDIA_MAX_UPLOAD_BYTES: z.coerce.number().int().min(100_000).max(50_000_000).default(10_000_000),
});

/** An exact browser origin: scheme + host + optional port, nothing else. */
const origin = (name: string) =>
  z
    .string()
    .url()
    .refine((v) => {
      const u = new URL(v);
      return u.origin === v && !v.includes('*');
    }, `${name} must be an exact origin like https://app.example.com (no path, no wildcard)`);

/** Any service that listens on a port. */
export const serverEnvSchema = z.object({
  PORT: z.coerce.number().int().min(1).max(65535),
  HOST: z.string().default('0.0.0.0'),
  /**
   * Which proxies may set X-Forwarded-For. `false` (default) ignores the
   * header; a number trusts that many hops; otherwise a comma-separated list
   * of addresses/CIDRs. `true` is refused: trusting every hop lets any client
   * pick its own IP and walk straight past every per-IP rate limit.
   */
  TRUST_PROXY: z
    .string()
    .default('false')
    .transform((v, ctx): false | number | string[] => {
      if (v === 'false') return false;
      if (v === 'true') {
        ctx.addIssue({ code: 'custom', message: 'TRUST_PROXY=true trusts spoofed X-Forwarded-For; set a hop count or CIDR list' });
        return z.NEVER;
      }
      if (/^\d+$/.test(v)) return Number(v);
      return v.split(',').map((s) => s.trim()).filter(Boolean);
    }),
});

/** Only equato-api talks to browsers, so only it needs the frontend origins. */
export const corsEnvSchema = z.object({
  /** One origin per frontend. The admin origin alone may use admin sessions. */
  CORS_ORIGIN_USER: origin('CORS_ORIGIN_USER'),
  CORS_ORIGIN_BUSINESS: origin('CORS_ORIGIN_BUSINESS'),
  CORS_ORIGIN_ADMIN: origin('CORS_ORIGIN_ADMIN'),
});

export const httpEnvSchema = serverEnvSchema.merge(corsEnvSchema);

export type BaseEnv = z.infer<typeof baseEnvSchema>;

/** A cross-field rule, returning a problem message or null. */
export type EnvCheck<T> = (env: T) => string | null | readonly string[];

/** Validate without side effects — tests and tooling use this directly. */
export function validateEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined>,
  checks: readonly EnvCheck<z.infer<T>>[] = [],
): { ok: true; env: z.infer<T> } | { ok: false; problems: string[] } {
  const result = schema.safeParse(source);
  if (!result.success) {
    return {
      ok: false,
      problems: result.error.issues.map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`),
    };
  }
  const problems: string[] = [];
  for (const check of checks) {
    const outcome = check(result.data);
    if (outcome) problems.push(...(typeof outcome === 'string' ? [outcome] : outcome));
  }
  return problems.length === 0 ? { ok: true, env: result.data } : { ok: false, problems };
}

/**
 * Parse `source` against `schema`, printing every problem at once rather than
 * failing on the first one, then exiting non-zero. `checks` run only after the
 * shape is valid, for rules that span several variables.
 */
export function parseEnv<T extends z.ZodTypeAny>(
  schema: T,
  source: Record<string, string | undefined> = process.env,
  checks: readonly EnvCheck<z.infer<T>>[] = [],
): z.infer<T> {
  const result = validateEnv(schema, source, checks);
  if (result.ok) return result.env;
  process.stderr.write(
    `\nInvalid environment configuration:\n${result.problems.map((p) => `  ${p}`).join('\n')}\n\n` +
      `Copy .env.example to .env and fill in the missing values.\n\n`,
  );
  process.exit(1);
}

/* ---------------------------------------------------------------------------
 * Cross-field checks
 * ------------------------------------------------------------------------- */

type AuthEnv = z.infer<typeof authEnvSchema>;

/**
 * The product rule — USER longest, BUSINESS medium, ADMIN shortest, access
 * token shorter than all of them — is enforced at boot, so a mis-set variable
 * cannot quietly invert it.
 */
export const checkSessionTtlOrdering: EnvCheck<AuthEnv> = (env) => {
  const problems: string[] = [];
  if (!(env.USER_SESSION_TTL > env.BUSINESS_SESSION_TTL))
    problems.push('USER_SESSION_TTL must be longer than BUSINESS_SESSION_TTL');
  if (!(env.BUSINESS_SESSION_TTL > env.ADMIN_SESSION_TTL))
    problems.push('BUSINESS_SESSION_TTL must be longer than ADMIN_SESSION_TTL');
  if (!(env.ADMIN_SESSION_TTL > env.ACCESS_TOKEN_TTL))
    problems.push('ADMIN_SESSION_TTL must be longer than ACCESS_TOKEN_TTL');
  if (env.ADMIN_SESSION_IDLE_TTL > env.ADMIN_SESSION_TTL)
    problems.push('ADMIN_SESSION_IDLE_TTL cannot exceed ADMIN_SESSION_TTL');
  if (env.ADMIN_SESSION_IDLE_TTL < env.ACCESS_TOKEN_TTL)
    problems.push('ADMIN_SESSION_IDLE_TTL must be at least ACCESS_TOKEN_TTL, or admins expire between refreshes');
  // Ceilings, so "fewer refreshes" can never be bought by lengthening lifetimes:
  // a stolen access token dies within minutes, a staff session within a shift.
  if (env.ACCESS_TOKEN_TTL > 15 * 60_000) problems.push('ACCESS_TOKEN_TTL cannot exceed 15m (the design is 5m)');
  if (env.ADMIN_SESSION_TTL > 12 * 3_600_000) problems.push('ADMIN_SESSION_TTL cannot exceed 12h');
  // A 5-minute token is the target; anything past 15 minutes stops being "short-lived".
  if (env.ACCESS_TOKEN_TTL > 15 * 60_000) problems.push('ACCESS_TOKEN_TTL must not exceed 15m');
  if (env.REFRESH_REUSE_GRACE > 60_000) problems.push('REFRESH_REUSE_GRACE must not exceed 60s');
  return problems;
};

/** Markers that only ever appear in development placeholders. */
// Every documented development credential (.env.example) — the app role's and Redis's included.
const PLACEHOLDER = /dev-only|replace-me|change-?me|dev_password/i;

/** For secrets outside the schema (per-provider webhook secrets) that callers check themselves. */
export const isDevelopmentPlaceholder = (value: string): boolean => PLACEHOLDER.test(value);

// SECRET/PASSWORD/KEY anywhere in the name (JWT_ACCESS_SECRET_PREVIOUS,
// WEBHOOK_SECRET_DEFAULT, S3_ACCESS_KEY_ID), not only at the end.
const CREDENTIAL_NAME = /(^|_)(SECRET|PASSWORD|KEY)(_|$)|_URL$/;

/**
 * Production refuses to boot on development conveniences. Each rule here is a
 * real way a staging config has reached production somewhere.
 */
export function checkProductionSafety(env: Record<string, unknown>): string[] {
  if (env.NODE_ENV !== 'production') return [];
  const problems: string[] = [];

  for (const [key, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue;
    if (CREDENTIAL_NAME.test(key) && PLACEHOLDER.test(value)) {
      problems.push(`${key} still holds a development placeholder`);
    }
  }
  for (const key of ['CORS_ORIGIN_USER', 'CORS_ORIGIN_BUSINESS', 'CORS_ORIGIN_ADMIN']) {
    const value = env[key];
    if (typeof value === 'string' && !value.startsWith('https://')) problems.push(`${key} must be https in production`);
  }
  if (env.COOKIE_SECURE === false) problems.push('COOKIE_SECURE cannot be false in production');
  if (typeof env.REDIS_URL === 'string') {
    const u = new URL(env.REDIS_URL);
    if (!u.password) problems.push('REDIS_URL must carry a password in production');
  }
  if (env.GRAPHQL_INTROSPECTION === true) problems.push('GRAPHQL_INTROSPECTION must be false in production');
  return problems;
}

/** True when running against real user data — used to tighten defaults. */
export const isProduction = (env: BaseEnv): boolean => env.NODE_ENV === 'production';
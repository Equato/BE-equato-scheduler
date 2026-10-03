/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import { pino, type Logger } from 'pino';

/**
 * Structured logging.
 *
 * Production emits newline-delimited JSON for log shipping; development pipes
 * through pino-pretty so a human can read it. Both carry the same fields, so a
 * log line that makes sense locally makes sense in production.
 */

export type { Logger };

export interface LoggerOptions {
  service: string;
  level: string;
  pretty: boolean;
}

/**
 * Anything matching these keys is replaced with [Redacted] before it is
 * written. Brief §30: never log passwords, tokens or secrets.
 */
const SENSITIVE_KEYS = [
  'password',
  'newPassword',
  'currentPassword',
  'passwordHash',
  'token',
  'accessToken',
  'refreshToken',
  'tokenHash',
  'otp',
  'totpSecret',
  'totpSecretEncrypted',
  'secret',
  'apiKey',
  'authorization',
  'cookie',
  'signature',
];

/**
 * Top level and one level down, plus the header locations Fastify and HTTP
 * clients actually use. pino's redaction does not recurse, so a secret nested
 * deeper than this must not be logged in the first place — log ids, not
 * objects.
 */
export const REDACT_PATHS = [
  ...SENSITIVE_KEYS,
  ...SENSITIVE_KEYS.map((k) => `*.${k}`),
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-equato-signature"]',
  'headers.authorization',
  'headers.cookie',
  'res.headers["set-cookie"]',
  'headers["set-cookie"]',
];

export function createLogger({ service, level, pretty }: LoggerOptions): Logger {
  return pino({
    level,
    base: { service },
    redact: { paths: REDACT_PATHS, censor: '[Redacted]' },
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: {
      // `level: "info"` reads better in a log viewer than `level: 30`.
      level: (label) => ({ level: label }),
    },
    ...(pretty
      ? {
          transport: {
            target: 'pino-pretty',
            options: { colorize: true, translateTime: 'HH:MM:ss.l', ignore: 'pid,hostname,service' },
          },
        }
      : {}),
  });
}

/**
 * One id follows a request across every service it touches — API → queue job →
 * webhook processing — so a single shopper action can be traced end to end
 * (brief §30).
 */
export const CORRELATION_ID_HEADER = 'x-correlation-id';
export const REQUEST_ID_HEADER = 'x-request-id';
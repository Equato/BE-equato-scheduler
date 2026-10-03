/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';

/**
 * Connection-level failures of Postgres or Redis, as postgres.js, ioredis and
 * Node report them (Drizzle wraps the driver error in `cause`).
 */
const UNAVAILABLE_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENOTFOUND',
  'EPIPE',
  'CONNECT_TIMEOUT',
  'CONNECTION_CLOSED',
  'CONNECTION_ENDED',
  'CONNECTION_DESTROYED',
  '57P01', // admin_shutdown
  '57P02', // crash_shutdown
  '57P03', // cannot_connect_now (starting up)
  '53300', // too_many_connections
]);

export function isDependencyUnavailable(error: unknown, depth = 0): boolean {
  if (!error || typeof error !== 'object' || depth > 5) return false;
  const e = error as { code?: unknown; cause?: unknown; errors?: unknown[] };
  if (typeof e.code === 'string' && UNAVAILABLE_CODES.has(e.code)) return true;
  if (Array.isArray(e.errors) && e.errors.some((x) => isDependencyUnavailable(x, depth + 1))) return true;
  return isDependencyUnavailable(e.cause, depth + 1);
}

/**
 * Fastify's default error handler sends `error.message` with a 500 — and a
 * database error's message is the SQL and its parameters ("Failed query: …
 * params: …"). Measured, Phase 20: a sign-in during a database outage
 * returned the query. Every service registers this instead:
 *
 * - 4xx raised by Fastify itself (body too large, malformed JSON, wrong
 *   content type) keep their message — it describes the request, not us;
 * - a dependency outage is 503 with Retry-After, so clients and webhook
 *   providers retry;
 * - anything else is a generic 500. The detail goes to the log only.
 */
export function errorHandler(error: FastifyError, req: FastifyRequest, reply: FastifyReply) {
  const status = typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 500 ? error.statusCode : isDependencyUnavailable(error) ? 503 : 500;
  if (status >= 500) req.log.error({ err: error, status }, 'request failed');
  if (status === 503) return reply.code(503).header('retry-after', '5').send({ error: 'UNAVAILABLE', message: 'Temporarily unavailable. Please try again shortly.' });
  if (status === 500) return reply.code(500).send({ error: 'INTERNAL', message: 'Something went wrong.' });
  // Only codes whose message is static: FST_ERR_CTP_INVALID_MEDIA_TYPE, for
  // one, repeats the client's Content-Type header back to it.
  const fastifyOwn = typeof error.code === 'string' && PASSTHROUGH.has(error.code);
  return reply.code(status).send({ error: fastifyOwn ? error.code : 'BAD_REQUEST', message: fastifyOwn ? error.message : 'Bad request.' });
}

const PASSTHROUGH = new Set(['FST_ERR_CTP_BODY_TOO_LARGE', 'FST_ERR_CTP_EMPTY_JSON_BODY', 'FST_ERR_CTP_INVALID_JSON_BODY', 'FST_ERR_CTP_INVALID_CONTENT_LENGTH']);
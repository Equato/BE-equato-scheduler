/* ---------------------------------------------------------------------------
 * VENDORED from equato-api. Do not edit here.
 *
 * The three backends are separate repositories, so this file is duplicated
 * rather than imported. equato-api is the source of truth: change it there,
 * then run scripts/sync-shared.sh. Extracting these into a published @equato/*
 * package is the proper fix once a registry exists.
 * ------------------------------------------------------------------------- */
import type { Logger } from 'pino';
import type { Database } from '../../db/index.js';
import { auditLogs, securityEvents } from '../../db/schema/index.js';
import type { SecurityEventType, SecuritySeverity } from '../domain/index.js';

/**
 * Two streams, deliberately separate:
 *
 *   security_events  who TRIED what — sign-ins, refreshes, denials, rate-limit
 *                    trips, forged webhooks. High volume, best-effort.
 *   audit_logs       who CHANGED what — privileged mutations, with before and
 *                    after. Written in the same transaction as the change, so
 *                    a change without an audit row cannot commit.
 *
 * Neither ever stores a token, password, cookie or secret. Metadata is
 * scrubbed on the way in as a backstop, but the rule is: pass ids and reasons,
 * never request bodies.
 */

const SENSITIVE_KEY = /pass(word)?|token|secret|cookie|authorization|signature|otp|api[-_]?key/i;

export function scrubMetadata(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[Truncated]';
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrubMetadata(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value)) {
      out[key] = SENSITIVE_KEY.test(key) ? '[Redacted]' : scrubMetadata(v, depth + 1);
    }
    return out;
  }
  if (typeof value === 'string' && value.length > 500) return `${value.slice(0, 500)}…`;
  return value;
}

export interface SecurityEventInput {
  type: SecurityEventType;
  severity?: SecuritySeverity;
  userId?: string | null;
  sessionId?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
  metadata?: Record<string, unknown>;
}

export interface SecurityEventRecorder {
  /** Never throws: a failed event write must not fail the request it describes. */
  record(event: SecurityEventInput): Promise<void>;
}

export function createSecurityEventRecorder(deps: {
  db: Database;
  log: Logger;
  service: string;
}): SecurityEventRecorder {
  return {
    async record(event) {
      const severity = event.severity ?? 'INFO';
      const metadata = scrubMetadata(event.metadata ?? {}) as Record<string, unknown>;
      // Mirrored to the log so alerting works even if the insert fails.
      if (severity !== 'INFO') {
        deps.log[severity === 'CRITICAL' ? 'error' : 'warn'](
          { securityEvent: event.type, userId: event.userId, sessionId: event.sessionId, requestId: event.requestId, metadata },
          'security event',
        );
      }
      try {
        await deps.db.insert(securityEvents).values({
          type: event.type,
          severity,
          userId: event.userId ?? null,
          sessionId: event.sessionId ?? null,
          service: deps.service,
          ipAddress: event.ip?.slice(0, 64) ?? null,
          userAgent: event.userAgent?.slice(0, 512) ?? null,
          requestId: event.requestId?.slice(0, 64) ?? null,
          metadata,
        });
      } catch (error) {
        deps.log.error({ err: error, securityEvent: event.type }, 'failed to write security event');
      }
    },
  };
}

export interface AuditEntry {
  actorUserId: string | null;
  actorRole: string | null;
  action: string;
  entityType: string;
  entityId?: string | null;
  before?: Record<string, unknown> | null;
  after?: Record<string, unknown> | null;
  ip?: string | null;
  requestId?: string | null;
}

/**
 * Append an audit row. Pass the transaction the change runs in — the audit
 * row and the change commit together or not at all.
 */
export async function recordAudit(tx: Pick<Database, 'insert'>, entry: AuditEntry): Promise<void> {
  await tx.insert(auditLogs).values({
    actorUserId: entry.actorUserId,
    actorRole: entry.actorRole,
    action: entry.action,
    entityType: entry.entityType,
    entityId: entry.entityId ?? null,
    before: entry.before ? (scrubMetadata(entry.before) as Record<string, unknown>) : null,
    after: entry.after ? (scrubMetadata(entry.after) as Record<string, unknown>) : null,
    ipAddress: entry.ip?.slice(0, 64) ?? null,
    requestId: entry.requestId?.slice(0, 64) ?? null,
  });
}
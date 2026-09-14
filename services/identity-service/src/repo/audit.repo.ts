import type { Database } from '@cuc/db';
import type { Kysely, Transaction } from 'kysely';

import type { IdentityServiceDb } from '../schema.js';

export interface AuditEvent {
  readonly id: string;
  readonly at: Date;
  readonly actorType: string;
  readonly actorId: string;
  readonly actorOrgId: string;
  readonly targetOrgId: string | null;
  readonly action: string;
  readonly resource: string;
  readonly dataClass: string;
  readonly reason: string | null;
  readonly ip: string | null;
  readonly requestId: string | null;
}

/** What the AUDIT consumer's handler has after parsing the envelope (05 §3.2's columns, minus `id`/`at`, which come from the envelope itself). */
export interface AuditEventRecord {
  readonly actorType: string;
  readonly actorId: string;
  readonly actorOrgId: string;
  readonly targetOrgId?: string;
  readonly action: string;
  readonly resource: string;
  readonly dataClass: string;
  readonly reason?: string;
  readonly ip?: string;
  readonly requestId?: string;
}

function toAuditEvent(row: {
  id: string;
  at: Date;
  actor_type: string;
  actor_id: string;
  actor_org_id: string;
  target_org_id: string | null;
  action: string;
  resource: string;
  data_class: string;
  reason: string | null;
  ip: string | null;
  request_id: string | null;
}): AuditEvent {
  return {
    id: row.id,
    at: row.at,
    actorType: row.actor_type,
    actorId: row.actor_id,
    actorOrgId: row.actor_org_id,
    targetOrgId: row.target_org_id,
    action: row.action,
    resource: row.resource,
    dataClass: row.data_class,
    reason: row.reason,
    ip: row.ip,
    requestId: row.request_id,
  };
}

/**
 * Data access for `audit_events` (05 §3.2). Writes come only from the AUDIT
 * consumer (`consumers/audit.consumer.ts`) — nothing else in this service
 * inserts a row directly, matching "audit is append-only" (07 §4).
 */
export function createAuditRepo(db: Database<IdentityServiceDb>) {
  return {
    /** Inserts one row, in the consumer's own transaction (alongside its dedupe record). */
    async insert(
      trx: Kysely<IdentityServiceDb> | Transaction<IdentityServiceDb>,
      id: string,
      at: Date,
      record: AuditEventRecord,
    ): Promise<void> {
      await trx
        .insertInto('audit_events')
        .values({
          id,
          at,
          actor_type: record.actorType,
          actor_id: record.actorId,
          actor_org_id: record.actorOrgId,
          target_org_id: record.targetOrgId ?? null,
          action: record.action,
          resource: record.resource,
          data_class: record.dataClass,
          reason: record.reason ?? null,
          ip: record.ip ?? null,
          request_id: record.requestId ?? null,
        })
        .execute();
    },

    /**
     * The audit trail visible to `orgId` (07 §4): what that org's own actors
     * did (`actor_org_id = orgId`), plus what anyone did *to* that org's data
     * (`target_org_id = orgId`) — which is exactly "tenants can read their
     * own audit trail [and] see master access to their private data" without
     * needing to know org types or evaluate data class at query time. An org
     * never sees a row naming neither field, so master-internal actions
     * unrelated to `orgId` (or another org's private data) are excluded
     * structurally, not by a separate visibility check.
     */
    async listForOrg(orgId: string, limit = 100): Promise<AuditEvent[]> {
      const rows = await db.kysely
        .selectFrom('audit_events')
        .selectAll()
        .where((eb) => eb.or([eb('actor_org_id', '=', orgId), eb('target_org_id', '=', orgId)]))
        .orderBy('at', 'desc')
        .limit(limit)
        .execute();
      return rows.map(toAuditEvent);
    },
  };
}

export type AuditRepo = ReturnType<typeof createAuditRepo>;

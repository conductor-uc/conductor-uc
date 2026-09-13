import { randomUUID } from 'node:crypto';

import type { EventDefinitions, EventEnvelope, EventRegistry, PayloadOf } from '@cuc/api-contracts';
import type { Kysely, Transaction } from 'kysely';

import type { EventTables } from './schema.js';

/** What a service supplies to publish an event. */
export interface PublishRequest<TType extends string = string, TData = unknown> {
  readonly type: TType;
  readonly data: TData;
  readonly orgContext?: { readonly tenantId?: string; readonly resellerId?: string };
  readonly actor?: { readonly type: string; readonly id: string; readonly orgId: string };
  /** Ties the event to the request or call that caused it (05 §5). */
  readonly correlationId?: string;
  /** Defaults to now. Set it when replaying something that happened earlier. */
  readonly occurredAt?: Date;
  /** Supply to make a retry idempotent; defaults to a fresh id. */
  readonly id?: string;
}

/**
 * Any service schema that carries the event tables.
 *
 * Generic rather than fixed to `EventTables`, because Kysely's builders are
 * invariant in the schema: a `Transaction<ServiceDb>` is not assignable to
 * `Transaction<EventTables>`, and writing the outbox row in the service's own
 * transaction is the entire point (CLAUDE.md rule 6).
 */
export type EventDb<TDb extends EventTables> = Kysely<TDb> | Transaction<TDb>;

/**
 * Narrows a service schema to just the event tables.
 *
 * Kysely cannot resolve its builder overloads against a generic schema
 * parameter, so the implementation works with the concrete `EventTables` and this
 * is the one place that bridges the two. It is sound because `TDb extends
 * EventTables` and nothing below touches any other table.
 */
function eventTablesOf<TDb extends EventTables>(
  db: EventDb<TDb>,
): Kysely<EventTables> | Transaction<EventTables> {
  return db as unknown as Kysely<EventTables>;
}

/**
 * Writes one event to the outbox.
 *
 * **Call this inside the same transaction as the business rows it describes**
 * (CLAUDE.md rule 6). That is the whole point: the row and the event commit or
 * roll back together, so an event can never describe a write that did not
 * happen, and a write can never go unannounced.
 *
 * The payload is validated against its registered contract here rather than in
 * the relay, so a bad event fails in the request that caused it — where there is
 * a stack trace and someone to see it — instead of in a background worker.
 */
export async function enqueueEvent<
  TDb extends EventTables,
  TDefs extends EventDefinitions,
  TType extends keyof TDefs & string,
>(
  db: EventDb<TDb>,
  registry: EventRegistry<TDefs>,
  request: PublishRequest<TType, PayloadOf<TDefs, TType>>,
): Promise<string> {
  const contract = registry.contract(request.type);
  registry.assertPayload(request.type, request.data);

  const id = request.id ?? randomUUID();
  const now = new Date();

  await eventTablesOf(db)
    .insertInto('outbox')
    .values({
      id,
      type: request.type,
      schema_version: contract.schemaVersion,
      occurred_at: request.occurredAt ?? now,
      tenant_id: request.orgContext?.tenantId ?? null,
      reseller_id: request.orgContext?.resellerId ?? null,
      actor_type: request.actor?.type ?? null,
      actor_id: request.actor?.id ?? null,
      actor_org_id: request.actor?.orgId ?? null,
      correlation_id: request.correlationId ?? null,
      payload: JSON.stringify(request.data),
      created_at: now,
      published_at: null,
      attempts: 0,
      last_error: null,
      next_attempt_at: now,
    })
    .execute();

  return id;
}

/** An outbox row as the relay reads it. */
export interface OutboxRow {
  readonly id: string;
  readonly type: string;
  readonly schema_version: number;
  readonly occurred_at: Date;
  readonly tenant_id: string | null;
  readonly reseller_id: string | null;
  readonly actor_type: string | null;
  readonly actor_id: string | null;
  readonly actor_org_id: string | null;
  readonly correlation_id: string | null;
  readonly payload: unknown;
  readonly attempts: number;
}

/** Rebuilds the envelope from an outbox row. */
export function envelopeFromRow(row: OutboxRow): EventEnvelope {
  const orgContext: { tenantId?: string; resellerId?: string } = {};
  if (row.tenant_id !== null) orgContext.tenantId = row.tenant_id;
  if (row.reseller_id !== null) orgContext.resellerId = row.reseller_id;

  const envelope: {
    id: string;
    type: string;
    schemaVersion: number;
    occurredAt: string;
    orgContext: typeof orgContext;
    actor?: { type: string; id: string; orgId: string };
    correlationId?: string;
    data: unknown;
  } = {
    id: row.id,
    type: row.type,
    schemaVersion: row.schema_version,
    occurredAt: toIso(row.occurred_at),
    orgContext,
    data: parsePayload(row.payload),
  };

  if (row.actor_type !== null && row.actor_id !== null && row.actor_org_id !== null) {
    envelope.actor = { type: row.actor_type, id: row.actor_id, orgId: row.actor_org_id };
  }
  if (row.correlation_id !== null) envelope.correlationId = row.correlation_id;

  return envelope as EventEnvelope;
}

/**
 * MariaDB's `json` column comes back as a string through mysql2, but a driver or
 * dialect change could hand back a parsed value. Both are accepted so a payload
 * is never double-encoded.
 */
function parsePayload(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return payload;
  }
}

function toIso(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

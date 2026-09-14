import { randomUUID } from 'node:crypto';

import type { EventEnvelope } from '@cuc/api-contracts';
import type { UnscopedAccess, UnscopedAccessSink } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { enqueueEvent, type EventTables } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Kysely, Transaction } from 'kysely';

import { auditEvents } from './events.js';
import type { AuditEventInput } from './types.js';

type AuditEventData = ReturnType<typeof toEventData>;

function toEventData(input: AuditEventInput) {
  return {
    actorType: input.actorType,
    actorId: input.actorId,
    actorOrgId: input.actorOrgId,
    ...(input.targetOrgId === undefined ? {} : { targetOrgId: input.targetOrgId }),
    action: input.action,
    resource: input.resource,
    dataClass: input.dataClass,
    ...(input.reason === undefined ? {} : { reason: input.reason }),
    ...(input.ip === undefined ? {} : { ip: input.ip }),
    ...(input.requestId === undefined ? {} : { requestId: input.requestId }),
  };
}

function buildEnvelope(
  data: AuditEventData,
  input: AuditEventInput,
): EventEnvelope<AuditEventData> {
  const contract = auditEvents.contract('audit.event.recorded');
  auditEvents.assertPayload('audit.event.recorded', data);

  return {
    id: randomUUID(),
    type: 'audit.event.recorded',
    schemaVersion: contract.schemaVersion,
    occurredAt: (input.occurredAt ?? new Date()).toISOString(),
    orgContext: {},
    actor: { type: input.actorType, id: input.actorId, orgId: input.actorOrgId },
    ...(input.requestId === undefined ? {} : { correlationId: input.requestId }),
    data,
  };
}

/**
 * Records an audit event **inside the caller's own transaction**, alongside
 * whatever business write it describes (CLAUDE.md rule 6) — the standard
 * outbox path, for the "all writes" half of 07 §4. Call this the same way
 * any other `enqueueEvent` call is made: on `trx`, not on a bare `Kysely`
 * handle, so the event and the row it's about commit or roll back together.
 */
export async function recordAuditEvent<TDb extends EventTables>(
  db: Kysely<TDb> | Transaction<TDb>,
  input: AuditEventInput,
): Promise<string> {
  return enqueueEvent(db, auditEvents, {
    type: 'audit.event.recorded',
    data: toEventData(input),
    actor: { type: input.actorType, id: input.actorId, orgId: input.actorOrgId },
    ...(input.requestId === undefined ? {} : { correlationId: input.requestId }),
    ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }),
  });
}

/**
 * Publishes an audit event directly, bypassing the outbox — for the "all
 * private/secret reads" and "all authentication events" halves of 07 §4,
 * which have no co-transactional business write to be atomic with in the
 * first place (a read commits nothing). Best-effort: a publish failure is
 * the caller's to handle (log, retry, or ignore), not a reason to fail the
 * read that triggered it.
 */
export async function publishAuditEvent(bus: Bus, input: AuditEventInput): Promise<void> {
  const envelope = buildEnvelope(toEventData(input), input);
  await bus.publish(envelope);
}

/**
 * Adapts {@link publishAuditEvent} to `@cuc/db`'s `onUnscopedAccess` sink
 * shape, replacing the `warn`-log default `unscopedFor` otherwise falls back
 * to. `UnscopedAccess` carries no target org or resource — a cross-tenant
 * query is about many orgs at once, not one — so this records it as a
 * `private`-class `unscoped_query` action with the reason as its resource,
 * rather than inventing a target that doesn't exist. `actorType` defaults to
 * `user`: every `unscoped(ctx, reason)` call site so far is a console-driven
 * cross-tenant dashboard, not a service-to-service call.
 */
export function toUnscopedAccessSink(bus: Bus, logger: Logger): UnscopedAccessSink {
  return (access: UnscopedAccess) => {
    if (access.actorId === undefined || access.orgId === undefined) {
      logger.warn(
        { unscopedAccess: access },
        'cross-tenant query with no actor in context; no audit event published',
      );
      return;
    }

    void publishAuditEvent(bus, {
      actorType: 'user',
      actorId: access.actorId,
      actorOrgId: access.orgId,
      action: 'unscoped_query',
      resource: access.reason,
      dataClass: 'private',
      reason: access.reason,
      occurredAt: new Date(access.at),
      ...(access.requestId === undefined ? {} : { requestId: access.requestId }),
    }).catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error), unscopedAccess: access },
        'failed to publish audit event for an unscoped access',
      );
    });
  };
}

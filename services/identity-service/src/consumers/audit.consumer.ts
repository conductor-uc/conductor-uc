import { auditEvents, type AuditEventInput } from '@cuc/audit';
import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import type { AuditRepo } from '../repo/audit.repo.js';
import type { IdentityServiceDb } from '../schema.js';

type AuditEventData = Omit<AuditEventInput, 'occurredAt'>;

/**
 * The `AUDIT` stream consumer (06: "identity-service … [owns] the audit
 * store"). One durable consumer per deployment — `identity-service-audit` —
 * reading every `audit.event.recorded` envelope `@cuc/audit` publishes,
 * from any service, and inserting it into `audit_events`.
 */
export function createAuditConsumer(
  db: Database<IdentityServiceDb>,
  bus: Bus,
  logger: Logger,
  repo: AuditRepo,
): EventConsumer {
  return createConsumer<IdentityServiceDb>({
    db: db.kysely,
    bus,
    logger,
    registry: auditEvents,
    durable: 'identity-service-audit',
    subjects: ['audit.event.recorded'],
    handler: async (envelope, trx) => {
      // The envelope's `data` is validated against this exact contract at
      // publish time (`@cuc/audit`'s `recordAuditEvent`/`publishAuditEvent`
      // both call `assertPayload` before a message ever reaches NATS) — the
      // consumer only validates the envelope shape, not `data` (see
      // `packages/events/src/consumer.ts`), so this cast is trusted rather
      // than re-checked.
      const data = envelope.data as AuditEventData;
      await repo.insert(trx, envelope.id, new Date(envelope.occurredAt), data);
    },
  });
}

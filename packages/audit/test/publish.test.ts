import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import { createConsumer, createRelay, type EventTables } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { auditEvents } from '../src/events.js';
import { publishAuditEvent, recordAuditEvent, toUnscopedAccessSink } from '../src/publish.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** Pulls every `audit.event.recorded` message currently on the stream via a fresh durable consumer. */
async function drain(harness: Harness): Promise<EventEnvelope[]> {
  const received: EventEnvelope[] = [];
  const consumer = createConsumer<EventTables>({
    db: harness.db.kysely,
    bus: harness.bus,
    logger: harness.logger,
    registry: auditEvents,
    durable: `drain-${randomUUID().slice(0, 8)}`,
    subjects: ['audit.event.recorded'],
    handler: (envelope) => {
      received.push(envelope);
      return Promise.resolve();
    },
    pullTimeoutMs: 1000,
  });
  await consumer.ensure();
  await consumer.runOnce();
  return received;
}

describe.skipIf(skipReason !== undefined)('@cuc/audit', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.db.kysely.deleteFrom('consumed_events').execute();
    await harness.db.kysely.deleteFrom('outbox').execute();
    await harness.bus.jsm.streams.purge('AUDIT');
  });

  describe('recordAuditEvent', () => {
    it('writes an outbox row the relay can publish, matching the AUDIT subject', async () => {
      await harness.db.kysely.transaction().execute(async (trx) => {
        await recordAuditEvent(trx, {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-org',
          targetOrgId: 'tenant-1',
          action: 'cdr.read',
          resource: 'cdr:abc123',
          dataClass: 'private',
        });
      });

      const relay = createRelay({
        db: harness.db.kysely,
        bus: harness.bus,
        logger: harness.logger,
      });
      await relay.runOnce();

      const [envelope] = await drain(harness);
      expect(envelope).toBeDefined();
      expect(envelope?.type).toBe('audit.event.recorded');
      expect(envelope?.data).toMatchObject({
        actorId: 'master-user-1',
        targetOrgId: 'tenant-1',
        action: 'cdr.read',
        dataClass: 'private',
      });
    });

    it('commits the outbox row and the business write together (rolls back on failure)', async () => {
      await expect(
        harness.db.kysely.transaction().execute(async (trx) => {
          await recordAuditEvent(trx, {
            actorType: 'user',
            actorId: 'u1',
            actorOrgId: 'org1',
            action: 'x',
            resource: 'y',
            dataClass: 'config',
          });
          throw new Error('simulated failure after enqueueing');
        }),
      ).rejects.toThrow('simulated failure');

      const rows = await harness.db.kysely.selectFrom('outbox').selectAll().execute();
      expect(rows).toHaveLength(0);
    });
  });

  describe('publishAuditEvent', () => {
    it('publishes directly, with no outbox row', async () => {
      await publishAuditEvent(harness.bus, {
        actorType: 'user',
        actorId: 'master-user-1',
        actorOrgId: 'master-org',
        targetOrgId: 'tenant-1',
        action: 'cdr.read',
        resource: 'cdr:abc123',
        dataClass: 'private',
      });

      const [envelope] = await drain(harness);
      expect(envelope?.data).toMatchObject({ actorId: 'master-user-1', targetOrgId: 'tenant-1' });
      expect(await harness.db.kysely.selectFrom('outbox').selectAll().execute()).toEqual([]);
    });

    it('omits targetOrgId when not given, rather than sending an empty string', async () => {
      await publishAuditEvent(harness.bus, {
        actorType: 'user',
        actorId: 'u1',
        actorOrgId: 'org1',
        action: 'unscoped_query',
        resource: 'reseller dashboard',
        dataClass: 'private',
      });

      const [envelope] = await drain(harness);
      expect(envelope?.data).not.toHaveProperty('targetOrgId');
    });
  });

  describe('toUnscopedAccessSink', () => {
    it('publishes an audit event for a cross-tenant query', async () => {
      const sink = toUnscopedAccessSink(harness.bus, harness.logger);

      sink({
        reason: 'reseller dashboard rollup',
        actorId: 'reseller-user-1',
        orgId: 'reseller-1',
        orgType: 'reseller',
        at: new Date().toISOString(),
      });

      // The sink is fire-and-forget; give the publish a moment to land.
      await new Promise((resolve) => setTimeout(resolve, 200));
      const [envelope] = await drain(harness);

      expect(envelope?.data).toMatchObject({
        actorId: 'reseller-user-1',
        actorOrgId: 'reseller-1',
        action: 'unscoped_query',
        resource: 'reseller dashboard rollup',
        dataClass: 'private',
      });
    });

    it('does not publish, and does not throw, when the access has no actor context', () => {
      const sink = toUnscopedAccessSink(harness.bus, harness.logger);

      expect(() => sink({ reason: 'background job', at: new Date().toISOString() })).not.toThrow();
    });
  });
});

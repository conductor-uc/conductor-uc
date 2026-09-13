import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';
import { EventValidationError, UnknownEventTypeError } from '@cuc/api-contracts';

import { enqueueEvent, envelopeFromRow } from '../src/outbox.js';
import { testEvents } from './fixtures/schema.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

describe.skipIf(skipReason !== undefined)('outbox', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  beforeEach(async () => {
    await harness.db.kysely.deleteFrom('outbox').execute();
    await harness.db.kysely.deleteFrom('extensions').execute();
  });

  async function outboxRows() {
    return harness.db.kysely.selectFrom('outbox').selectAll().execute();
  }

  it('writes the envelope fields from the request', async () => {
    const tenantId = randomUUID();

    const eventId = await enqueueEvent(harness.db.kysely, testEvents, {
      type: 'pbx.extension.created',
      data: { extensionId: 'e1', number: '1001' },
      orgContext: { tenantId, resellerId: 'res-1' },
      actor: { type: 'user', id: 'user-1', orgId: tenantId },
      correlationId: 'req-7',
    });

    const [row] = await outboxRows();

    expect(row).toMatchObject({
      id: eventId,
      type: 'pbx.extension.created',
      schema_version: 1,
      tenant_id: tenantId,
      reseller_id: 'res-1',
      actor_type: 'user',
      actor_id: 'user-1',
      correlation_id: 'req-7',
      published_at: null,
      attempts: 0,
    });
  });

  it('takes the schema version from the registered contract, not the caller', async () => {
    await enqueueEvent(harness.db.kysely, testEvents, {
      type: 'pbx.extension.created',
      data: { extensionId: 'e1', number: '1001' },
    });

    expect((await outboxRows())[0]?.schema_version).toBe(1);
  });

  it('leaves tenant_id null for an event that belongs to no tenant', async () => {
    await enqueueEvent(harness.db.kysely, testEvents, {
      type: 'pbx.extension.created',
      data: { extensionId: 'e1', number: '1001' },
    });

    expect((await outboxRows())[0]?.tenant_id).toBeNull();
  });

  it('accepts a caller-supplied id, so a retry is idempotent', async () => {
    const id = randomUUID();

    await enqueueEvent(harness.db.kysely, testEvents, {
      id,
      type: 'pbx.extension.created',
      data: { extensionId: 'e1', number: '1001' },
    });

    expect((await outboxRows())[0]?.id).toBe(id);
  });

  it('rejects a payload that does not match its contract, in the caller’s stack', async () => {
    await expect(
      enqueueEvent(harness.db.kysely, testEvents, {
        type: 'pbx.extension.created',
        // @ts-expect-error the registry types this as a compile error too
        data: { extensionId: 'e1' },
      }),
    ).rejects.toThrow(EventValidationError);

    expect(await outboxRows()).toEqual([]);
  });

  it('rejects an unregistered event type', async () => {
    // The registry types this away entirely, so the runtime guard is reached
    // through a cast — it is what protects a service whose registry drifted from
    // the events it publishes.
    const request = { type: 'pbx.extension.exploded', data: {} } as unknown as Parameters<
      typeof enqueueEvent<never, typeof testEvents.definitions, 'pbx.extension.created'>
    >[2];

    await expect(enqueueEvent(harness.db.kysely, testEvents, request)).rejects.toThrow(
      UnknownEventTypeError,
    );
  });

  describe('the transactional guarantee', () => {
    it('commits the event with the rows it describes', async () => {
      const tenantId = randomUUID();
      const extensionId = randomUUID();

      await harness.db.kysely.transaction().execute(async (trx) => {
        await trx
          .insertInto('extensions')
          .values({ id: extensionId, tenant_id: tenantId, number: '1010' })
          .execute();
        await enqueueEvent(trx, testEvents, {
          type: 'pbx.extension.created',
          data: { extensionId, number: '1010' },
          orgContext: { tenantId },
        });
      });

      expect(await outboxRows()).toHaveLength(1);
      expect(await harness.db.kysely.selectFrom('extensions').selectAll().execute()).toHaveLength(
        1,
      );
    });

    it('rolls the event back when the business write fails', async () => {
      const tenantId = randomUUID();
      const extensionId = randomUUID();

      await expect(
        harness.db.kysely.transaction().execute(async (trx) => {
          await trx
            .insertInto('extensions')
            .values({ id: extensionId, tenant_id: tenantId, number: '1011' })
            .execute();
          await enqueueEvent(trx, testEvents, {
            type: 'pbx.extension.created',
            data: { extensionId, number: '1011' },
            orgContext: { tenantId },
          });
          throw new Error('business rule rejected the change');
        }),
      ).rejects.toThrow('business rule rejected the change');

      // Neither survived. An event can never describe a write that did not
      // happen, which is the entire reason the outbox exists (rule 6).
      expect(await outboxRows()).toEqual([]);
      expect(await harness.db.kysely.selectFrom('extensions').selectAll().execute()).toEqual([]);
    });

    it('rolls the rows back when the event is rejected', async () => {
      const extensionId = randomUUID();

      await expect(
        harness.db.kysely.transaction().execute(async (trx) => {
          await trx
            .insertInto('extensions')
            .values({ id: extensionId, tenant_id: randomUUID(), number: '1012' })
            .execute();
          await enqueueEvent(trx, testEvents, {
            type: 'pbx.extension.created',
            // @ts-expect-error deliberately off-contract
            data: { number: 1012 },
          });
        }),
      ).rejects.toThrow(EventValidationError);

      expect(await harness.db.kysely.selectFrom('extensions').selectAll().execute()).toEqual([]);
    });
  });
});

describe('envelopeFromRow', () => {
  const base = {
    id: 'evt-1',
    type: 'pbx.extension.created',
    schema_version: 1,
    occurred_at: new Date('2026-09-12T01:02:03.456Z'),
    tenant_id: null,
    reseller_id: null,
    actor_type: null,
    actor_id: null,
    actor_org_id: null,
    correlation_id: null,
    payload: '{"extensionId":"e1","number":"1001"}',
    attempts: 0,
  };

  it('rebuilds the envelope shape from 05 §5', () => {
    expect(
      envelopeFromRow({
        ...base,
        tenant_id: 'ten-1',
        reseller_id: 'res-1',
        actor_type: 'user',
        actor_id: 'user-1',
        actor_org_id: 'org-1',
        correlation_id: 'req-1',
      }),
    ).toEqual({
      id: 'evt-1',
      type: 'pbx.extension.created',
      schemaVersion: 1,
      occurredAt: '2026-09-12T01:02:03.456Z',
      orgContext: { tenantId: 'ten-1', resellerId: 'res-1' },
      actor: { type: 'user', id: 'user-1', orgId: 'org-1' },
      correlationId: 'req-1',
      data: { extensionId: 'e1', number: '1001' },
    });
  });

  it('omits an absent actor and correlation id rather than sending nulls', () => {
    const envelope = envelopeFromRow(base);

    expect(envelope).not.toHaveProperty('actor');
    expect(envelope).not.toHaveProperty('correlationId');
    expect(envelope.orgContext).toEqual({});
  });

  it('accepts a payload the driver already parsed', () => {
    expect(
      envelopeFromRow({ ...base, payload: { extensionId: 'e1', number: '1001' } }).data,
    ).toEqual({ extensionId: 'e1', number: '1001' });
  });

  it('does not double-encode a payload that is not JSON', () => {
    expect(envelopeFromRow({ ...base, payload: 'not json' }).data).toBe('not json');
  });
});

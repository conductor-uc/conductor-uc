import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { createExportConsumer } from '../src/consumers/export.consumer.js';
import { cdrEvents } from '../src/events.js';
import type { NormalizedCdr } from '../src/domain/cdr.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await s3OrSkipReason());

/** Same "a shared CI NATS server can deliver a stray event" retry shape `media-asset.consumer.test.ts` already establishes (G-17, docs/decisions.md). */
async function runOnceUntilHandled(
  consumer: EventConsumer,
  attempts = 3,
): Promise<{ handled: number; failed: number }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

function sample(tenantId: string, overrides: Partial<NormalizedCdr> = {}): NormalizedCdr {
  return {
    tenantId,
    callUuid: crypto.randomUUID(),
    nodeId: 'fs-1',
    direction: 'internal',
    startAt: new Date('2026-01-15T10:00:00.000Z'),
    answerAt: new Date('2026-01-15T10:00:02.000Z'),
    endAt: new Date('2026-01-15T10:00:30.000Z'),
    durationSec: 30,
    billableSec: 28,
    fromNumber: '101',
    fromName: null,
    toNumber: '102',
    dialedNumber: '102',
    did: null,
    trunkId: null,
    disposition: 'answered',
    hangupCause: 'NORMAL_CLEARING',
    hangupBy: 'caller',
    legs: null,
    sip: {},
    ...overrides,
  };
}

describe.skipIf(skipReason !== undefined)('export consumer', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await h.bus.jsm.streams.purge('CDR');
  });

  function consumer() {
    return createExportConsumer(h.db, h.bus, h.logger, h.storage, h.cdrs, h.exports, {
      pullTimeoutMs: 5000,
    });
  }

  async function publish(exportId: string, tenantId: string): Promise<void> {
    const type = 'cdr.export_requested' as const;
    const contract = cdrEvents.contract(type);
    cdrEvents.assertPayload(type, { exportId, tenantId });
    await h.bus.publish({
      id: crypto.randomUUID(),
      type,
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data: { exportId, tenantId },
    });
  }

  it('builds a real CSV from the matching CDRs and marks the job ready', async () => {
    const c = consumer();
    await c.ensure();

    const tenantId = crypto.randomUUID();
    await h.cdrs.ingest(sample(tenantId, { startAt: new Date('2026-01-10T00:00:00.000Z') }), null);
    await h.cdrs.ingest(sample(tenantId, { startAt: new Date('2026-01-20T00:00:00.000Z') }), null);
    // Outside the export's own range — must not appear in the CSV.
    await h.cdrs.ingest(sample(tenantId, { startAt: new Date('2026-03-01T00:00:00.000Z') }), null);

    const job = await h.exports.create(
      { tenantId },
      new Date('2026-01-01T00:00:00.000Z'),
      new Date('2026-01-31T00:00:00.000Z'),
    );

    await publish(job.id, tenantId);
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const finished = await h.exports.findById({ tenantId }, job.id);
    expect(finished?.status).toBe('ready');
    expect(finished?.objectKey).not.toBeNull();

    const csv = await h.storage.forTenant(tenantId).getObject(finished!.objectKey!);
    const lines = csv.toString('utf8').trim().split('\r\n');
    expect(lines).toHaveLength(3); // header + 2 matching rows
  });

  it('skips cleanly, not an exception, when the export job no longer exists', async () => {
    const c = consumer();
    await c.ensure();

    const tenantId = crypto.randomUUID();
    // Deliberately never created via h.exports.create.
    await publish(crypto.randomUUID(), tenantId);

    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);
    expect(pass.failed).toBe(0);
  });
});

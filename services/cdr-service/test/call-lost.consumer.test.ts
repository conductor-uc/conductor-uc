import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, natsOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { createCallLostConsumer, lostCallCdr } from '../src/consumers/call-lost.consumer.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason =
  (await databaseOrSkipReason()) ?? (await natsOrSkipReason()) ?? (await s3OrSkipReason());

const lost = (overrides: Record<string, unknown> = {}) => ({
  callUuid: crypto.randomUUID(),
  nodeId: 'fs-2',
  direction: 'inbound' as const,
  startedAt: 1_790_000_000_600,
  answeredAt: 1_790_000_010_000,
  detectedAt: 1_790_000_070_000,
  from: '+15550001111',
  to: '1001',
  extension: null,
  sipCallId: 'abc@edge',
  ...overrides,
});

describe('a lost leg as a call record (S4-04)', () => {
  it('is a node failure, ending when the loss was found, starting on the whole second', () => {
    const cdr = lostCallCdr('t1', lost());
    expect(cdr).toMatchObject({
      tenantId: 't1',
      nodeId: 'fs-2',
      direction: 'inbound',
      disposition: 'node_failure',
      hangupCause: 'NODE_FAILURE',
      hangupBy: 'system',
      durationSec: 69,
      billableSec: 60,
    });
    expect(cdr.startAt.toISOString()).toBe('2026-09-21T14:13:20.000Z');
    expect(lostCallCdr('t1', lost({ answeredAt: null })).billableSec).toBe(0);
    expect(lostCallCdr('t1', lost({ from: '101', to: '+15559990000' })).direction).toBe('outbound');
    expect(lostCallCdr('t1', lost({ from: '101', to: '102' })).direction).toBe('internal');
  });
});

describe.skipIf(skipReason !== undefined)('the call.lost consumer (S4-04)', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  async function publish(data: ReturnType<typeof lost>, tenantId?: string) {
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'call.lost',
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: tenantId === undefined ? {} : { tenantId },
      data,
    });
  }

  it("writes the tenant's node_failure record, once, and none for a leg with no tenant", async () => {
    const consumer = createCallLostConsumer(
      h.db,
      h.bus,
      h.logger,
      h.cdrs,
      () => Promise.resolve('reseller-1'),
      { pullTimeoutMs: 1000 },
    );
    await consumer.ensure();
    const tenantId = crypto.randomUUID();
    const leg = lost();
    await publish(leg, tenantId);
    await publish(leg, tenantId); // redelivered
    await publish(lost(), undefined);
    for (let i = 0; i < 5; i++) await consumer.runOnce();

    const { rows } = await h.cdrs.list({ tenantId }, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ callUuid: leg.callUuid, disposition: 'node_failure' });
  });
});

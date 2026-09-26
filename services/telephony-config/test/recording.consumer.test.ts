import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createRecordingConsumer } from '../src/consumers/recording.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { createReconciler } from '../src/reconcile.js';
import { resetSchema, startBusHarness, TEST_OPENSIPS_SIP_URI, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** As in `org.consumer.test.ts`: a shared NATS server can delay a just-published message past one pull. */
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

/**
 * S5-12 (G-111): telephony-config's own copy of each tenant's "recording required" flag, kept by
 * `recording.settings.updated` and repaired by the reconciliation pass.
 */
describe.skipIf(skipReason !== undefined)('recording-required flag (S5-12)', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await h.bus.jsm.streams.purge('RECORDING');
  });

  async function publish(tenantId: string | undefined, failClosed: boolean): Promise<void> {
    const data = { retentionDays: 90, failClosed };
    telephonyEvents.assertPayload('recording.settings.updated', data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type: 'recording.settings.updated',
      schemaVersion: telephonyEvents.contract('recording.settings.updated').schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: tenantId === undefined ? {} : { tenantId },
      data,
    });
  }

  it('stores the flag from the event, and turns it off again', async () => {
    const tenantId = crypto.randomUUID();
    const consumer = createRecordingConsumer(h.db, h.bus, h.logger, h.readModel, {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();

    expect(await h.readModel.findRecordingFailClosed(tenantId)).toBe(false);

    await publish(tenantId, true);
    expect((await runOnceUntilHandled(consumer)).handled).toBeGreaterThanOrEqual(1);
    expect(await h.readModel.findRecordingFailClosed(tenantId)).toBe(true);

    await publish(tenantId, false);
    expect((await runOnceUntilHandled(consumer)).handled).toBeGreaterThanOrEqual(1);
    expect(await h.readModel.findRecordingFailClosed(tenantId)).toBe(false);
  });

  it('skips an event with no tenant', async () => {
    const consumer = createRecordingConsumer(h.db, h.bus, h.logger, h.readModel, {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    await publish(undefined, true);
    const pass = await runOnceUntilHandled(consumer);
    expect(pass.failed).toBe(0);
    expect(await h.db.kysely.selectFrom('recording_settings').selectAll().execute()).toEqual([]);
  });

  describe('reconciliation', () => {
    function reconciler(list: () => Promise<string[]>) {
      return createReconciler(
        h.readModel,
        h.opensipsProjection,
        h.mi,
        h.logger,
        TEST_OPENSIPS_SIP_URI,
        undefined,
        { listFailClosedTenants: list },
      );
    }

    it('turns on what recording-service lists and off what it no longer lists', async () => {
      const missed = crypto.randomUUID();
      const stale = crypto.randomUUID();
      const kept = crypto.randomUUID();
      const off = crypto.randomUUID();
      await h.readModel.upsertRecordingFailClosed(h.db.kysely, stale, true);
      await h.readModel.upsertRecordingFailClosed(h.db.kysely, kept, true);
      await h.readModel.upsertRecordingFailClosed(h.db.kysely, off, false);

      const changed = await reconciler(() =>
        Promise.resolve([missed, kept]),
      ).reconcileRecordingSettingsOnce();

      expect(changed).toBe(2);
      expect(await h.readModel.findRecordingFailClosed(missed)).toBe(true);
      expect(await h.readModel.findRecordingFailClosed(kept)).toBe(true);
      expect(await h.readModel.findRecordingFailClosed(stale)).toBe(false);
      expect(await h.readModel.findRecordingFailClosed(off)).toBe(false);

      // A second pass finds nothing to do.
      expect(
        await reconciler(() => Promise.resolve([missed, kept])).reconcileRecordingSettingsOnce(),
      ).toBe(0);
    });

    it('changes nothing when recording-service cannot answer', async () => {
      const tenantId = crypto.randomUUID();
      await h.readModel.upsertRecordingFailClosed(h.db.kysely, tenantId, true);
      await expect(
        reconciler(() => Promise.reject(new Error('down'))).reconcileRecordingSettingsOnce(),
      ).rejects.toThrow('down');
      expect(await h.readModel.findRecordingFailClosed(tenantId)).toBe(true);
    });

    it('does nothing without a recording client', async () => {
      const r = createReconciler(
        h.readModel,
        h.opensipsProjection,
        h.mi,
        h.logger,
        TEST_OPENSIPS_SIP_URI,
      );
      expect(await r.reconcileRecordingSettingsOnce()).toBe(0);
    });
  });
});

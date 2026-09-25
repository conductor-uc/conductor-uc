import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createPbxConsumer } from '../src/consumers/pbx.consumer.js';
import type { CallHandlingConfig } from '../src/domain/call-handling.js';
import { telephonyEvents } from '../src/events.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

async function runOnceUntilHandled(consumer: EventConsumer, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

const settings: CallHandlingConfig = {
  dnd: false,
  dndAction: 'voicemail',
  forwardAlways: null,
  forwardBusy: { type: 'voicemail' },
  forwardNoAnswer: { type: 'external', e164: '+14155552671' },
  noAnswerSeconds: 30,
  forwardUnreachable: null,
  simultaneousRing: [{ type: 'extension', extensionId: 'other' }],
};

describe.skipIf(skipReason !== undefined)('pbx consumer: call handling', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    await resetOpenSipsSchema(h.opensipsDb);
    h.pbxConfig.credentials = {};
    h.pbxConfig.callHandling = {};
    await h.bus.jsm.streams.purge('PBX');
  });

  const consumer = () =>
    createPbxConsumer(h.db, h.bus, h.logger, h.projection, { pullTimeoutMs: 1000 });

  async function publish(
    type: 'pbx.call_handling.updated' | 'pbx.extension.deleted',
    tenantId: string,
    extensionId: string,
  ): Promise<void> {
    const data = { extensionId };
    telephonyEvents.assertPayload(type, data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type,
      schemaVersion: telephonyEvents.contract(type).schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data,
    });
  }

  it('pbx.call_handling.updated mirrors the extension call handling, and a later update replaces it', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.callHandling[extensionId] = { tenantId, settings };

    await publish('pbx.call_handling.updated', tenantId, extensionId);
    expect((await runOnceUntilHandled(c)).handled).toBeGreaterThanOrEqual(1);
    expect(await h.readModel.findCallHandling(extensionId)).toEqual(settings);

    h.pbxConfig.callHandling[extensionId] = { tenantId, settings: { ...settings, dnd: true } };
    await publish('pbx.call_handling.updated', tenantId, extensionId);
    await runOnceUntilHandled(c);
    expect((await h.readModel.findCallHandling(extensionId))?.dnd).toBe(true);
  });

  it('clears the mirror when pbx-config-service no longer has any call handling for the extension', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    await h.readModel.upsertCallHandling(h.db.kysely, { extensionId, tenantId, settings });

    await publish('pbx.call_handling.updated', tenantId, extensionId);
    await runOnceUntilHandled(c);
    expect(await h.readModel.findCallHandling(extensionId)).toBeUndefined();
  });

  it('pbx.extension.deleted removes the mirrored call handling with the extension', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    await h.readModel.upsertExtension(h.db.kysely, {
      id: extensionId,
      tenantId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      realm: 'acme.platform.test',
      callerIdName: null,
      callerIdNumber: null,
      emergencyLocationId: crypto.randomUUID(),
    });
    await h.readModel.upsertCallHandling(h.db.kysely, { extensionId, tenantId, settings });

    await publish('pbx.extension.deleted', tenantId, extensionId);
    await runOnceUntilHandled(c);
    expect(await h.readModel.findCallHandling(extensionId)).toBeUndefined();
  });

  it("mirrors per tenant: one tenant's update never touches another tenant's row", async () => {
    const c = consumer();
    await c.ensure();
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    await h.readModel.upsertCallHandling(h.db.kysely, {
      extensionId: b,
      tenantId: tenantB,
      settings,
    });
    h.pbxConfig.callHandling[a] = { tenantId: tenantA, settings: { ...settings, dnd: true } };

    await publish('pbx.call_handling.updated', tenantA, a);
    await runOnceUntilHandled(c);
    expect((await h.readModel.findCallHandling(a))?.dnd).toBe(true);
    expect(await h.readModel.findCallHandling(b)).toEqual(settings);
    expect(await h.readModel.listCallHandlingForTenant(tenantB)).toHaveLength(1);
  });
});

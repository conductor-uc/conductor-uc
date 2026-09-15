import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createPbxConsumer } from '../src/consumers/pbx.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * `pass.handled` assertions below use `toBeGreaterThanOrEqual(1)`, not
 * `toBe(1)`: see `org.consumer.test.ts`'s identical note (gap G-17,
 * docs/decisions.md) — this file's PBX stream is not known to collide with
 * any other suite's tests today, but the same shared-server risk applies to
 * any future one that publishes real `pbx.*` events.
 */
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

describe.skipIf(skipReason !== undefined)('pbx consumer', () => {
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
    await h.bus.jsm.streams.purge('PBX');
  });

  function consumer() {
    return createPbxConsumer(h.db, h.bus, h.logger, h.projection, { pullTimeoutMs: 5000 });
  }

  async function publish(
    type: 'pbx.extension.created' | 'pbx.extension.updated' | 'pbx.extension.deleted',
    tenantId: string,
    data: Record<string, unknown>,
  ): Promise<void> {
    const contract = telephonyEvents.contract(type);
    telephonyEvents.assertPayload(type, data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type,
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: { tenantId },
      data,
    });
  }

  it("pbx.extension.created projects the subscriber row — S1-12's own acceptance test", async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
    };

    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const subscribers = await h.opensipsProjection.listSubscribers();
    expect(subscribers).toEqual([{ username: '101', domain: 'acme.platform.test' }]);

    const row = await h.opensipsDb.kysely
      .selectFrom('subscriber')
      .select('ha1')
      .where('username', '=', '101')
      .executeTakeFirstOrThrow();
    expect(row.ha1).toBe('a'.repeat(32));
  });

  it('pbx.extension.updated re-fetches and re-projects, moving the row if the realm changed', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'old.platform.test',
    };
    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    await runOnceUntilHandled(c);

    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      username: '101',
      ha1: 'c'.repeat(32),
      ha1b: 'd'.repeat(32),
      realm: 'new.platform.test',
    };
    await publish('pbx.extension.updated', tenantId, { extensionId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const subscribers = await h.opensipsProjection.listSubscribers();
    expect(subscribers).toEqual([{ username: '101', domain: 'new.platform.test' }]);
  });

  it('pbx.extension.deleted removes the subscriber row', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
    };
    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    await runOnceUntilHandled(c);

    await publish('pbx.extension.deleted', tenantId, { extensionId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(await h.opensipsProjection.listSubscribers()).toEqual([]);
  });

  it('redelivery does not re-project twice (dedupe via consumed_events)', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();
    const extensionId = crypto.randomUUID();
    h.pbxConfig.credentials[extensionId] = {
      extensionId,
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
    };

    await publish('pbx.extension.created', tenantId, {
      extensionId,
      number: '101',
      displayName: 'Front Desk',
    });
    const first = await runOnceUntilHandled(c);
    expect(first.handled).toBeGreaterThanOrEqual(1);

    const second = await c.runOnce();
    expect(second.handled).toBe(0);
  });
});

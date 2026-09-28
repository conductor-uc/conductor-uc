import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';
import type { EventConsumer } from '@cuc/events';

import { createInvitationConsumer } from '../src/consumers/invitation.consumer.js';
import { pbxEvents } from '../src/events.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/** As in domain.consumer.test.ts: a shared NATS server can starve one pull. */
async function runUntilHandled(consumer: EventConsumer, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

/**
 * S9-07 (D-019): a person added in the console with an invitation has an
 * extension waiting for them, linked once they accept.
 */
describe.skipIf(skipReason !== undefined)(
  'invitation consumer (identity.invitation.accepted)',
  () => {
    let h: BusHarness;
    let consumer: EventConsumer;

    beforeAll(async () => {
      h = await startBusHarness();
      consumer = createInvitationConsumer(h.db, h.bus, h.logger, h.extensions, {
        pullTimeoutMs: 5000,
      });
      await consumer.ensure();
    });

    afterAll(async () => {
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
      h.domains.realms = {};
      await h.bus.jsm.streams.purge('IDENTITY');
    });

    async function extension(tenantId: string, number: string, userId: string | null = null) {
      h.domains.realms[tenantId] = 'tenant.platform.test';
      const location = await h.emergencyLocations.create(
        { tenantId },
        {
          label: 'Office',
          addressLine1: '1 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        },
      );
      return h.extensions.create(
        { tenantId },
        { number, displayName: 'Maria Lopez', emergencyLocationId: location.id, userId },
      );
    }

    async function accepted(data: { orgId: string; userId: string; extensionId: string | null }) {
      const full = { invitationId: crypto.randomUUID(), ...data };
      pbxEvents.assertPayload('identity.invitation.accepted', full);
      await h.bus.publish({
        id: crypto.randomUUID(),
        type: 'identity.invitation.accepted',
        schemaVersion: pbxEvents.contract('identity.invitation.accepted').schemaVersion,
        occurredAt: new Date().toISOString(),
        orgContext: { tenantId: data.orgId },
        data: full,
      });
    }

    it('links the waiting extension to the person who accepted', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await extension(tenantId, '201');
      const userId = crypto.randomUUID();

      await accepted({ orgId: tenantId, userId, extensionId: ext.id });
      const pass = await runUntilHandled(consumer);

      expect(pass.failed).toBe(0);
      expect((await h.extensions.findById({ tenantId }, ext.id))?.userId).toBe(userId);
    });

    it('leaves an extension that someone else has meanwhile', async () => {
      const tenantId = crypto.randomUUID();
      const someoneElse = crypto.randomUUID();
      const ext = await extension(tenantId, '202', someoneElse);

      await accepted({ orgId: tenantId, userId: crypto.randomUUID(), extensionId: ext.id });
      const pass = await runUntilHandled(consumer);

      expect(pass.failed).toBe(0);
      expect((await h.extensions.findById({ tenantId }, ext.id))?.userId).toBe(someoneElse);
    });

    it('does nothing for an invitation that named no extension', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await extension(tenantId, '203');

      await accepted({ orgId: tenantId, userId: crypto.randomUUID(), extensionId: null });
      await runUntilHandled(consumer);

      expect((await h.extensions.findById({ tenantId }, ext.id))?.userId).toBeNull();
    });
  },
);

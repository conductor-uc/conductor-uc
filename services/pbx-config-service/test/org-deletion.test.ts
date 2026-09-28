import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { purgeTenant } from '../src/org-deletion.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)(
  "removing a deleted tenant's PBX configuration (S1-16)",
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness();
    });

    afterAll(async () => {
      await h?.close();
    });

    /** An extension (with its credentials), an agent in a queue: rows across several tables. */
    async function populate(tenantId: string) {
      h.domains.realms[tenantId] = `${tenantId}.platform.test`;
      const location = await h.emergencyLocations.create(
        { tenantId },
        {
          label: 'HQ',
          addressLine1: '1 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        },
      );
      const extension = await h.extensions.create(
        { tenantId },
        { number: '301', displayName: 'Agent', emergencyLocationId: location.id },
      );
      const agent = await h.agents.create({ tenantId }, { extensionId: extension.id });
      const queue = await h.queues.create(
        { tenantId },
        { label: 'Support', strategy: 'ring-all', maxWaitSeconds: 0, announcePosition: false },
      );
      await h.queueTiers.add({ tenantId }, { queueId: queue.id, agentId: agent.id });
    }

    async function rows(tenantId: string): Promise<number> {
      let total = 0;
      for (const table of [
        'extensions',
        'sip_credentials',
        'emergency_locations',
        'agents',
        'queues',
        'queue_tiers',
      ] as const) {
        total += (
          await h.db.kysely
            .selectFrom(table)
            .select('tenant_id')
            .where('tenant_id', '=', tenantId)
            .execute()
        ).length;
      }
      return total;
    }

    it("removes every row of that tenant, and nobody else's", async () => {
      const gone = crypto.randomUUID();
      const kept = crypto.randomUUID();
      await populate(gone);
      await populate(kept);
      const before = await rows(kept);
      expect(await rows(gone)).toBeGreaterThanOrEqual(6);

      await h.db.kysely.transaction().execute((trx) => purgeTenant(trx, gone));

      expect(await rows(gone)).toBe(0);
      expect(await rows(kept)).toBe(before);
      // Again: nothing left, no error.
      await h.db.kysely.transaction().execute((trx) => purgeTenant(trx, gone));
    });
  },
);

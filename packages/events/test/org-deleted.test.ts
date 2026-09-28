import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { defineEvents } from '@cuc/api-contracts';
import { databaseOrSkipReason, natsOrSkipReason } from '@cuc/testing';

import { createOrgDeletedConsumer, ORG_DELETED_EVENTS } from '../src/org-deleted.js';
import type { TestDb } from './fixtures/schema.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());
const registry = defineEvents({ ...ORG_DELETED_EVENTS });

describe.skipIf(skipReason !== undefined)('the org deletion consumer (S1-16)', () => {
  let harness: Harness;

  beforeAll(async () => {
    harness = await startHarness();
  });

  afterAll(async () => {
    await harness?.close();
  });

  async function publish(type: 'org.tenant.deleted' | 'org.reseller.deleted', orgId: string) {
    await harness.bus.publish({
      id: randomUUID(),
      type,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: { orgId },
    });
  }

  it("calls the service's tenant and reseller removals in the event's transaction, once each", async () => {
    const tenants: string[] = [];
    const resellers: string[] = [];
    const consumer = createOrgDeletedConsumer<TestDb>({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      registry,
      durable: `org-deleted-${randomUUID().slice(0, 8)}`,
      tenant: async (trx, tenantId) => {
        tenants.push(tenantId);
        await trx.deleteFrom('extensions').where('tenant_id', '=', tenantId).execute();
      },
      reseller: (_trx, resellerId) => {
        resellers.push(resellerId);
        return Promise.resolve();
      },
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    const tenantId = randomUUID();
    await harness.db.kysely
      .insertInto('extensions')
      .values([
        { id: randomUUID(), tenant_id: tenantId, number: '101' },
        { id: randomUUID(), tenant_id: 'kept', number: '102' },
      ])
      .execute();

    const resellerId = randomUUID();
    await publish('org.tenant.deleted', tenantId);
    await publish('org.reseller.deleted', resellerId);
    // The stream is shared with other suites (a new durable starts from its beginning), so this
    // looks for its own two orgs among whatever else is there.
    for (
      let i = 0;
      i < 10 && !(tenants.includes(tenantId) && resellers.includes(resellerId));
      i++
    ) {
      await consumer.runOnce();
    }

    expect(tenants.filter((id) => id === tenantId)).toHaveLength(1);
    expect(resellers.filter((id) => id === resellerId)).toHaveLength(1);
    const left = await harness.db.kysely.selectFrom('extensions').select('tenant_id').execute();
    expect(left.map((r) => r.tenant_id)).not.toContain(tenantId);
    expect(left.map((r) => r.tenant_id)).toContain('kept');
  });

  it('subscribes only to what the service removes', async () => {
    const seen: string[] = [];
    const consumer = createOrgDeletedConsumer<TestDb>({
      db: harness.db.kysely,
      bus: harness.bus,
      logger: harness.logger,
      registry,
      durable: `org-deleted-${randomUUID().slice(0, 8)}`,
      tenant: (_trx, tenantId) => {
        seen.push(tenantId);
        return Promise.resolve();
      },
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    const resellerId = randomUUID();
    await publish('org.reseller.deleted', resellerId);
    for (let i = 0; i < 3; i++) await consumer.runOnce();
    expect(seen).not.toContain(resellerId);
  });
});

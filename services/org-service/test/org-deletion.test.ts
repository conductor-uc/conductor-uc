import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, type Bus } from '@cuc/events';
import type { Storage } from '@cuc/storage';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  silentLogger,
  startTestDatabase,
  startTestNats,
} from '@cuc/testing';

import { migrations } from '../migrations/index.js';
import { createOrgDeletionConsumer } from '../src/org-deletion.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

describe.skipIf(skipReason !== undefined)("removing a deleted org's data here (S1-16)", () => {
  let db: Database<OrgServiceDb>;
  let bus: Bus;
  let repo: OrgRepo;
  let stop: () => Promise<void>;
  const purged: string[] = [];
  const brandPrefixes: string[] = [];
  const storage = {
    purgeTenant: (tenantId: string) => {
      purged.push(tenantId);
      return Promise.resolve(3);
    },
    forPlatform: () => ({
      deleteUnder: (prefix: string) => {
        brandPrefixes.push(prefix);
        return Promise.resolve(1);
      },
    }),
  } as unknown as Storage;

  beforeAll(async () => {
    const logger = silentLogger();
    const dbHandle = await startTestDatabase();
    const natsHandle = await startTestNats();
    db = createDatabase<OrgServiceDb>({ ...dbHandle, logger });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    bus = await connectBus({ servers: [natsHandle.server], logger, name: 'org-service-test' });
    await bus.ensureStreams();
    repo = createOrgRepo(db, { platformBaseDomain: 'platform.test' });
    stop = async () => {
      await bus.close();
      await natsHandle.stop();
      await db.destroy();
      await dbHandle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  async function publish(type: 'org.tenant.deleted' | 'org.reseller.deleted', orgId: string) {
    await bus.publish({
      id: randomUUID(),
      type,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data: { orgId },
    });
  }

  it("purges a tenant's stored objects and domains, and a reseller's brand files", async () => {
    const master =
      (await repo.findMaster()) ?? (await repo.createMaster({ slug: 'master', name: 'M' }));
    const suffix = randomUUID().slice(0, 6);
    const reseller = await repo.create({}, 'reseller', {
      parentId: master.id,
      slug: `r-${suffix}`,
      name: 'R',
    });
    const tenant = await repo.create({}, 'tenant', {
      parentId: reseller.id,
      slug: `t-${suffix}`,
      name: 'T',
    });
    const domains = () =>
      db.kysely
        .selectFrom('tenant_domains')
        .select('id')
        .where('tenant_id', '=', tenant.id)
        .execute();
    expect(await domains()).toHaveLength(1);

    const consumer = createOrgDeletionConsumer(db, bus, silentLogger(), storage, {
      pullTimeoutMs: 1000,
    });
    await consumer.ensure();
    await publish('org.tenant.deleted', tenant.id);
    await publish('org.reseller.deleted', reseller.id);
    for (let i = 0; i < 10 && !(purged.includes(tenant.id) && brandPrefixes.length > 0); i++) {
      await consumer.runOnce();
    }

    expect(purged).toContain(tenant.id);
    expect(await domains()).toHaveLength(0);
    expect(brandPrefixes).toContain(`brand/${reseller.id}/`);
    // The org rows themselves stay, as tombstones.
    expect(await repo.findById(tenant.id)).toBeDefined();
  });
});

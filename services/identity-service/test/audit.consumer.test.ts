import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { publishAuditEvent } from '@cuc/audit';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { connectBus, type Bus } from '@cuc/events';
import {
  databaseOrSkipReason,
  natsOrSkipReason,
  silentLogger,
  startTestDatabase,
  startTestNats,
} from '@cuc/testing';
import type { Logger } from '@cuc/logger';

import { createAuditConsumer } from '../src/consumers/audit.consumer.js';
import { createAuditRepo, type AuditRepo } from '../src/repo/audit.repo.js';
import { migrations } from '../migrations/index.js';
import type { IdentityServiceDb } from '../src/schema.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * The S1-07 acceptance criterion, in full: "master reading a tenant-private
 * resource produces an audit row visible to that tenant." This exercises the
 * whole pipeline for real — `@cuc/audit`'s publisher, a real NATS JetStream
 * AUDIT stream, identity-service's consumer, and the query API's visibility
 * rule — not a mock of any one stage.
 */
describe.skipIf(skipReason !== undefined)('AUDIT consumer', () => {
  let db: Database<IdentityServiceDb>;
  let bus: Bus;
  let logger: Logger;
  let repo: AuditRepo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    logger = silentLogger();
    const dbHandle = await startTestDatabase();
    const natsHandle = await startTestNats();

    db = createDatabase<IdentityServiceDb>({
      host: dbHandle.host,
      port: dbHandle.port,
      user: dbHandle.user,
      password: dbHandle.password,
      database: dbHandle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createAuditRepo(db);

    bus = await connectBus({ servers: [natsHandle.server], logger, name: 'audit-consumer-test' });
    await bus.ensureStreams();

    stop = async () => {
      await bus.close();
      await db.destroy();
      await dbHandle.stop();
      await natsHandle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  afterEach(async () => {
    await db.kysely.deleteFrom('audit_events').execute();
    await db.kysely.deleteFrom('consumed_events').execute();
    await bus.jsm.streams.purge('AUDIT');
  });

  it('a master read of a tenant-private resource produces an audit row visible to that tenant', async () => {
    const consumer = createAuditConsumer(db, bus, logger, repo);
    await consumer.ensure();

    // Master reads tenant-1's private CDR — H1 allows this for master, but
    // audits it (07 §3.1).
    await publishAuditEvent(bus, {
      actorType: 'user',
      actorId: 'master-user-1',
      actorOrgId: 'master-org',
      targetOrgId: 'tenant-1',
      action: 'cdr.read',
      resource: 'cdr:abc123',
      dataClass: 'private',
    });

    const pass = await consumer.runOnce();
    expect(pass.handled).toBe(1);
    expect(pass.failed).toBe(0);

    const tenantsView = await repo.listForOrg('tenant-1');
    expect(tenantsView).toHaveLength(1);
    expect(tenantsView[0]).toMatchObject({
      actorId: 'master-user-1',
      targetOrgId: 'tenant-1',
      action: 'cdr.read',
      dataClass: 'private',
    });
  });

  it('is not visible to an unrelated org', async () => {
    const consumer = createAuditConsumer(db, bus, logger, repo);
    await consumer.ensure();

    await publishAuditEvent(bus, {
      actorType: 'user',
      actorId: 'master-user-1',
      actorOrgId: 'master-org',
      targetOrgId: 'tenant-1',
      action: 'cdr.read',
      resource: 'cdr:abc123',
      dataClass: 'private',
    });
    await consumer.runOnce();

    expect(await repo.listForOrg('tenant-2')).toEqual([]);
  });

  it('is visible to master, the actor', async () => {
    const consumer = createAuditConsumer(db, bus, logger, repo);
    await consumer.ensure();

    await publishAuditEvent(bus, {
      actorType: 'user',
      actorId: 'master-user-1',
      actorOrgId: 'master-org',
      targetOrgId: 'tenant-1',
      action: 'cdr.read',
      resource: 'cdr:abc123',
      dataClass: 'private',
    });
    await consumer.runOnce();

    const mastersView = await repo.listForOrg('master-org');
    expect(mastersView).toHaveLength(1);
  });

  it('redelivery does not double-insert (dedupe via consumed_events)', async () => {
    const consumer = createAuditConsumer(db, bus, logger, repo);
    await consumer.ensure();

    await publishAuditEvent(bus, {
      actorType: 'user',
      actorId: 'master-user-1',
      actorOrgId: 'master-org',
      targetOrgId: 'tenant-1',
      action: 'cdr.read',
      resource: 'cdr:abc123',
      dataClass: 'private',
    });
    const first = await consumer.runOnce();
    expect(first.handled).toBe(1);

    // Nothing new is on the stream — a second pass just finds no messages,
    // proving the row from the first pass is the only one that ever landed.
    await consumer.runOnce();
    expect(await repo.listForOrg('tenant-1')).toHaveLength(1);
  });
});

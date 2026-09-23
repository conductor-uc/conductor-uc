import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import type { Bus } from '@cuc/events';
import { connectBus } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import { createStorage, type Storage } from '@cuc/storage';
import {
  silentLogger,
  startTestDatabase,
  startTestNats,
  startTestS3,
  type TestNatsHandle,
  type TestS3Handle,
} from '@cuc/testing';

import { createCdrRepo, type CdrRepo } from '../src/repo/cdr.repo.js';
import { createExportRepo, type ExportRepo } from '../src/repo/export.repo.js';
import type { TenantResellerLookup } from '../src/org-client.js';
import type { CdrServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

/** A reseller-for-tenant lookup whose answers are set per test — no live org-service needed. */
export interface FakeOrgClient {
  readonly resellerForTenant: TenantResellerLookup;
  resellers: Record<string, string>;
}

function fakeOrgClient(): FakeOrgClient {
  const state: FakeOrgClient = {
    resellers: {},
    resellerForTenant: (tenantId: string) => Promise.resolve(state.resellers[tenantId]),
  };
  return state;
}

export interface Harness {
  readonly db: Database<CdrServiceDb>;
  readonly cdrs: CdrRepo;
  readonly exports: ExportRepo;
  readonly storage: Storage;
  readonly orgClient: FakeOrgClient;
  readonly logger: Logger;
  close(): Promise<void>;
}

/** A migrated schema, repos, and a real MinIO-backed storage — no NATS. For repo/route tests. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();
  const s3Handle: TestS3Handle = await startTestS3();

  const db = createDatabase<CdrServiceDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const storage = createStorage({
    mode: 'prefix-per-tenant',
    bucketPrefix: 'cuc-cdr-test',
    endpoint: s3Handle.endpoint,
    region: s3Handle.region,
    accessKeyId: s3Handle.accessKeyId,
    secretAccessKey: s3Handle.secretAccessKey,
    forcePathStyle: s3Handle.forcePathStyle,
    logger,
  });

  const cdrs = createCdrRepo(db);
  const exports = createExportRepo(db);
  const orgClient = fakeOrgClient();

  return {
    db,
    cdrs,
    exports,
    storage,
    orgClient,
    logger,
    async close() {
      await db.destroy();
      await handle.stop();
      await s3Handle.stop();
    },
  };
}

export interface BusHarness extends Harness {
  readonly bus: Bus;
}

/** {@link startHarness} plus a real JetStream connection, for consumer tests. */
export async function startBusHarness(): Promise<BusHarness> {
  const base = await startHarness();
  const natsHandle: TestNatsHandle = await startTestNats();
  const bus = await connectBus({
    servers: [natsHandle.server],
    logger: base.logger,
    name: 'cdr-service-test',
  });
  await bus.ensureStreams();

  return {
    ...base,
    bus,
    async close() {
      await bus.close();
      await natsHandle.stop();
      await base.close();
    },
  };
}

export async function resetSchema(db: Database<CdrServiceDb>): Promise<void> {
  await db.kysely.deleteFrom('cdrs').execute();
  await db.kysely.deleteFrom('cdr_exports').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

import { randomBytes } from 'node:crypto';

import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { fileKekFromConfig, type KekProvider } from '@cuc/crypto';
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

import { createDidRepo, type DidRepo } from '../src/repo/did.repo.js';
import {
  createEmergencyLocationRepo,
  type EmergencyLocationRepo,
} from '../src/repo/emergency-location.repo.js';
import { createExtensionRepo, type ExtensionRepo } from '../src/repo/extension.repo.js';
import { createMediaAssetRepo, type MediaAssetRepo } from '../src/repo/media-asset.repo.js';
import type { TenantDomainLookup } from '../src/org-client.js';
import type { PbxConfigServiceDb } from '../src/schema.js';
import type { TrunkLookup } from '../src/trunk-client.js';
import { migrations } from '../migrations/index.js';

export interface Harness {
  readonly db: Database<PbxConfigServiceDb>;
  readonly kek: KekProvider;
  readonly extensions: ExtensionRepo;
  readonly dids: DidRepo;
  readonly emergencyLocations: EmergencyLocationRepo;
  readonly storage: Storage;
  readonly mediaAssets: MediaAssetRepo;
  readonly domains: FakeTenantDomains;
  readonly trunks: FakeTrunkLookup;
  readonly logger: Logger;
  close(): Promise<void>;
}

export interface FakeTenantDomains {
  readonly lookup: TenantDomainLookup;
  realms: Record<string, string>;
}

/** A trunk-existence lookup whose answers are set per test — no live trunk-service needed. */
export interface FakeTrunkLookup {
  readonly exists: TrunkLookup;
  /** `${tenantId}:${trunkId}` keys considered to exist. Empty means "nothing exists" by default. */
  known: Set<string>;
}

const TEST_KEK = randomBytes(32).toString('base64');

/** A domain lookup whose answers are set per test — no live org-service needed. */
function fakeTenantDomains(): FakeTenantDomains {
  const state: FakeTenantDomains = {
    realms: {},
    lookup: (tenantId: string) => Promise.resolve(state.realms[tenantId]),
  };
  return state;
}

function fakeTrunkLookup(): FakeTrunkLookup {
  const state: FakeTrunkLookup = {
    known: new Set(),
    exists: (tenantId: string, trunkId: string) =>
      Promise.resolve(state.known.has(`${tenantId}:${trunkId}`)),
  };
  return state;
}

/** A migrated schema, KEK, extension/DID/media-asset repos (a real MinIO backs storage), and no NATS. For repo/route tests. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();
  const s3Handle: TestS3Handle = await startTestS3();

  const db = createDatabase<PbxConfigServiceDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const kek = fileKekFromConfig({ CRYPTO_KEKS: `1:${TEST_KEK}`, CRYPTO_KEK_CURRENT: '1' });
  const domains = fakeTenantDomains();
  const extensions = createExtensionRepo(db, domains.lookup, kek);
  const trunks = fakeTrunkLookup();
  const dids = createDidRepo(db, trunks.exists);
  const emergencyLocations = createEmergencyLocationRepo(db);
  const storage = createStorage({
    mode: 'prefix-per-tenant',
    bucketPrefix: 'cuc-pbx-test',
    endpoint: s3Handle.endpoint,
    region: s3Handle.region,
    accessKeyId: s3Handle.accessKeyId,
    secretAccessKey: s3Handle.secretAccessKey,
    forcePathStyle: s3Handle.forcePathStyle,
    logger,
  });
  const mediaAssets = createMediaAssetRepo(db, storage);

  return {
    db,
    kek,
    extensions,
    dids,
    emergencyLocations,
    storage,
    mediaAssets,
    domains,
    trunks,
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
    name: 'pbx-config-service-test',
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

export async function resetSchema(db: Database<PbxConfigServiceDb>): Promise<void> {
  await db.kysely.deleteFrom('dids').execute();
  await db.kysely.deleteFrom('sip_credentials').execute();
  await db.kysely.deleteFrom('extensions').execute();
  await db.kysely.deleteFrom('emergency_locations').execute();
  await db.kysely.deleteFrom('media_assets').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

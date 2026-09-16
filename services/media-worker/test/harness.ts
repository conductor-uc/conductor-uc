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

import type {
  CompleteMediaAssetInput,
  MediaAssetForTranscode,
  PbxConfigClient,
} from '../src/pbx-config-client.js';
import type { MediaWorkerDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

export interface FakePbxConfigClient extends PbxConfigClient {
  assets: Record<string, MediaAssetForTranscode>;
  completed: { tenantId: string; id: string; input: CompleteMediaAssetInput }[];
  failed: { tenantId: string; id: string; errorMessage: string }[];
}

/** A media-asset lookup/complete/fail whose answers are set (and calls recorded) per test — no live pbx-config-service needed. */
function fakePbxConfigClient(): FakePbxConfigClient {
  const state: FakePbxConfigClient = {
    assets: {},
    completed: [],
    failed: [],
    findMediaAsset: (_tenantId, id) => Promise.resolve(state.assets[id]),
    completeMediaAsset: (tenantId, id, input) => {
      state.completed.push({ tenantId, id, input });
      return Promise.resolve();
    },
    failMediaAsset: (tenantId, id, errorMessage) => {
      state.failed.push({ tenantId, id, errorMessage });
      return Promise.resolve();
    },
  };
  return state;
}

export interface Harness {
  readonly db: Database<MediaWorkerDb>;
  readonly storage: Storage;
  readonly pbxConfig: FakePbxConfigClient;
  readonly logger: Logger;
  close(): Promise<void>;
}

/** A migrated schema and a real MinIO-backed storage — no NATS. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();
  const s3Handle: TestS3Handle = await startTestS3();

  const db = createDatabase<MediaWorkerDb>({
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
    bucketPrefix: 'cuc-media-worker-test',
    endpoint: s3Handle.endpoint,
    region: s3Handle.region,
    accessKeyId: s3Handle.accessKeyId,
    secretAccessKey: s3Handle.secretAccessKey,
    forcePathStyle: s3Handle.forcePathStyle,
    logger,
  });

  const pbxConfig = fakePbxConfigClient();

  return {
    db,
    storage,
    pbxConfig,
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
    name: 'media-worker-test',
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

export async function resetSchema(db: Database<MediaWorkerDb>): Promise<void> {
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

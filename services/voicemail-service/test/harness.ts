import { randomBytes } from 'node:crypto';

import { fileKekFromConfig, type KekProvider } from '@cuc/crypto';
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

import { createMailboxRepo, type MailboxRepo } from '../src/repo/mailbox.repo.js';
import { createMessageRepo, type MessageRepo } from '../src/repo/message.repo.js';
import type { VoicemailServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

export interface Harness {
  readonly db: Database<VoicemailServiceDb>;
  readonly kek: KekProvider;
  readonly storage: Storage;
  readonly mailboxes: MailboxRepo;
  readonly messages: MessageRepo;
  readonly logger: Logger;
  close(): Promise<void>;
}

const TEST_KEK = randomBytes(32).toString('base64');

/** A migrated schema, KEK, mailbox/message repos (a real MinIO backs storage), and no NATS. For repo/route tests. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();
  const s3Handle: TestS3Handle = await startTestS3();

  const db = createDatabase<VoicemailServiceDb>({
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
  const storage = createStorage({
    mode: 'prefix-per-tenant',
    bucketPrefix: 'cuc-voicemail-test',
    endpoint: s3Handle.endpoint,
    region: s3Handle.region,
    accessKeyId: s3Handle.accessKeyId,
    secretAccessKey: s3Handle.secretAccessKey,
    forcePathStyle: s3Handle.forcePathStyle,
    logger,
  });
  const mailboxes = createMailboxRepo(db, storage, kek);
  const messages = createMessageRepo(db, storage);

  return {
    db,
    kek,
    storage,
    mailboxes,
    messages,
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

export async function startBusHarness(): Promise<BusHarness> {
  const base = await startHarness();
  const natsHandle: TestNatsHandle = await startTestNats();
  const bus = await connectBus({
    servers: [natsHandle.server],
    logger: base.logger,
    name: 'voicemail-service-test',
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

export async function resetSchema(db: Database<VoicemailServiceDb>): Promise<void> {
  await db.kysely.deleteFrom('messages').execute();
  await db.kysely.deleteFrom('mailboxes').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

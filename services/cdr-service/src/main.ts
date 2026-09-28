import { redactConfig } from '@cuc/config';
import {
  createDatabase,
  createPartitionJob,
  migrateToLatest,
  PARTITION_INTERVAL_MS,
} from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createRemotePermissionResolver, createServer, observeOutbox } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { configSchema, loadServiceConfig } from './config.js';
import { createCallLostConsumer } from './consumers/call-lost.consumer.js';
import { createExportConsumer } from './consumers/export.consumer.js';
import { createOrgClient } from './org-client.js';
import { createCdrRepo } from './repo/cdr.repo.js';
import { createExportRepo } from './repo/export.repo.js';
import { registerBillingRoutes } from './routes/billing.routes.js';
import { createPbxClient } from './pbx-client.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerCdrRoutes } from './routes/cdr.routes.js';
import { registerIngestRoutes } from './routes/ingest.routes.js';
import type { CdrServiceDb } from './schema.js';
import { createOrgDeletionConsumer } from './org-deletion.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<CdrServiceDb>({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  poolSize: config.DB_POOL_SIZE,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  logger,
});

await migrateToLatest({
  db: db.kysely,
  dir: new URL('../migrations', import.meta.url).pathname,
  logger,
});

const bus = await connectBus({
  servers: config.NATS_SERVERS,
  logger,
  name: config.SERVICE_NAME,
  streamMaxAgeDays: config.NATS_STREAM_MAX_AGE_DAYS,
  ...(config.NATS_USER === undefined ? {} : { user: config.NATS_USER }),
  ...(config.NATS_PASSWORD === undefined ? {} : { password: config.NATS_PASSWORD }),
});
await bus.ensureStreams();

const relay = createRelay({
  db: db.kysely,
  bus,
  logger,
  batchSize: config.OUTBOX_BATCH_SIZE,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
  retentionDays: config.OUTBOX_RETENTION_DAYS,
});
const relayLoop = relay.run();

// S1-16 (G-11): a deleted org's rows go when org-service says so.
const orgDeletion = createOrgDeletionConsumer(db, bus, logger);
await orgDeletion.ensure();
const orgDeletionLoop = orgDeletion.run();

const storage = storageFromConfig(config, logger);
const orgClient = createOrgClient({
  baseUrl: config.ORG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const cdrRepo = createCdrRepo(db);
const exportRepo = createExportRepo(db);

const exportConsumer = createExportConsumer(db, bus, logger, storage, cdrRepo, exportRepo);
await exportConsumer.ensure();
const exportConsumerLoop = exportConsumer.run();

// S4-04: a leg lost with its media node becomes a `node_failure` call record.
const callLostConsumer = createCallLostConsumer(
  db,
  bus,
  logger,
  cdrRepo,
  orgClient.resellerForTenant,
);
await callLostConsumer.ensure();
const callLostLoop = callLostConsumer.run();

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
  context: {
    trustInternalHeaders: config.TRUST_INTERNAL_HEADERS,
    ...(config.INTERNAL_HEADER_SIGNING_SECRET === undefined
      ? {}
      : { internalHeaderSigningSecret: config.INTERNAL_HEADER_SIGNING_SECRET }),
    // Other services and tools calling a protected route directly (G-112).
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  },
  permissions: createRemotePermissionResolver({
    baseUrl: config.IDENTITY_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
});

// S4-12/S4-13: the outbox backlog, for the operations console (`/statusz`, `/metrics`).
observeOutbox(app, relay);
app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('outbox', async () => {
  const lag = await relay.lag();
  return { status: 'pass', detail: `${String(lag)} pending` };
});

registerIngestRoutes(app, cdrRepo, orgClient.resellerForTenant, config.FS_CDR_INGEST_TOKEN);
registerCdrRoutes(app, cdrRepo, exportRepo, storage);
registerBillingRoutes(app, cdrRepo);
const pbxClient = createPbxClient({
  baseUrl: config.PBX_CONFIG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
registerMeRoutes(app, cdrRepo, pbxClient.userExtension);

// S2-21 (G-52): months ahead added to `cdrs`, months past CDR_RETENTION_MONTHS dropped.
const partitions = createPartitionJob({
  db: db.unscoped({}, 'Partition maintenance: call records past retention (S2-21, G-52)'),
  targets: [{ table: 'cdrs', retentionMonths: config.CDR_RETENTION_MONTHS }],
  logger,
});
partitions.start(PARTITION_INTERVAL_MS);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

/**
 * SIGTERM drains in-flight HTTP requests, stops taking new outbox and
 * consumer work, and closes the bus connection — in that order, so nothing
 * is torn down while it might still be needed.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  relay.stop();
  exportConsumer.stop();
  callLostConsumer.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  orgDeletion.stop();
  await relayLoop;
  await orgDeletionLoop;
  await exportConsumerLoop;
  await callLostLoop;
  await bus.close();
  await partitions.stop();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

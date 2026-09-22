import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';
import { Redis } from 'ioredis';

import { configSchema, loadServiceConfig } from './config.js';
import { createOrgConsumer } from './consumers/org.consumer.js';
import { createPbxConsumer } from './consumers/pbx.consumer.js';
import { createTrunkConsumer } from './consumers/trunk.consumer.js';
import { createOpenSipsMiClient } from './opensips-mi-client.js';
import type { OpenSipsDb } from './opensips-schema.js';
import { createOrgClient } from './org-client.js';
import { createPbxConfigClient } from './pbx-config-client.js';
import { createProjection } from './projection.js';
import { createOpenSipsProjectionRepo } from './repo/opensips-projection.repo.js';
import { createReadModelRepo } from './repo/read-model.repo.js';
import { createReconciler } from './reconcile.js';
import { registerFsRoutes } from './routes/fs.routes.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import type { TelephonyConfigDb } from './schema.js';
import { createTrunkConfigClient } from './trunk-config-client.js';
import { createVoicemailClient } from './voicemail-client.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<TelephonyConfigDb>({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  poolSize: config.DB_POOL_SIZE,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  logger,
});

// Migrations run at startup, same as every other service (Kysely holds a
// lock, so several instances starting at once is safe). Only for this
// service's own schema — the `opensips` schema below is provisioned by
// S1-11's compose init flow, not by a migration this service owns.
await migrateToLatest({
  db: db.kysely,
  dir: new URL('../migrations', import.meta.url).pathname,
  logger,
});

// A second, separate connection pool: 05 §1.1's "only telephony-config
// writes to that schema", with its own DB user and grants (S1-11's
// `mariadb/init/01-schemas.sh`). Never the same pool as `db` — no
// cross-schema transaction is possible across them (`projection.ts`).
const opensipsDb = createDatabase<OpenSipsDb>({
  host: config.OPENSIPS_DB_HOST,
  port: config.OPENSIPS_DB_PORT,
  user: config.OPENSIPS_DB_USER,
  password: config.OPENSIPS_DB_PASSWORD,
  database: config.OPENSIPS_DB_NAME,
  poolSize: config.OPENSIPS_DB_POOL_SIZE,
  logger,
});

const bus = await connectBus({
  servers: config.NATS_SERVERS,
  logger,
  name: config.SERVICE_NAME,
  ...(config.NATS_USER === undefined ? {} : { user: config.NATS_USER }),
  ...(config.NATS_PASSWORD === undefined ? {} : { password: config.NATS_PASSWORD }),
});
await bus.ensureStreams();

// S2-06: this service's first outbound publish (`call.emergency.initiated`)
// — every consumer above already existed; this is the first thing that
// needs the outbox *relayed*, not just written to.
const relay = createRelay({
  db: db.kysely,
  bus,
  logger,
  batchSize: config.OUTBOX_BATCH_SIZE,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
});
const relayLoop = relay.run();

const pbxConfigClient = createPbxConfigClient({
  baseUrl: config.PBX_CONFIG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const trunkConfigClient = createTrunkConfigClient({
  baseUrl: config.TRUNK_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const orgClient = createOrgClient({
  baseUrl: config.ORG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const miClient = createOpenSipsMiClient({ url: config.OPENSIPS_MI_URL });
const storage = storageFromConfig(config, logger);
const voicemailClient = createVoicemailClient({
  baseUrl: config.VOICEMAIL_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
// S2-08: the round-robin ring-group counter (`ring-group-counter.ts`) —
// same `lazyConnect: false`/`maxRetriesPerRequest` shape api-gateway's own
// rate-limiter client uses, so this fails fast at startup rather than
// retrying forever silently.
const redisClient = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });

const readModel = createReadModelRepo(db);
const opensipsProjection = createOpenSipsProjectionRepo(opensipsDb);
const projection = createProjection(
  readModel,
  opensipsProjection,
  miClient,
  pbxConfigClient,
  logger,
  trunkConfigClient,
  config.OPENSIPS_SIP_URI,
);

const orgConsumer = createOrgConsumer(db, bus, logger, readModel, projection, orgClient);
await orgConsumer.ensure();
const orgConsumerLoop = orgConsumer.run();

const pbxConsumer = createPbxConsumer(db, bus, logger, projection);
await pbxConsumer.ensure();
const pbxConsumerLoop = pbxConsumer.run();

const trunkConsumer = createTrunkConsumer(db, bus, logger, projection);
await trunkConsumer.ensure();
const trunkConsumerLoop = trunkConsumer.run();

const reconciler = createReconciler(
  readModel,
  opensipsProjection,
  miClient,
  logger,
  config.OPENSIPS_SIP_URI,
);
reconciler.start(config.RECONCILE_INTERVAL_MS);

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('opensips_db', async () => ({
  status: (await opensipsDb.ping()) ? 'pass' : 'fail',
}));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('redis', async () => ({
  status: (await redisClient.ping()) === 'PONG' ? 'pass' : 'fail',
}));
app.addReadinessCheck('outbox', async () => {
  const lag = await relay.lag();
  return { status: 'pass', detail: `${String(lag)} pending` };
});

registerFsRoutes(
  app,
  db,
  readModel,
  config.FS_XML_CURL_TOKEN,
  config.OPENSIPS_SIP_URI,
  logger,
  orgClient,
  pbxConfigClient,
  storage,
  voicemailClient,
  redisClient,
);
registerInternalRoutes(
  app,
  readModel,
  miClient,
  config.OPENSIPS_SIP_URI,
  config.INTERNAL_SERVICE_TOKEN,
  logger,
);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

/**
 * SIGTERM stops taking new consumer/reconciliation work, drains in-flight
 * HTTP requests, then closes the bus and both database connections — in
 * that order, so nothing is torn down while it might still be needed.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  reconciler.stop();
  orgConsumer.stop();
  pbxConsumer.stop();
  trunkConsumer.stop();
  relay.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await orgConsumerLoop;
  await pbxConsumerLoop;
  await trunkConsumerLoop;
  await relayLoop;
  await bus.close();
  await db.destroy();
  await opensipsDb.destroy();
  redisClient.disconnect();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

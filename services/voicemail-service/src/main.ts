import { redactConfig } from '@cuc/config';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createRemotePermissionResolver, createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { configSchema, loadServiceConfig } from './config.js';
import { createMailboxRepo } from './repo/mailbox.repo.js';
import { createMessageRepo } from './repo/message.repo.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { createPbxClient } from './pbx-client.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerMailboxRoutes } from './routes/mailbox.routes.js';
import type { VoicemailServiceDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<VoicemailServiceDb>({
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
});
const relayLoop = relay.run();

const kek = fileKekFromConfig(config);
const storage = storageFromConfig(config, logger);
const mailboxRepo = createMailboxRepo(db, storage, kek);
const messageRepo = createMessageRepo(db, storage);

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
  context: {
    trustInternalHeaders: config.TRUST_INTERNAL_HEADERS,
    ...(config.INTERNAL_HEADER_SIGNING_SECRET === undefined
      ? {}
      : { internalHeaderSigningSecret: config.INTERNAL_HEADER_SIGNING_SECRET }),
  },
  permissions: createRemotePermissionResolver({
    baseUrl: config.IDENTITY_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('outbox', async () => {
  const lag = await relay.lag();
  return { status: 'pass', detail: `${String(lag)} pending` };
});

registerMailboxRoutes(app, mailboxRepo, messageRepo, storage);
const pbxClient = createPbxClient({
  baseUrl: config.PBX_CONFIG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
registerMeRoutes(app, mailboxRepo, messageRepo, storage, pbxClient.userExtension, bus);
registerInternalRoutes(app, mailboxRepo, messageRepo, config.INTERNAL_SERVICE_TOKEN, storage);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  relay.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await relayLoop;
  await bus.close();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

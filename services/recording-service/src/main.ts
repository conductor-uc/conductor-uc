import { publishAuditEvent } from '@cuc/audit';
import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { createHttpAccessClient } from './access.js';
import { configSchema, loadServiceConfig } from './config.js';
import { createPolicyRepo } from './repo/policy.repo.js';
import { createRecordingRepo } from './repo/recording.repo.js';
import { createSettingsRepo } from './repo/settings.repo.js';
import { createRetentionJob } from './retention.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerPolicyRoutes } from './routes/policy.routes.js';
import { registerRecordingRoutes } from './routes/recording.routes.js';
import type { RecordingServiceDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<RecordingServiceDb>({
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

const storage = storageFromConfig(config, logger);
const policies = createPolicyRepo(db);
const recordings = createRecordingRepo(db);
const settings = createSettingsRepo(db, config.RECORDING_DEFAULT_RETENTION_DAYS);
const access = createHttpAccessClient({
  baseUrl: config.IDENTITY_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  ttlMs: config.ACCESS_CACHE_TTL_MS,
});

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
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('outbox', async () => {
  const lag = await relay.lag();
  return { status: 'pass', detail: `${String(lag)} pending` };
});

registerPolicyRoutes(app, { policies, settings, access, storage, logger });
registerRecordingRoutes(app, {
  recordings,
  access,
  storage,
  logger,
  audit: (input) => publishAuditEvent(bus, input),
});
registerInternalRoutes(app, {
  policies,
  recordings,
  settings,
  storage,
  logger,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});

const retention = createRetentionJob({
  recordings,
  storage,
  logger,
  now: () => new Date(),
  batchSize: config.RETENTION_SWEEP_BATCH,
  pendingMaxAgeHours: config.PENDING_RECORDING_MAX_AGE_HOURS,
});
retention.start(config.RETENTION_SWEEP_INTERVAL_MS);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  retention.stop();
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

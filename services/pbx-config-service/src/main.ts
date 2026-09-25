import { redactConfig } from '@cuc/config';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, REWRAP_INTERVAL_MS } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createRemotePermissionResolver, createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { configSchema, loadServiceConfig } from './config.js';
import { createKekRewrapJob } from './kek-rewrap.js';
import { createDomainConsumer } from './consumers/domain.consumer.js';
import { createOrgClient } from './org-client.js';
import { createDidRepo } from './repo/did.repo.js';
import { createEmergencyLocationRepo } from './repo/emergency-location.repo.js';
import { globalProvisioningCredential as globalProvisioningCredentialFrom } from './domain/provisioning.js';
import { createDeviceRepo } from './repo/device.repo.js';
import { createExtensionRepo } from './repo/extension.repo.js';
import { createMediaAssetRepo } from './repo/media-asset.repo.js';
import { createRingGroupRepo } from './repo/ring-group.repo.js';
import { createQueueRepo } from './repo/queue.repo.js';
import { createAgentRepo } from './repo/agent.repo.js';
import { createQueueTierRepo } from './repo/queue-tier.repo.js';
import { createParkingLotRepo } from './repo/parking-lot.repo.js';
import { createCallHandlingRepo } from './repo/call-handling.repo.js';
import { createScheduleRepo } from './repo/schedule.repo.js';
import { createConferenceRoomRepo } from './repo/conference-room.repo.js';
import { registerDidRoutes } from './routes/did.routes.js';
import { registerEmergencyLocationRoutes } from './routes/emergency-location.routes.js';
import { registerDeviceRoutes } from './routes/device.routes.js';
import { registerExtensionRoutes } from './routes/extension.routes.js';
import { registerProvisionRoutes } from './routes/provision.routes.js';
import { parseSipTransports, registerSipEndpointRoutes } from './routes/sip-endpoint.routes.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerCallHandlingInternalRoutes } from './routes/call-handling-internal.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { registerUserExtensionInternalRoutes } from './routes/user-extension-internal.routes.js';
import { registerCallHandlingRoutes } from './routes/call-handling.routes.js';
import { registerScheduleInternalRoutes } from './routes/schedule-internal.routes.js';
import { registerMediaAssetRoutes } from './routes/media-asset.routes.js';
import { registerRingGroupRoutes } from './routes/ring-group.routes.js';
import { registerQueueRoutes } from './routes/queue.routes.js';
import { registerAgentRoutes } from './routes/agent.routes.js';
import { registerParkingLotRoutes } from './routes/parking-lot.routes.js';
import { registerScheduleRoutes } from './routes/schedule.routes.js';
import { registerConferenceRoomRoutes } from './routes/conference-room.routes.js';
import type { PbxConfigServiceDb } from './schema.js';
import { createTrunkClient } from './trunk-client.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<PbxConfigServiceDb>({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  poolSize: config.DB_POOL_SIZE,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  logger,
});

// Migrations run at startup rather than as a separate deploy step, until this
// service has enough traffic that a migration wants its own maintenance
// window. Kysely holds a lock, so several instances starting at once is safe.
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
const orgClient = createOrgClient({
  baseUrl: config.ORG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const extensionRepo = createExtensionRepo(db, orgClient.primaryDomain, kek);
const deviceRepo = createDeviceRepo(db);
const trunkClient = createTrunkClient({
  baseUrl: config.TRUNK_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const didRepo = createDidRepo(db, trunkClient.exists);
const emergencyLocationRepo = createEmergencyLocationRepo(db);
const storage = storageFromConfig(config, logger);
const mediaAssetRepo = createMediaAssetRepo(db, storage);
const ringGroupRepo = createRingGroupRepo(db);
const queueRepo = createQueueRepo(db);
const agentRepo = createAgentRepo(db);
const queueTierRepo = createQueueTierRepo(db);
const parkingLotRepo = createParkingLotRepo(db);
const scheduleRepo = createScheduleRepo(db);
const callHandlingRepo = createCallHandlingRepo(db);
const conferenceRoomRepo = createConferenceRoomRepo(db, kek);

const domainConsumer = createDomainConsumer(db, bus, logger, extensionRepo);
await domainConsumer.ensure();
const domainConsumerLoop = domainConsumer.run();

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

registerExtensionRoutes(app, extensionRepo, bus);
registerCallHandlingRoutes(app, callHandlingRepo, bus);
registerMeRoutes(app, extensionRepo, callHandlingRepo, bus);
const sipEdge = {
  port: config.SIP_PUBLIC_PORT,
  tlsPort: config.SIP_PUBLIC_TLS_PORT,
  transports: parseSipTransports(config.SIP_PUBLIC_TRANSPORTS),
};
registerSipEndpointRoutes(app, orgClient.primaryDomain, sipEdge, orgClient.sipProxy);
registerDeviceRoutes(app, deviceRepo, bus, {
  ...(config.PROVISIONING_BASE_URL === undefined
    ? {}
    : { provisioningBaseUrl: config.PROVISIONING_BASE_URL }),
});
const globalProvisioningCredential = globalProvisioningCredentialFrom(
  config.PROVISIONING_USERNAME,
  config.PROVISIONING_PASSWORD,
);
registerProvisionRoutes(app, deviceRepo, extensionRepo, orgClient.primaryDomain, sipEdge, {
  ...(globalProvisioningCredential === undefined
    ? {}
    : { globalCredential: globalProvisioningCredential }),
  sipProxy: orgClient.sipProxy,
});
registerDidRoutes(app, didRepo);
registerEmergencyLocationRoutes(app, emergencyLocationRepo);
registerMediaAssetRoutes(app, mediaAssetRepo);
registerRingGroupRoutes(app, ringGroupRepo);
registerQueueRoutes(app, queueRepo, queueTierRepo);
registerAgentRoutes(app, agentRepo);
registerParkingLotRoutes(app, parkingLotRepo);
registerScheduleRoutes(app, scheduleRepo);
registerConferenceRoomRoutes(app, conferenceRoomRepo);
registerInternalRoutes(
  app,
  extensionRepo,
  didRepo,
  emergencyLocationRepo,
  mediaAssetRepo,
  ringGroupRepo,
  queueRepo,
  agentRepo,
  queueTierRepo,
  parkingLotRepo,
  conferenceRoomRepo,
  config.INTERNAL_SERVICE_TOKEN,
);
registerScheduleInternalRoutes(app, scheduleRepo, config.INTERNAL_SERVICE_TOKEN);
registerCallHandlingInternalRoutes(app, callHandlingRepo, config.INTERNAL_SERVICE_TOKEN);
registerUserExtensionInternalRoutes(app, extensionRepo, config.INTERNAL_SERVICE_TOKEN);

// G-116: values still under an older KEK version are moved to the current one
// in the background, and `/readyz` says how many remain, so an old version
// can be removed from CRYPTO_KEKS once every service reports 0.
const kekRewrap = createKekRewrapJob(db, kek, logger);
app.addReadinessCheck('kek_rewrap', kekRewrap.readinessCheck);
kekRewrap.start(REWRAP_INTERVAL_MS);

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
  domainConsumer.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await relayLoop;
  await domainConsumerLoop;
  await bus.close();
  await kekRewrap.stop();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

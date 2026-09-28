import { hostname } from 'node:os';
import { recordAuditEvent } from '@cuc/audit';
import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import {
  createHttpAccessClient,
  createRemotePermissionResolver,
  createServer,
  observeOutbox,
} from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { Redis } from 'ioredis';

import { createAffinityManager } from './affinity/manager.js';
import { createChannelHandler } from './channel-handler.js';
import {
  createExtensionScopeLookup,
  createParkingLotLookup,
  createPickupPeersLookup,
  createRecordingControlClient,
  createTenantByDomainLookup,
  createTenantDomainLookup,
  createUserExtensionLookup,
} from './clients.js';
import { createMonitorController } from './monitor-control.js';
import { createNodeDrain } from './node-drain.js';
import { registerNodeMetrics } from './node-metrics.js';
import { registerMonitorRoutes } from './routes/monitor.routes.js';
import { createCallOperations } from './call-operations.js';
import {
  registerCallOperationRoutes,
  registerPickupInternalRoutes,
} from './routes/call-operations.routes.js';
import { createQueueStatus } from './queue-status.js';
import {
  registerQueueStatusInternalRoutes,
  registerQueueStatusRoutes,
} from './routes/queue-status.routes.js';
import { createRecordingController } from './recording-control.js';
import { registerRecordingControlRoutes } from './routes/recording.routes.js';
import { configSchema, loadServiceConfig, parseFsNodes } from './config.js';
import { createEslClient, type EslClient } from './esl/client.js';
import { createCallRegistry } from './redis/registry.js';
import { createSerialQueue } from './serial.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerPlatformRoutes } from './routes/platform.routes.js';
import type { CallControlDb } from './schema.js';
import { createNodeFailureWatcher } from './node-failure.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<CallControlDb>({
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

const redis = new Redis(config.REDIS_URL, { lazyConnect: false, maxRetriesPerRequest: 2 });
const registry = createCallRegistry(redis, config.REDIS_KEY_PREFIX);

const channelHandler = createChannelHandler({
  db: db.kysely,
  registry,
  logger,
  callSafetyTtlMs: config.CALL_SAFETY_TTL_MS,
  heartbeatTtlMs: config.HEARTBEAT_TTL_MS,
  // G-119 (3): a queue agent's tenant, from the domain in its name.
  tenantByDomain: createTenantByDomainLookup({
    baseUrl: config.ORG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
});

// One ESL client per configured node (`FS_NODES`), each with its own
// reconnect loop and its own periodic self-heartbeat (04 §3.1: "from ESL
// HEARTBEAT plus its own ping" — FS's own HEARTBEAT event interval is not
// guaranteed to be shorter than the registry TTL, so this service also
// refreshes the key on a fixed timer of its own while the connection is up,
// independent of what FS sends).
const fsNodes = parseFsNodes(config.FS_NODES);
const heartbeatIntervals = new Map<string, ReturnType<typeof setInterval>>();
const eslClientsById = new Map<string, EslClient>();

const handleInOrder = createSerialQueue((nodeId, error) => {
  logger.error({ nodeId, err: error }, 'failed to handle ESL event');
});

const eslClients = fsNodes.map((node) =>
  createEslClient({
    node,
    password: config.FS_EVENT_SOCKET_PASSWORD,
    logger,
    reconnectMinDelayMs: config.ESL_RECONNECT_MIN_DELAY_MS,
    reconnectMaxDelayMs: config.ESL_RECONNECT_MAX_DELAY_MS,
    // One node's events in the order FreeSWITCH raised them (`serial.ts`).
    onEvent: (nodeId, raw) => {
      handleInOrder(nodeId, () => channelHandler.handleEvent(nodeId, raw));
    },
    onConnect: (nodeId) => {
      void registry.heartbeat(nodeId, config.HEARTBEAT_TTL_MS);
      const interval = setInterval(() => {
        void registry.heartbeat(nodeId, config.HEARTBEAT_TTL_MS);
      }, config.HEARTBEAT_INTERVAL_MS);
      heartbeatIntervals.set(nodeId, interval);
    },
    onDisconnect: (nodeId) => {
      const interval = heartbeatIntervals.get(nodeId);
      if (interval !== undefined) {
        clearInterval(interval);
        heartbeatIntervals.delete(nodeId);
      }
    },
  }),
);

fsNodes.forEach((node, index) => {
  const client = eslClients[index];
  if (client !== undefined) eslClientsById.set(node.id, client);
});

for (const client of eslClients) client.start();

// S2-12 (04 §3.3): acquire/renew/release for `aff:{tenantId}:{kind}:
// {resourceId}` — needs both the ESL clients above (to reload the chosen
// node after a fresh acquire) and the call registry (to pick the
// least-loaded live node and to know which nodes are live at all).
const affinity = createAffinityManager({
  redis,
  keyPrefix: config.REDIS_KEY_PREFIX,
  callRegistry: registry,
  eslClients: eslClientsById,
  logger,
  leaseTtlMs: config.AFFINITY_LEASE_TTL_MS,
  renewIntervalMs: config.AFFINITY_RENEW_INTERVAL_MS,
});

// S4-04 (04 §4): a media node whose heartbeat expired has its calls announced
// as lost and its leases released, by exactly one replica.
const nodeFailure = createNodeFailureWatcher({
  registry,
  affinity,
  db: db.kysely,
  logger,
  replicaId: `${hostname()}:${String(process.pid)}`,
  isConnected: (nodeId) => heartbeatIntervals.has(nodeId),
  startupGraceMs: config.HEARTBEAT_TTL_MS * 2,
});
nodeFailure.start();

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
  // S5-15: people reach the recording buttons through api-gateway, which signs who they are.
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

// S4-02: draining a node for a rolling upgrade.
const nodeDrain = createNodeDrain({
  db: db.kysely,
  registry,
  affinity,
  nodeIds: fsNodes.map((node) => node.id),
  logger,
});

registerInternalRoutes(app, affinity, config.INTERNAL_SERVICE_TOKEN, registry, nodeDrain);
// S4-12: the operations console's drain, undrain and weight, through api-gateway.
registerPlatformRoutes(app, nodeDrain);
// S4-13: the nodes' state and load, for the console's history.
registerNodeMetrics(app, () => registry.nodeStates(fsNodes.map((node) => node.id)));

const userExtension = createUserExtensionLookup({
  baseUrl: config.PBX_CONFIG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});

// S5-15: the recording buttons for live calls.
registerRecordingControlRoutes(app, {
  controller: createRecordingController({
    registry,
    esl: (nodeId) => eslClientsById.get(nodeId),
    recording: createRecordingControlClient({
      baseUrl: config.RECORDING_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
    spoolDir: config.RECORDING_SPOOL_DIR,
    logger,
    injectEvent: (nodeId, raw) => {
      handleInOrder(nodeId, () => channelHandler.handleEvent(nodeId, raw));
    },
  }),
  userExtension,
});

// S5-09: listen, whisper and barge, from the supervisor's own phone.
registerMonitorRoutes(app, {
  controller: createMonitorController({
    registry,
    esl: (nodeId) => eslClientsById.get(nodeId),
    access: createHttpAccessClient({
      baseUrl: config.IDENTITY_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
      ttlMs: config.ACCESS_CACHE_TTL_MS,
    }),
    userExtension,
    extensionScope: createExtensionScopeLookup({
      baseUrl: config.PBX_CONFIG_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
    tenantDomain: createTenantDomainLookup({
      baseUrl: config.ORG_SERVICE_URL,
      internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    }),
    // Committed to the outbox before the phone rings; the relay publishes it.
    audit: async (input) => {
      await recordAuditEvent(db.kysely, input);
    },
    opensipsSipUri: config.OPENSIPS_SIP_URI,
    ringTimeoutSeconds: config.MONITOR_RING_TIMEOUT_SECONDS,
    logger,
  }),
});

// S9-12: hang up, transfer, park and pick up live calls; a person's own, and click-to-call.
const callOperations = createCallOperations({
  registry,
  esl: (nodeId) => eslClientsById.get(nodeId),
  // A call that starts at the person's phone can start on any node in service.
  anyNode: async () => {
    const live = (await registry.liveNodeIds()).filter((id) => eslClientsById.has(id));
    return live[Math.floor(Math.random() * live.length)];
  },
  userExtension,
  tenantDomain: createTenantDomainLookup({
    baseUrl: config.ORG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  parkingLot: createParkingLotLookup({
    baseUrl: config.PBX_CONFIG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  parkingLotNode: (tenantId, lotId) => affinity.getOwner(tenantId, 'park', lotId),
  pickupPeers: createPickupPeersLookup({
    baseUrl: config.PBX_CONFIG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  // Committed to the outbox before the call is touched; the relay publishes it.
  audit: async (input) => {
    await recordAuditEvent(db.kysely, input);
  },
  opensipsSipUri: config.OPENSIPS_SIP_URI,
  ringTimeoutSeconds: config.MONITOR_RING_TIMEOUT_SECONDS,
  logger,
});
registerCallOperationRoutes(app, { operations: callOperations });
// S9-18: `*8`, for telephony-config's dialplan.
registerPickupInternalRoutes(app, {
  operations: callOperations,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});

// S9-13: live queues for the realtime `queues` topic, and agents' status from the console.
const queueStatus = createQueueStatus({
  liveNodeIds: () => registry.liveNodeIds(),
  esl: (nodeId) => eslClientsById.get(nodeId),
  tenantDomain: createTenantDomainLookup({
    baseUrl: config.ORG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  extensionScope: createExtensionScopeLookup({
    baseUrl: config.PBX_CONFIG_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  audit: async (input) => {
    await recordAuditEvent(db.kysely, input);
  },
  opensipsSipUri: config.OPENSIPS_SIP_URI,
  logger,
});
registerQueueStatusRoutes(app, {
  status: queueStatus,
  userExtension,
  access: createHttpAccessClient({
    baseUrl: config.IDENTITY_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
    ttlMs: config.ACCESS_CACHE_TTL_MS,
  }),
});
registerQueueStatusInternalRoutes(app, {
  status: queueStatus,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});

// S4-12/S4-13: the outbox backlog, for the operations console (`/statusz`, `/metrics`).
observeOutbox(app, relay);
app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('redis', async () => {
  try {
    return { status: (await redis.ping()) === 'PONG' ? 'pass' : 'fail' };
  } catch {
    return { status: 'fail' };
  }
});

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  for (const interval of heartbeatIntervals.values()) clearInterval(interval);
  affinity.stop();
  await nodeFailure.stop();
  await Promise.all(eslClients.map((client) => client.stop()));
  relay.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await relayLoop;
  await bus.close();
  redis.disconnect();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

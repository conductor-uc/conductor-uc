import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { Redis } from 'ioredis';

import { createAffinityManager } from './affinity/manager.js';
import { createChannelHandler } from './channel-handler.js';
import { configSchema, loadServiceConfig, parseFsNodes } from './config.js';
import { createEslClient, type EslClient } from './esl/client.js';
import { createCallRegistry } from './redis/registry.js';
import { createSerialQueue } from './serial.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import type { CallControlDb } from './schema.js';

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

const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
});

registerInternalRoutes(app, affinity, config.INTERNAL_SERVICE_TOKEN, registry);

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

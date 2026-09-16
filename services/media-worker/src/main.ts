import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { configSchema, loadServiceConfig } from './config.js';
import { createMediaAssetConsumer } from './consumers/media-asset.consumer.js';
import { createPbxConfigClient } from './pbx-config-client.js';
import type { MediaWorkerDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<MediaWorkerDb>({
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
// lock, so several instances starting at once is safe).
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

const storage = storageFromConfig(config, logger);
const pbxConfigClient = createPbxConfigClient({
  baseUrl: config.PBX_CONFIG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});

const consumer = createMediaAssetConsumer(db, bus, logger, storage, pbxConfigClient, {
  ffmpegPath: config.FFMPEG_PATH,
  ffprobePath: config.FFPROBE_PATH,
});
await consumer.ensure();
const consumerLoop = consumer.run();

// No outbox relay: this service never publishes its own event
// (`schema.ts`'s own doc comment on why) — its only cross-service write is
// the direct internal HTTP callback `pbx-config-client.ts` makes once a job
// finishes, not a queued outbound event.
const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

/**
 * SIGTERM stops taking new consumer work, drains in-flight HTTP requests
 * (just health checks — this service has no other routes), and closes the
 * bus and database connections — in that order, so nothing is torn down
 * while it might still be needed. A job already in flight (mid-`ffmpeg`)
 * finishes or is killed with the process; JetStream redelivers it either
 * way (05 §5's own at-least-once guarantee), so nothing here waits on it.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  consumer.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await consumerLoop;
  await bus.close();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

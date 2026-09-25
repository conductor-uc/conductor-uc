import { redactConfig } from '@cuc/config';
import { connectBus, type Bus } from '@cuc/events';
import { createLogger } from '@cuc/logger';

import { createChallengeLookup } from './acme-challenge.js';
import { buildApp } from './app.js';
import { createHttpsRedirect } from './http-redirect.js';
import { loadServiceConfig, configSchema } from './config.js';
import { createRedisClient } from './rate-limit/redis-client.js';
import type { RealtimeHub } from './realtime/hub.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const redis = createRedisClient(config.REDIS_URL);

let hub: RealtimeHub | undefined;
const app = await buildApp({
  config,
  redis,
  logger,
  realtime: {
    onHub: (created) => {
      hub = created;
    },
  },
});

// The realtime hub's NATS connection (S5-08) is made in the background and
// retried: the gateway serves the API whether or not NATS is up, and until it
// is, live subscriptions are refused as `unavailable`. The gateway only reads
// events and publishes audit records; it creates no streams (call-control does).
let bus: Bus | undefined;
let stopping = false;
async function connectRealtimeBus(): Promise<void> {
  let delayMs = 1_000;
  while (hub !== undefined && !stopping) {
    try {
      bus = await connectBus({
        servers: config.NATS_SERVERS,
        logger,
        name: config.SERVICE_NAME,
        ...(config.NATS_USER === undefined ? {} : { user: config.NATS_USER }),
        ...(config.NATS_PASSWORD === undefined ? {} : { password: config.NATS_PASSWORD }),
      });
      hub.attachBus(bus);
      logger.info('realtime hub connected to NATS');
      return;
    } catch (error) {
      logger.warn({ err: error, retryInMs: delayMs }, 'realtime hub cannot reach NATS yet');
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      delayMs = Math.min(delayMs * 2, 30_000);
    }
  }
}
const realtimeBus = connectRealtimeBus();

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

// Browsers that arrive on plain HTTP are sent to HTTPS.
const redirect =
  config.HTTP_REDIRECT_PORT === undefined
    ? undefined
    : createHttpsRedirect({
        httpsPort: config.HTTP_PORT,
        challenge: createChallengeLookup({
          orgServiceUrl: config.ORG_SERVICE_URL,
          internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
        }),
      });
if (redirect !== undefined && config.HTTP_REDIRECT_PORT !== undefined) {
  redirect.listen(config.HTTP_REDIRECT_PORT, config.HTTP_HOST);
  logger.info({ port: config.HTTP_REDIRECT_PORT }, 'redirecting plain HTTP to HTTPS');
}

/**
 * SIGTERM drains in-flight HTTP requests, closes realtime connections (1001:
 * the client reconnects, to another replica), then closes NATS and Redis. The
 * gateway holds no DB and no outbox: it has no business data of its own.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  stopping = true;
  redirect?.close();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await Promise.race([realtimeBus, new Promise((resolve) => setTimeout(resolve, 1_000))]);
  await bus?.close().catch(() => undefined);
  redis.disconnect();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

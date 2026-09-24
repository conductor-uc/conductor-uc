import { redactConfig } from '@cuc/config';
import { createLogger } from '@cuc/logger';

import { buildApp } from './app.js';
import { createHttpsRedirect } from './http-redirect.js';
import { loadServiceConfig, configSchema } from './config.js';
import { createRedisClient } from './rate-limit/redis-client.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const redis = createRedisClient(config.REDIS_URL);

const app = await buildApp({ config, redis, logger });

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

// Browsers that arrive on plain HTTP are sent to HTTPS.
const redirect =
  config.HTTP_REDIRECT_PORT === undefined
    ? undefined
    : createHttpsRedirect({ httpsPort: config.HTTP_PORT });
if (redirect !== undefined && config.HTTP_REDIRECT_PORT !== undefined) {
  redirect.listen(config.HTTP_REDIRECT_PORT, config.HTTP_HOST);
  logger.info({ port: config.HTTP_REDIRECT_PORT }, 'redirecting plain HTTP to HTTPS');
}

/**
 * SIGTERM drains in-flight HTTP requests before closing Redis — the gateway
 * holds no other durable connection (no DB, no bus: it has neither business
 * data of its own nor an outbox).
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  redirect?.close();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  redis.disconnect();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

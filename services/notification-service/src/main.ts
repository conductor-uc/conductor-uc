import { redactConfig } from '@cuc/config';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';

import { configSchema, loadServiceConfig } from './config.js';
import { createIdentityConsumer } from './consumers/identity.consumer.js';
import { createVoicemailConsumer } from './consumers/voicemail.consumer.js';
import { createMailer } from './mailer.js';
import { createOrgClient } from './org-client.js';
import type { NotificationServiceDb } from './schema.js';
import { createVoicemailClient } from './voicemail-client.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<NotificationServiceDb>({
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

const mailer = createMailer({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE,
  ...(config.SMTP_USER === undefined ? {} : { user: config.SMTP_USER }),
  ...(config.SMTP_PASSWORD === undefined ? {} : { password: config.SMTP_PASSWORD }),
  fromAddress: config.PLATFORM_NOREPLY_ADDRESS,
});

const orgClient = createOrgClient({
  baseUrl: config.ORG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const linkOptions = {
  defaultConsoleBase: `${config.CONSOLE_LINK_SCHEME}://console.${config.PLATFORM_BASE_DOMAIN}`,
  linkScheme: config.CONSOLE_LINK_SCHEME,
  ...(config.CONSOLE_URL_OVERRIDE === undefined
    ? {}
    : { consoleUrlOverride: config.CONSOLE_URL_OVERRIDE }),
};

const consumer = createIdentityConsumer(db, bus, logger, orgClient, mailer, linkOptions);
const voicemailConsumer = createVoicemailConsumer(
  db,
  bus,
  logger,
  orgClient,
  createVoicemailClient({
    baseUrl: config.VOICEMAIL_SERVICE_URL,
    internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
  }),
  mailer,
  { ...linkOptions, maxAttachmentBytes: config.VOICEMAIL_MAX_ATTACHMENT_BYTES },
);
await consumer.ensure();
await voicemailConsumer.ensure();
const consumerLoop = Promise.all([consumer.run(), voicemailConsumer.run()]);

// No routes of its own: this service only consumes events. The server exists
// for the health and readiness endpoints.
const app = await createServer({
  serviceName: config.SERVICE_NAME,
  serviceVersion: config.SERVICE_VERSION,
  logger,
  context: { trustInternalHeaders: false },
});
app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

/** SIGTERM stops taking events, drains HTTP, then closes the connections. */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  consumer.stop();
  voicemailConsumer.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await consumerLoop;
  mailer.close();
  await bus.close();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

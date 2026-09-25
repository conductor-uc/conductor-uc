import { redactConfig } from '@cuc/config';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest, REWRAP_INTERVAL_MS } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createRemotePermissionResolver, createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';
import { storageFromConfig } from '@cuc/storage';

import { configSchema, loadServiceConfig } from './config.js';
import { createKekRewrapJob } from './kek-rewrap.js';
import { nodeDnsResolver } from './dns-resolver.js';
import { createAcmeIssuer } from './acme-issuer.js';
import { createTermsLookup } from './acme-terms.js';
import { createCertificateWorker } from './certificate-worker.js';
import { createIdentityClient } from './identity-client.js';
import { createAcmeAccountRepo } from './repo/acme-account.repo.js';
import { createAcmeSettingsRepo } from './repo/acme-settings.repo.js';
import { createBrandRepo } from './repo/brand.repo.js';
import { createCertificateRepo } from './repo/certificate.repo.js';
import { createDomainRepo } from './repo/domain.repo.js';
import { createOrgRepo } from './repo/org.repo.js';
import { registerAcmeSettingsRoutes } from './routes/acme-settings.routes.js';
import { createPlatformNetworkRepo } from './repo/platform-network.repo.js';
import { registerNetworkRoutes } from './routes/network.routes.js';
import { registerBrandRoutes } from './routes/brand.routes.js';
import {
  registerCertificateInternalRoutes,
  registerCertificateRoutes,
} from './routes/certificate.routes.js';
import { registerDomainRoutes } from './routes/domain.routes.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerOrgRoutes } from './routes/org.routes.js';
import type { OrgServiceDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<OrgServiceDb>({
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

const identityClient = createIdentityClient({
  baseUrl: config.IDENTITY_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const orgRepo = createOrgRepo(db, { platformBaseDomain: config.PLATFORM_BASE_DOMAIN });
registerOrgRoutes(app, orgRepo, identityClient.createAdminUser);
const domainRepo = createDomainRepo(db);
registerDomainRoutes(app, domainRepo, nodeDnsResolver());
registerInternalRoutes(
  app,
  domainRepo,
  config.INTERNAL_SERVICE_TOKEN,
  orgRepo,
  createBrandRepo(db),
  // 02 §3's table: the master/unbranded console lives at console.{PLATFORM_BASE_DOMAIN}.
  `console.${config.PLATFORM_BASE_DOMAIN}`,
);

const kek = fileKekFromConfig(config);
const certificateRepo = createCertificateRepo(db, {
  kek,
  platformBaseDomain: config.PLATFORM_BASE_DOMAIN,
});
registerCertificateRoutes(app, certificateRepo);
registerCertificateInternalRoutes(app, certificateRepo, config.INTERNAL_SERVICE_TOKEN);

// The Let's Encrypt account and agreement, set in the console (G-105).
const acmeSettingsRepo = createAcmeSettingsRepo(db, {
  directoryUrlOverride: config.ACME_DIRECTORY_URL,
});
registerAcmeSettingsRoutes(
  app,
  acmeSettingsRepo,
  createTermsLookup({ directoryUrlOverride: config.ACME_DIRECTORY_URL }),
  bus,
);

// The platform's public address, and the DNS records resellers publish for it.
registerNetworkRoutes(app, createPlatformNetworkRepo(db), certificateRepo, bus);

// Requests and renews certificates in the background once the operator has set the
// Let's Encrypt account up in the console (G-105).
const certificateWorker = createCertificateWorker({
  certs: certificateRepo,
  settings: acmeSettingsRepo,
  accounts: createAcmeAccountRepo(db, kek),
  issuer: createAcmeIssuer(),
  logger,
});
const certificateWorkerDone = certificateWorker.run();

// Keeps a row for every hostname that should have a certificate, worked out from
// what the database already holds, so no provisioning path has to remember to ask.
// Runs at startup and then every few minutes; issuing them is the next change.
let reconciling = true;
async function reconcileLoop(): Promise<void> {
  while (reconciling) {
    try {
      const added = await certificateRepo.reconcileWanted();
      if (added > 0) logger.info({ added }, 'certificates: new hostnames wanted');
    } catch (error) {
      logger.warn({ err: error }, 'certificates: reconcile failed');
    }
    await new Promise((resolve) => setTimeout(resolve, 5 * 60_000));
  }
}
const reconcileDone = reconcileLoop();

const storage = storageFromConfig(config, logger);
// 02 §3's table: the master/unbranded console lives at console.{PLATFORM_BASE_DOMAIN}.
registerBrandRoutes(
  app,
  createBrandRepo(db),
  storage,
  `console.${config.PLATFORM_BASE_DOMAIN}`,
  orgRepo,
);

// G-116: values still under an older KEK version are moved to the current one
// in the background, and `/readyz` says how many remain, so an old version
// can be removed from CRYPTO_KEKS once every service reports 0.
const kekRewrap = createKekRewrapJob(db, kek, logger);
app.addReadinessCheck('kek_rewrap', kekRewrap.readinessCheck);
kekRewrap.start(REWRAP_INTERVAL_MS);

await app.listen({ host: config.HTTP_HOST, port: config.HTTP_PORT });
logger.info({ port: config.HTTP_PORT }, 'listening');

/**
 * SIGTERM drains in-flight HTTP requests, stops taking new outbox work, and
 * closes the bus connection — in that order, so nothing is torn down while it
 * might still be needed.
 */
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'shutting down');
  relay.stop();
  reconciling = false;
  certificateWorker.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await relayLoop;
  void reconcileDone;
  void certificateWorkerDone;
  await bus.close();
  await kekRewrap.stop();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

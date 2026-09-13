import { redactConfig } from '@cuc/config';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';

import { createAuthService } from './auth/auth-service.js';
import { configSchema, loadServiceConfig } from './config.js';
import { createMfaRepo } from './repo/mfa.repo.js';
import { createSessionRepo } from './repo/session.repo.js';
import { createSigningKeyRepo } from './repo/signing-key.repo.js';
import { createUserRepo } from './repo/user.repo.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerJwksRoute } from './routes/jwks.routes.js';
import type { IdentityServiceDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

const db = createDatabase<IdentityServiceDb>({
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
  context: { trustInternalHeaders: config.TRUST_INTERNAL_HEADERS },
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('bus', async () => ({ status: (await bus.ping()) ? 'pass' : 'fail' }));
app.addReadinessCheck('outbox', async () => {
  const lag = await relay.lag();
  return { status: 'pass', detail: `${String(lag)} pending` };
});

const kek = fileKekFromConfig(config);

const userRepo = createUserRepo(db);
const sessionRepo = createSessionRepo(db);
const mfaRepo = createMfaRepo(db);
const signingKeyRepo = createSigningKeyRepo(db, kek);

// Idempotent: generates the first signing key on a brand-new deployment,
// otherwise finds the one already current. Must happen before any route that
// signs or verifies a token.
await signingKeyRepo.ensureCurrentKey();

const authService = createAuthService({
  users: userRepo,
  sessions: sessionRepo,
  mfa: mfaRepo,
  signingKeys: signingKeyRepo,
  kek,
  accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  mfaTicketTtlSeconds: config.MFA_TICKET_TTL_SECONDS,
  signingKeyOverlapDays: config.SIGNING_KEY_OVERLAP_DAYS,
});

registerAuthRoutes(app, authService);
registerJwksRoute(app, signingKeyRepo, config.SIGNING_KEY_OVERLAP_DAYS);
registerInternalRoutes(app, userRepo, config.INTERNAL_SERVICE_TOKEN);

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

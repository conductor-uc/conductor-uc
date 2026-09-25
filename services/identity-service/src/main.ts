import { toUnscopedAccessSink } from '@cuc/audit';
import { redactConfig } from '@cuc/config';
import { fileKekFromConfig } from '@cuc/crypto';
import { createDatabase, migrateToLatest } from '@cuc/db';
import { connectBus, createRelay } from '@cuc/events';
import { createServer } from '@cuc/http';
import { createLogger } from '@cuc/logger';

import { createAuthService } from './auth/auth-service.js';
import { configSchema, loadServiceConfig } from './config.js';
import { createAuditConsumer } from './consumers/audit.consumer.js';
import { createAuditRepo } from './repo/audit.repo.js';
import { createGrantRepo } from './repo/grant.repo.js';
import { createMfaRepo } from './repo/mfa.repo.js';
import { createRoleRepo } from './repo/role.repo.js';
import { createSessionRepo } from './repo/session.repo.js';
import { createTokenRepo } from './repo/token.repo.js';
import { createSigningKeyRepo } from './repo/signing-key.repo.js';
import { createUserRepo } from './repo/user.repo.js';
import { registerAuditRoutes } from './routes/audit.routes.js';
import { registerMeRoutes } from './routes/me.routes.js';
import { createOrgAccess } from './authz/org-access.js';
import { createOrgClient } from './org-client.js';
import { registerAuthRoutes } from './routes/auth.routes.js';
import { registerGrantRoutes } from './routes/grants.routes.js';
import { registerAccessRoutes } from './routes/access.routes.js';
import { registerInternalRoutes } from './routes/internal.routes.js';
import { registerJwksRoute } from './routes/jwks.routes.js';
import { registerRoleRoutes } from './routes/roles.routes.js';
import { registerUserRoutes } from './routes/users.routes.js';
import type { IdentityServiceDb } from './schema.js';

const config = loadServiceConfig();
const logger = createLogger({
  name: config.SERVICE_NAME,
  level: config.LOG_LEVEL,
  version: config.SERVICE_VERSION,
});
logger.info(redactConfig(configSchema, config), 'starting');

// Connected before the database, so its handle exists in time to back the
// audit sink `createDatabase` wires below (05 §2.3 / 07 §4: a cross-tenant
// `unscoped(ctx, reason)` query is audited).
const bus = await connectBus({
  servers: config.NATS_SERVERS,
  logger,
  name: config.SERVICE_NAME,
  ...(config.NATS_USER === undefined ? {} : { user: config.NATS_USER }),
  ...(config.NATS_PASSWORD === undefined ? {} : { password: config.NATS_PASSWORD }),
});
await bus.ensureStreams();

const db = createDatabase<IdentityServiceDb>({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  poolSize: config.DB_POOL_SIZE,
  connectTimeoutMs: config.DB_CONNECT_TIMEOUT_MS,
  logger,
  onUnscopedAccess: toUnscopedAccessSink(bus, logger),
});

// Migrations run at startup rather than as a separate deploy step, until this
// service has enough traffic that a migration wants its own maintenance
// window. Kysely holds a lock, so several instances starting at once is safe.
await migrateToLatest({
  db: db.kysely,
  dir: new URL('../migrations', import.meta.url).pathname,
  logger,
});

const relay = createRelay({
  db: db.kysely,
  bus,
  logger,
  batchSize: config.OUTBOX_BATCH_SIZE,
  pollIntervalMs: config.OUTBOX_POLL_INTERVAL_MS,
  maxAttempts: config.OUTBOX_MAX_ATTEMPTS,
});
const relayLoop = relay.run();

const auditRepo = createAuditRepo(db);
const auditConsumer = createAuditConsumer(db, bus, logger, auditRepo);
await auditConsumer.ensure();
const auditConsumerLoop = auditConsumer.run();

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

const kek = fileKekFromConfig(config);

const userRepo = createUserRepo(db);
const sessionRepo = createSessionRepo(db);
const mfaRepo = createMfaRepo(db);
const signingKeyRepo = createSigningKeyRepo(db, kek);
const tokenRepo = createTokenRepo(db);

// Idempotent: generates the first signing key on a brand-new deployment,
// otherwise finds the one already current. Must happen before any route that
// signs or verifies a token.
await signingKeyRepo.ensureCurrentKey();

const authService = createAuthService({
  users: userRepo,
  sessions: sessionRepo,
  mfa: mfaRepo,
  signingKeys: signingKeyRepo,
  tokens: tokenRepo,
  kek,
  accessTokenTtlSeconds: config.ACCESS_TOKEN_TTL_SECONDS,
  refreshTokenTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  mfaTicketTtlSeconds: config.MFA_TICKET_TTL_SECONDS,
  signingKeyOverlapDays: config.SIGNING_KEY_OVERLAP_DAYS,
  passwordResetTtlMinutes: config.PASSWORD_RESET_TTL_MINUTES,
  invitationTtlDays: config.INVITATION_TTL_DAYS,
});

const orgClient = createOrgClient({
  baseUrl: config.ORG_SERVICE_URL,
  internalServiceToken: config.INTERNAL_SERVICE_TOKEN,
});
const orgAccess = createOrgAccess(orgClient);

registerAuthRoutes(app, authService, {
  cookieSecure: config.COOKIE_SECURE,
  refreshTokenTtlDays: config.REFRESH_TOKEN_TTL_DAYS,
  devExposeTokens: config.DEV_EXPOSE_TOKENS,
  orgClient,
});
registerJwksRoute(app, signingKeyRepo, config.SIGNING_KEY_OVERLAP_DAYS);
const roleRepo = createRoleRepo(db);
registerInternalRoutes(app, userRepo, roleRepo, config.INTERNAL_SERVICE_TOKEN);
registerRoleRoutes(app, roleRepo, orgAccess, userRepo);
registerUserRoutes(app, userRepo, roleRepo, orgAccess, mfaRepo);
const grantRepo = createGrantRepo(db);
registerGrantRoutes(app, grantRepo);
registerMeRoutes(app, roleRepo, grantRepo);
registerAccessRoutes(app, roleRepo, grantRepo, config.INTERNAL_SERVICE_TOKEN);
registerAuditRoutes(app, auditRepo, orgAccess);

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
  auditConsumer.stop();
  await Promise.race([
    app.close(),
    new Promise((resolve) => setTimeout(resolve, config.SHUTDOWN_GRACE_MS)),
  ]);
  await relayLoop;
  await auditConsumerLoop;
  await bus.close();
  await db.destroy();
  logger.info('shutdown complete');
  process.exit(0);
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

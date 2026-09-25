import { randomBytes } from 'node:crypto';

import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { fileKekFromConfig, type KekProvider } from '@cuc/crypto';
import { silentLogger, startTestDatabase, type TestDatabaseHandle } from '@cuc/testing';

import { createAuthService } from '../src/auth/auth-service.js';
import { createGrantRepo, type GrantRepo } from '../src/repo/grant.repo.js';
import { createMfaRepo, type MfaRepo } from '../src/repo/mfa.repo.js';
import { createRoleRepo, type RoleRepo } from '../src/repo/role.repo.js';
import { createSessionRepo } from '../src/repo/session.repo.js';
import { createTokenRepo } from '../src/repo/token.repo.js';
import { createSigningKeyRepo } from '../src/repo/signing-key.repo.js';
import { createUserRepo, type UserRepo } from '../src/repo/user.repo.js';
import type { IdentityServiceDb } from '../src/schema.js';
import { migrations } from './fixtures/migrations.js';

export interface Harness {
  readonly db: Database<IdentityServiceDb>;
  readonly kek: KekProvider;
  readonly users: UserRepo;
  readonly mfa: MfaRepo;
  readonly roles: RoleRepo;
  readonly grants: GrantRepo;
  readonly auth: ReturnType<typeof createAuthService>;
  readonly handle: TestDatabaseHandle;
  close(): Promise<void>;
}

const TEST_KEK = randomBytes(32).toString('base64');

export const TEST_META = { ip: '127.0.0.1', ua: 'vitest' };

/** Short TTLs so a rotation or expiry test does not need to sleep for real. */
export const TEST_TTL = {
  accessTokenTtlSeconds: 600,
  refreshTokenTtlDays: 30,
  mfaTicketTtlSeconds: 300,
  signingKeyOverlapDays: 7,
  passwordResetTtlMinutes: 60,
  invitationTtlHours: 72,
};

export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();

  const db = createDatabase<IdentityServiceDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const kek = fileKekFromConfig({ CRYPTO_KEKS: `1:${TEST_KEK}`, CRYPTO_KEK_CURRENT: '1' });

  const users = createUserRepo(db);
  const roles = createRoleRepo(db);
  const grants = createGrantRepo(db);
  const sessions = createSessionRepo(db);
  const mfa = createMfaRepo(db);
  const signingKeys = createSigningKeyRepo(db, kek);
  await signingKeys.ensureCurrentKey();

  const tokens = createTokenRepo(db);
  const auth = createAuthService({ users, sessions, mfa, signingKeys, tokens, kek, ...TEST_TTL });

  return {
    db,
    kek,
    users,
    mfa,
    roles,
    grants,
    auth,
    handle,
    async close() {
      await db.destroy();
      await handle.stop();
    },
  };
}

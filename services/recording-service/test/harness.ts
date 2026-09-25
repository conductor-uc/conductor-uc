import { randomUUID } from 'node:crypto';

import type { AuditEventInput } from '@cuc/audit';
import type { Grant } from '@cuc/authz';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import type { Logger } from '@cuc/logger';
import { createStorage, type Storage } from '@cuc/storage';
import { silentLogger, startTestDatabase, startTestS3, type TestS3Handle } from '@cuc/testing';

import { AccessUnavailableError, type AccessClient, type ActorAccess } from '../src/access.js';
import { createPolicyRepo, type PolicyRepo } from '../src/repo/policy.repo.js';
import { createRecordingRepo, type RecordingRepo } from '../src/repo/recording.repo.js';
import { createSettingsRepo, type SettingsRepo } from '../src/repo/settings.repo.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { registerPolicyRoutes } from '../src/routes/policy.routes.js';
import { registerRecordingRoutes } from '../src/routes/recording.routes.js';
import type { RecordingServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

export const INTERNAL_TOKEN = 'test-internal-service-token';
export const HEADER_SECRET = 'test-internal-header-secret';
export const DEFAULT_RETENTION_DAYS = 90;

export interface Harness {
  readonly db: Database<RecordingServiceDb>;
  readonly storage: Storage;
  readonly policies: PolicyRepo;
  readonly recordings: RecordingRepo;
  readonly settings: SettingsRepo;
  readonly logger: Logger;
  close(): Promise<void>;
}

/** A migrated schema, real repos, and a real MinIO behind storage. No NATS. */
export async function startHarness(): Promise<Harness> {
  const logger = silentLogger();
  const handle = await startTestDatabase();
  const s3Handle: TestS3Handle = await startTestS3();

  const db = createDatabase<RecordingServiceDb>({
    host: handle.host,
    port: handle.port,
    user: handle.user,
    password: handle.password,
    database: handle.database,
    poolSize: 4,
    logger,
  });
  await migrateToLatest({ db: db.kysely, migrations, logger });

  const storage = createStorage({
    mode: 'bucket-per-tenant',
    bucketPrefix: `cuc-rec-${randomUUID().slice(0, 8)}`,
    endpoint: s3Handle.endpoint,
    region: s3Handle.region,
    accessKeyId: s3Handle.accessKeyId,
    secretAccessKey: s3Handle.secretAccessKey,
    forcePathStyle: s3Handle.forcePathStyle,
    logger,
  });

  return {
    db,
    storage,
    policies: createPolicyRepo(db),
    recordings: createRecordingRepo(db),
    settings: createSettingsRepo(db, DEFAULT_RETENTION_DAYS),
    logger,
    async close() {
      await db.destroy();
      await handle.stop();
      await s3Handle.stop();
    },
  };
}

export async function resetSchema(db: Database<RecordingServiceDb>): Promise<void> {
  await db.kysely.deleteFrom('recordings').execute();
  await db.kysely.deleteFrom('recording_policies').execute();
  await db.kysely.deleteFrom('recording_settings').execute();
  await db.kysely.deleteFrom('outbox').execute();
  await db.kysely.deleteFrom('consumed_events').execute();
}

/** Roles and grants per user id, standing in for identity-service. */
export class FakeAccess implements AccessClient {
  private readonly users = new Map<string, ActorAccess>();
  unavailable = false;

  set(userId: string, access: Partial<ActorAccess>): void {
    this.users.set(userId, { roles: access.roles ?? [], grants: access.grants ?? [] });
  }

  resolve(input: { orgId: string; actorId: string }): Promise<ActorAccess> {
    if (this.unavailable) return Promise.reject(new AccessUnavailableError('identity down'));
    return Promise.resolve(this.users.get(input.actorId) ?? { roles: [], grants: [] });
  }
}

export const TENANT_ADMIN_ROLE = {
  id: 'tenant_admin',
  permissions: [
    'recording.policy.manage',
    'recording.listen',
    'recording.download',
    'recording.delete',
  ],
};

export function grant(
  userId: string,
  permission: string,
  scope: { type: 'queue' | 'extension' | 'did' | 'org'; id: string },
): Grant {
  return { principalType: 'user', principalId: userId, permission, scope };
}

export interface RoutesHarness {
  readonly app: Server;
  readonly access: FakeAccess;
  /** Every audit event the routes published. */
  readonly audited: AuditEventInput[];
  /** Makes the next audit publishes fail. */
  auditFails: { value: boolean };
  headers(
    actorId: string,
    orgId: string,
    orgType?: 'tenant' | 'reseller' | 'master',
  ): Record<string, string>;
}

export async function startRoutes(h: Harness): Promise<RoutesHarness> {
  const access = new FakeAccess();
  const audited: AuditEventInput[] = [];
  const auditFails = { value: false };

  const app = await createServer({
    serviceName: 'recording-service',
    logger: h.logger,
    context: {
      trustInternalHeaders: true,
      internalHeaderSigningSecret: HEADER_SECRET,
      internalServiceToken: INTERNAL_TOKEN,
    },
  });
  registerPolicyRoutes(app, {
    policies: h.policies,
    settings: h.settings,
    access,
    storage: h.storage,
    logger: h.logger,
  });
  registerRecordingRoutes(app, {
    recordings: h.recordings,
    access,
    storage: h.storage,
    logger: h.logger,
    audit: (input) => {
      if (auditFails.value) return Promise.reject(new Error('bus down'));
      audited.push(input);
      return Promise.resolve();
    },
  });
  registerInternalRoutes(app, {
    policies: h.policies,
    recordings: h.recordings,
    settings: h.settings,
    storage: h.storage,
    logger: h.logger,
    internalServiceToken: INTERNAL_TOKEN,
  });
  await app.ready();

  return {
    app,
    access,
    audited,
    auditFails,
    headers(actorId, orgId, orgType = 'tenant') {
      return signInternalHeaders(HEADER_SECRET, {
        actorId,
        actorType: 'user',
        orgId,
        orgType,
        ...(orgType === 'tenant' ? { tenantId: orgId } : {}),
      });
    },
  };
}

/** The URL a `fetch` call was given, whatever form it took. */
export function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === 'string') return input;
  return input instanceof URL ? input.href : input.url;
}

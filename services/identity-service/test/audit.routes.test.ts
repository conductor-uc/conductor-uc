import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import { createAuditRepo, type AuditRepo } from '../src/repo/audit.repo.js';
import { registerAuditRoutes } from '../src/routes/audit.routes.js';
import { migrations } from '../migrations/index.js';
import type { IdentityServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';

/** A lineage lookup that knows one tenant, under one reseller. */
const lineage = (orgId: string) =>
  Promise.resolve(
    orgId === 'tenant-1'
      ? { orgId, type: 'tenant' as const, parentId: 'reseller-1', resellerId: 'reseller-1' }
      : undefined,
  );

function actor(orgId: string, orgType: 'master' | 'reseller' | 'tenant') {
  return signInternalHeaders(SECRET, {
    actorId: 'user-1',
    actorType: 'user',
    orgId,
    orgType,
    ...(orgType === 'tenant' ? { tenantId: orgId } : {}),
  });
}

describe.skipIf(skipReason !== undefined)('audit-service HTTP routes', () => {
  let db: Database<IdentityServiceDb>;
  let repo: AuditRepo;
  let app: Server;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<IdentityServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createAuditRepo(db);

    app = await createServer({
      serviceName: 'identity-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerAuditRoutes(app, repo, createOrgAccess({ lineage }));
    await app.ready();

    stop = async () => {
      await app.close();
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  afterEach(async () => {
    await db.kysely.deleteFrom('audit_events').execute();
  });

  it('returns the events visible to the named org', async () => {
    await db.kysely.transaction().execute(async (trx) => {
      await repo.insert(trx, randomUUID(), new Date(), {
        actorType: 'user',
        actorId: 'master-user-1',
        actorOrgId: 'master-org',
        targetOrgId: 'tenant-1',
        action: 'cdr.read',
        resource: 'cdr:abc123',
        dataClass: 'private',
      });
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/tenant-1/audit-events',
      headers: actor('tenant-1', 'tenant'),
    });

    expect(response.statusCode).toBe(200);
    const body: { rows: { action: string; at: string }[] } = response.json();
    expect(body.rows).toHaveLength(1);
    expect(body.rows[0]).toMatchObject({ action: 'cdr.read' });
    // `at` serializes as an ISO string, not a bare Date object.
    expect(() => new Date(body.rows[0]!.at).toISOString()).not.toThrow();
  });

  it('returns an empty list for an org with no visible events', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/no-such-org/audit-events',
      headers: actor('no-such-org', 'tenant'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ rows: [] });
  });

  it('respects a limit query parameter', async () => {
    await db.kysely.transaction().execute(async (trx) => {
      for (let i = 0; i < 3; i++) {
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'u1',
          actorOrgId: 'org1',
          action: 'x',
          resource: `r${String(i)}`,
          dataClass: 'config',
        });
      }
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/org1/audit-events?limit=2',
      headers: actor('org1', 'tenant'),
    });

    const body: { rows: unknown[] } = response.json();
    expect(body.rows).toHaveLength(2);
  });

  it("reads another org's trail only from above it", async () => {
    const url = '/v1/orgs/tenant-1/audit-events';
    // A tenant cannot read a different tenant's trail.
    expect(
      (await app.inject({ method: 'GET', url, headers: actor('tenant-2', 'tenant') })).statusCode,
    ).toBe(403);
    // Nor a reseller one that is not its own.
    expect(
      (await app.inject({ method: 'GET', url, headers: actor('reseller-2', 'reseller') }))
        .statusCode,
    ).toBe(403);
    // Its own reseller, and the master, can.
    expect(
      (await app.inject({ method: 'GET', url, headers: actor('reseller-1', 'reseller') }))
        .statusCode,
    ).toBe(200);
    expect(
      (await app.inject({ method: 'GET', url, headers: actor('master-1', 'master') })).statusCode,
    ).toBe(200);
    // And someone who is not signed in cannot at all.
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
  });

  it('declares permission and dataClass (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url === '/v1/orgs/:orgId/audit-events');
    expect(route?.permission).toBe('audit.read');
    expect(route?.dataClass).not.toBeNull();
  });
});

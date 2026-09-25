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

  describe('private-data rows (G-13)', () => {
    /** One tenant's trail: a config change, and the master playing a recording. */
    async function seedTenantTrail(): Promise<void> {
      await db.kysely.transaction().execute(async (trx) => {
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'tenant-admin',
          actorOrgId: 'tenant-1',
          targetOrgId: 'tenant-1',
          action: 'extension.update',
          resource: 'extension:1001',
          dataClass: 'config',
        });
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-1',
          targetOrgId: 'tenant-1',
          action: 'recording.play',
          resource: 'recording:r1',
          dataClass: 'private',
          reason: 'support ticket 42',
        });
      });
    }

    async function actionsSeenBy(
      orgId: string,
      orgType: 'master' | 'reseller' | 'tenant',
      trailOf = 'tenant-1',
    ): Promise<string[]> {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${trailOf}/audit-events`,
        headers: actor(orgId, orgType),
      });
      expect(response.statusCode).toBe(200);
      return response
        .json<{ rows: { action: string }[] }>()
        .rows.map((r) => r.action)
        .sort();
    }

    it('a reseller reading its tenant’s trail sees the config changes, not the private rows', async () => {
      await seedTenantTrail();
      expect(await actionsSeenBy('reseller-1', 'reseller')).toEqual(['extension.update']);
    });

    it('the tenant still sees the master’s access to its private data', async () => {
      await seedTenantTrail();
      expect(await actionsSeenBy('tenant-1', 'tenant')).toEqual([
        'extension.update',
        'recording.play',
      ]);
    });

    it('the master sees every row', async () => {
      await seedTenantTrail();
      expect(await actionsSeenBy('master-1', 'master')).toEqual([
        'extension.update',
        'recording.play',
      ]);
    });

    it('a reseller’s own trail leaves out private rows too', async () => {
      await db.kysely.transaction().execute(async (trx) => {
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'master-user-1',
          actorOrgId: 'master-1',
          targetOrgId: 'reseller-1',
          action: 'cdr.export',
          resource: 'cdr:export-1',
          dataClass: 'private',
        });
        await repo.insert(trx, randomUUID(), new Date(), {
          actorType: 'user',
          actorId: 'user-1',
          actorOrgId: 'reseller-1',
          action: 'brand.update',
          resource: 'brand:reseller-1',
          dataClass: 'config',
        });
      });
      expect(await actionsSeenBy('reseller-1', 'reseller', 'reseller-1')).toEqual(['brand.update']);
    });
  });

  it('declares permission and dataClass (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url === '/v1/orgs/:orgId/audit-events');
    expect(route?.permission).toBe('audit.read');
    expect(route?.dataClass).not.toBeNull();
  });
});

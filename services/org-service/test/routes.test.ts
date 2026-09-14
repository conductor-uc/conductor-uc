import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { migrations } from '../migrations/index.js';
import { createOrgRepo, type OrgRepo } from '../src/repo/org.repo.js';
import { registerOrgRoutes } from '../src/routes/org.routes.js';
import type { OrgServiceDb } from '../src/schema.js';
import type { AdminUserCreator, AdminUserInput, CreatedAdminUser } from '../src/identity-client.js';
import { AdminUserEmailTakenError } from '../src/identity-client.js';

const skipReason = await databaseOrSkipReason();
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

/**
 * Records every call and returns a fixed, distinct admin user each time.
 *
 * One instance for the whole suite — `create` is handed to
 * `registerOrgRoutes` once, in `beforeAll`, so its closure is fixed; `reset`
 * clears state in place between tests rather than the test swapping in a new
 * object the registered route would never see.
 */
function fakeAdminUserCreator(): {
  readonly create: AdminUserCreator;
  calls: AdminUserInput[];
  fail: Error | undefined;
  reset(): void;
} {
  const state = {
    calls: [] as AdminUserInput[],
    fail: undefined as Error | undefined,
    create: (input: AdminUserInput): Promise<CreatedAdminUser> => {
      state.calls.push(input);
      if (state.fail !== undefined) return Promise.reject(state.fail);
      return Promise.resolve({ id: `admin-${String(state.calls.length)}`, email: input.email });
    },
    reset(): void {
      state.calls = [];
      state.fail = undefined;
    },
  };
  return state;
}

describe.skipIf(skipReason !== undefined)('org-service HTTP routes', () => {
  let db: Database<OrgServiceDb>;
  let repo: OrgRepo;
  let app: Server;
  let stop: () => Promise<void>;
  let adminUsers: ReturnType<typeof fakeAdminUserCreator>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<OrgServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createOrgRepo(db, { platformBaseDomain: 'platform.test' });

    adminUsers = fakeAdminUserCreator();
    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: {
        trustInternalHeaders: true,
        internalHeaderSigningSecret: TEST_INTERNAL_SECRET,
      },
    });
    registerOrgRoutes(app, repo, adminUsers.create);
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

  beforeEach(() => {
    adminUsers.reset();
  });

  afterEach(async () => {
    // tenant_domains/reseller_base_domains FK to orgs, so they go first.
    await db.kysely.deleteFrom('tenant_domains').execute();
    await db.kysely.deleteFrom('reseller_base_domains').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'tenant').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'reseller').execute();
    await db.kysely.deleteFrom('orgs').where('type', '=', 'master').execute();
    await db.kysely.deleteFrom('outbox').execute();
  });

  const ADMIN_BODY = {
    adminEmail: 'admin@example.com',
    adminDisplayName: 'Admin',
    adminPassword: 'correct horse battery staple',
  };

  async function createMaster() {
    return repo.createMaster({ slug: 'master', name: 'Master' });
  }

  describe('POST /v1/resellers', () => {
    it('creates a reseller under the master, and its admin user via identity-service', async () => {
      await createMaster();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        headers: signInternalHeaders(TEST_INTERNAL_SECRET, { orgType: 'master' }),
        payload: { slug: 'acme', name: 'Acme Resale', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(201);
      const body: { id: string; adminUser: { email: string } } = response.json();
      expect(body).toMatchObject({ type: 'reseller', slug: 'acme', name: 'Acme Resale' });
      expect(body.adminUser).toMatchObject({ email: 'admin@example.com' });
      expect(adminUsers.calls).toHaveLength(1);
      expect(adminUsers.calls[0]).toMatchObject({
        orgId: body.id,
        orgType: 'reseller',
        resellerId: null,
        email: 'admin@example.com',
      });
    });

    it('denies a reseller actor — H3 is master-only', async () => {
      await createMaster();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        headers: signInternalHeaders(TEST_INTERNAL_SECRET, { orgType: 'reseller' }),
        payload: { slug: 'acme', name: 'Acme', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(403);
      expect(adminUsers.calls).toHaveLength(0);
    });

    it('rejects a duplicate slug with 409, and does not call identity-service twice', async () => {
      await createMaster();
      await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: { slug: 'acme', name: 'Acme', ...ADMIN_BODY },
      });

      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: { slug: 'acme', name: 'Acme Again', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'slug_taken' });
      expect(adminUsers.calls).toHaveLength(1);
    });

    it('rejects a malformed body with 400', async () => {
      await createMaster();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: {
          slug: 'A',
          name: '',
          adminEmail: '',
          adminDisplayName: '',
          adminPassword: 'short',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('reports 409 when the org was created but its admin email is already taken', async () => {
      await createMaster();
      adminUsers.fail = new AdminUserEmailTakenError('email taken');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers',
        payload: { slug: 'acme', name: 'Acme', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'admin_email_taken' });
      // The org row itself was still created — only the admin user failed.
      const created = await repo.findById(
        (await repo.listChildren((await repo.findMaster())!.id))[0]!.id,
      );
      expect(created?.slug).toBe('acme');
    });
  });

  describe('POST /v1/resellers/:id/tenants', () => {
    it('creates a tenant under the reseller, denormalizing resellerId onto the admin-user call', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/tenants`,
        payload: { slug: 'widgets', name: 'Widgets Inc', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ type: 'tenant', resellerId: reseller.id });
      expect(adminUsers.calls[0]).toMatchObject({ orgType: 'tenant', resellerId: reseller.id });
    });

    it('allows a reseller actor — tenant.create is not H3-restricted', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/tenants`,
        headers: signInternalHeaders(TEST_INTERNAL_SECRET, { orgType: 'reseller' }),
        payload: { slug: 'widgets', name: 'Widgets', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(201);
    });

    it('404s when the reseller does not exist', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/resellers/no-such-reseller/tenants',
        payload: { slug: 'widgets', name: 'Widgets', ...ADMIN_BODY },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /v1/resellers/:id/tenants — tenancy isolation', () => {
    it("only ever returns the named reseller's own tenants", async () => {
      const master = await createMaster();
      const resellerA = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-a',
        name: 'A',
      });
      const resellerB = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'reseller-b',
        name: 'B',
      });
      const tenantA = await repo.create({}, 'tenant', {
        parentId: resellerA.id,
        slug: 't-a',
        name: 'T A',
      });
      await repo.create({}, 'tenant', { parentId: resellerB.id, slug: 't-b', name: 'T B' });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/resellers/${resellerA.id}/tenants`,
      });

      expect(response.statusCode).toBe(200);
      const body: { rows: { id: string }[] } = response.json();
      expect(body.rows.map((row) => row.id)).toEqual([tenantA.id]);
    });
  });

  describe('PATCH /v1/resellers/:id and /v1/tenants/:id', () => {
    it('updates a reseller', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/resellers/${reseller.id}`,
        payload: { name: 'Renamed' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: 'Renamed' });
    });

    it('404s a reseller id used against the tenant path', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${reseller.id}`,
        payload: { name: 'Renamed' },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('suspend / resume', () => {
    it('suspends and resumes a tenant', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      const tenant = await repo.create({}, 'tenant', {
        parentId: reseller.id,
        slug: 'widgets',
        name: 'Widgets',
      });

      const suspend = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/suspend` });
      expect(suspend.statusCode).toBe(200);
      expect(suspend.json()).toMatchObject({ status: 'suspended' });

      const resume = await app.inject({ method: 'POST', url: `/v1/tenants/${tenant.id}/resume` });
      expect(resume.statusCode).toBe(200);
      expect(resume.json()).toMatchObject({ status: 'active' });
    });

    it('409s suspending an already-suspended reseller', async () => {
      const master = await createMaster();
      const reseller = await repo.create({}, 'reseller', {
        parentId: master.id,
        slug: 'acme',
        name: 'Acme',
      });
      await app.inject({ method: 'POST', url: `/v1/resellers/${reseller.id}/suspend` });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/resellers/${reseller.id}/suspend`,
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'invalid_status_transition' });
    });
  });

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerGrantRoutes } from '../src/routes/grants.routes.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { registerJwksRoute } from '../src/routes/jwks.routes.js';
import { createOrgAccess } from '../src/authz/org-access.js';
import { createPermissionLookup } from '../src/authz/permission-lookup.js';
import { registerRoleRoutes } from '../src/routes/roles.routes.js';
import { startHarness, TEST_TTL, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

const INTERNAL_TOKEN = 'test-internal-service-token';
const HEADER_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('identity-service HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: HEADER_SECRET },
    });
    registerAuthRoutes(app, h.auth);
    registerJwksRoute(app, createSigningKeyRepoFrom(h), TEST_TTL.signingKeyOverlapDays);
    registerInternalRoutes(app, h.users, h.roles, INTERNAL_TOKEN);
    const access = createOrgAccess({ lineage: () => Promise.resolve(undefined) });
    const lookup = createPermissionLookup(h.users, h.roles, h.grants);
    registerRoleRoutes(app, h.roles, access, h.users, lookup);
    registerGrantRoutes(app, h.grants, access, lookup);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await h.db.kysely.deleteFrom('sessions').execute();
    await h.db.kysely.deleteFrom('mfa_factors').execute();
    await h.db.kysely.deleteFrom('role_assignments').execute();
    await h.db.kysely.deleteFrom('users').execute();
    await h.db.kysely.deleteFrom('outbox').execute();
    await h.db.kysely.deleteFrom('grants').execute();
    await h.db.kysely.deleteFrom('role_permissions').execute();
    await h.db.kysely.deleteFrom('roles').execute();
  });

  it('emits no Server or X-Powered-By header', async () => {
    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.headers).not.toHaveProperty('server');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  describe('POST /v1/auth/login', () => {
    it('issues tokens for a tenant user with the right password', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { orgId, email: 'admin@example.com', password: 'correct horse battery staple' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });

    it('records the client address the gateway signed on the session, not its own (G-113)', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: signInternalHeaders(HEADER_SECRET, { clientIp: '203.0.113.9' }),
        remoteAddress: '10.0.0.2',
        payload: { orgId, email: 'admin@example.com', password: 'correct horse battery staple' },
      });

      expect(response.statusCode).toBe(200);
      const sessions = await h.db.kysely.selectFrom('sessions').select('ip').execute();
      expect(sessions).toEqual([{ ip: '203.0.113.9' }]);
    });

    it('returns problem+json for the wrong password, generically', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { orgId, email: 'admin@example.com', password: 'wrong' },
      });

      expect(response.statusCode).toBe(401);
      expect(response.headers['content-type']).toContain('application/problem+json');
      expect(response.json()).toMatchObject({ code: 'invalid_credentials' });
    });

    it('rejects a malformed body before it reaches the auth service', async () => {
      const response = await app.inject({ method: 'POST', url: '/v1/auth/login', payload: {} });

      expect(response.statusCode).toBe(400);
      expect(response.json<{ type: string }>().type).toBe('/problems/validation');
    });

    it('a master user gets an enrollment ticket, not tokens, over HTTP too', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'master');

      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { orgId, email: 'admin@example.com', password: 'correct horse battery staple' },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'mfa_enrollment_required' });
      expect(response.json()).not.toHaveProperty('accessToken');
    });
  });

  describe('POST /v1/auth/refresh', () => {
    it('detects reuse over HTTP and reports it as such', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');
      const login = await app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        payload: { orgId, email: 'admin@example.com', password: 'correct horse battery staple' },
      });
      const refreshToken = login.json<{ refreshToken: string }>().refreshToken;

      await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken } });
      const reused = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        payload: { refreshToken },
      });

      expect(reused.statusCode).toBe(401);
      expect(reused.json()).toMatchObject({ code: 'refresh_token_reused' });
    });
  });

  describe('POST /v1/auth/logout', () => {
    it('returns 204 with no body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/v1/auth/logout',
        payload: { refreshToken: 'whatever' },
      });

      expect(response.statusCode).toBe(204);
      expect(response.body).toBe('');
    });
  });

  describe('GET /.well-known/jwks.json', () => {
    it('serves the current public key, no private material, no auth needed', async () => {
      const response = await app.inject({ method: 'GET', url: '/.well-known/jwks.json' });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ keys: Record<string, unknown>[] }>();
      expect(body.keys).toHaveLength(1);
      expect(body.keys[0]).toMatchObject({ kty: 'OKP', crv: 'Ed25519', use: 'sig', alg: 'EdDSA' });
      expect(body.keys[0]).not.toHaveProperty('d');
      expect(JSON.stringify(body)).not.toMatch(/BEGIN PRIVATE KEY/);
    });
  });

  describe('GET /internal/v1/orgs/:orgId/admins (G-100)', () => {
    async function person(orgId: string, email: string, role?: string, disabled = false) {
      const user = await h.users.create(
        { requestId: 'test' },
        {
          orgId,
          orgType: 'tenant',
          resellerId: 'reseller-1',
          email,
          displayName: email.split('@')[0]!,
          password: 'correct horse battery staple',
        },
      );
      if (role !== undefined) await h.roles.assignRole(user.id, role, orgId);
      if (disabled) {
        await h.users.update({ requestId: 'test' }, orgId, user.id, { status: 'disabled' });
      }
      return user;
    }

    it("lists the org's active administrators, and nobody else", async () => {
      const orgId = crypto.randomUUID();
      const other = crypto.randomUUID();
      const ann = await person(orgId, 'ann@example.com', 'tenant_admin');
      const bea = await person(orgId, 'bea@example.com', 'tenant_admin');
      await person(orgId, 'cal@example.com', 'tenant_user');
      await person(orgId, 'dot@example.com');
      await person(orgId, 'eve@example.com', 'tenant_admin', true);
      await person(other, 'fay@example.com', 'tenant_admin');

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/orgs/${orgId}/admins`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        rows: [
          { userId: ann.id, email: 'ann@example.com', displayName: 'ann' },
          { userId: bea.id, email: 'bea@example.com', displayName: 'bea' },
        ],
      });
    });

    it('needs the internal service token', async () => {
      for (const headers of [{}, { authorization: 'Bearer not-the-token' }]) {
        const response = await app.inject({
          method: 'GET',
          url: `/internal/v1/orgs/${crypto.randomUUID()}/admins`,
          headers,
        });
        expect(response.statusCode).toBe(401);
      }
    });
  });

  describe('POST /internal/v1/orgs/:orgId/admin-user', () => {
    it('rejects a request with no bearer token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${crypto.randomUUID()}/admin-user`,
        payload: {
          orgType: 'tenant',
          email: 'a@example.com',
          displayName: 'A',
          password: 'x'.repeat(12),
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('rejects a request with the wrong bearer token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${crypto.randomUUID()}/admin-user`,
        headers: { authorization: 'Bearer not-the-token' },
        payload: {
          orgType: 'tenant',
          email: 'a@example.com',
          displayName: 'A',
          password: 'x'.repeat(12),
        },
      });

      expect(response.statusCode).toBe(401);
    });

    it('creates the user with the right token', async () => {
      const orgId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${orgId}/admin-user`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: {
          orgType: 'master',
          email: 'admin@example.com',
          displayName: 'Admin',
          password: 'correct horse battery staple',
        },
      });

      expect(response.statusCode).toBe(201);
      expect(response.json()).toMatchObject({ orgId, email: 'admin@example.com' });
      expect(response.json()).not.toHaveProperty('passwordHash');
    });

    it("gives the new person their org type's built-in admin role", async () => {
      for (const orgType of ['master', 'reseller', 'tenant'] as const) {
        const orgId = crypto.randomUUID();
        await createUserViaInternal(app, orgId, orgType);
        const userId = await userIdFor(h, orgId, 'admin@example.com');
        expect(await h.roles.roleIdsFor(userId)).toEqual([`${orgType}_admin`]);
      }
    });

    it('rejects a duplicate email in the same org with 409', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');

      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${orgId}/admin-user`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: {
          orgType: 'tenant',
          email: 'admin@example.com',
          displayName: 'Another',
          password: 'correct horse battery staple',
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'email_taken' });
    });

    it('with firstUserOnly, creates the first user of an empty org', async () => {
      const orgId = crypto.randomUUID();

      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${orgId}/admin-user`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: {
          orgType: 'master',
          email: 'first@example.com',
          displayName: 'First',
          password: 'correct horse battery staple',
          firstUserOnly: true,
        },
      });

      expect(response.statusCode).toBe(201);
      expect(await h.users.hasAnyInOrg(orgId)).toBe(true);
    });

    it('with firstUserOnly, refuses (409 org_has_users) once the org has anyone', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'master');

      const response = await app.inject({
        method: 'POST',
        url: `/internal/v1/orgs/${orgId}/admin-user`,
        headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
        payload: {
          orgType: 'master',
          email: 'second@example.com',
          displayName: 'Second',
          password: 'another long password',
          firstUserOnly: true,
        },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'org_has_users' });
      expect(await h.users.findByOrgAndEmail(orgId, 'second@example.com')).toBeUndefined();
    });
  });

  describe('GET/POST /v1/orgs/:orgId/roles', () => {
    it('lists the built-in roles even with no custom roles defined', async () => {
      const orgId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
      });

      expect(response.statusCode).toBe(200);
      const { rows } = response.json<{ rows: { id: string; builtIn: boolean }[] }>();
      expect(rows.every((role) => role.builtIn)).toBe(true);
      expect(rows.map((role) => role.id)).toContain('tenant_admin');
    });

    it('creates a custom role and then lists it alongside the built-ins', async () => {
      const orgId = crypto.randomUUID();

      const created = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
        payload: { name: 'billing-viewer', permissions: ['cdr.read'] },
      });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({
        name: 'billing-viewer',
        builtIn: false,
        permissions: ['cdr.read'],
      });

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
      });
      const { rows } = listed.json<{ rows: { name: string; builtIn: boolean }[] }>();
      expect(rows.some((role) => role.name === 'billing-viewer' && !role.builtIn)).toBe(true);
    });

    it('rejects a duplicate role name with 409', async () => {
      const orgId = crypto.randomUUID();
      await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
        payload: { name: 'dup', permissions: ['cdr.read'] },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
        payload: { name: 'dup', permissions: ['analytics.view'] },
      });

      expect(response.statusCode).toBe(409);
      expect(response.json()).toMatchObject({ code: 'role_name_taken' });
    });

    it('rejects a malformed body before it reaches the repo', async () => {
      const orgId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: await adminIn(orgId),
        payload: { name: '', permissions: [] },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('POST/DELETE /v1/orgs/:orgId/roles/:roleId/assignments', () => {
    it('assigns a built-in role to a user, then revokes it', async () => {
      const orgId = crypto.randomUUID();
      await createUserViaInternal(app, orgId, 'tenant');
      const userId = await userIdFor(h, orgId, 'admin@example.com');

      const assigned = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles/tenant_admin/assignments`,
        headers: await adminIn(orgId),
        payload: { userId },
      });
      expect(assigned.statusCode).toBe(204);
      expect(await h.roles.roleIdsFor(userId)).toEqual(['tenant_admin']);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/roles/tenant_admin/assignments`,
        headers: await adminIn(orgId),
        payload: { userId },
      });
      expect(revoked.statusCode).toBe(204);
      expect(await h.roles.roleIdsFor(userId)).toEqual([]);
    });
  });

  describe('GET/POST/DELETE /v1/orgs/:orgId/grants', () => {
    it('creates a grant, lists it, then deletes it', async () => {
      const orgId = crypto.randomUUID();

      const created = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/grants`,
        headers: await adminIn(orgId),
        payload: {
          principalType: 'user',
          principalId: 'u1',
          permission: 'cdr.export',
          scope: { type: 'org', id: orgId },
        },
      });
      expect(created.statusCode).toBe(201);
      const grantId = created.json<{ id: string }>().id;

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${orgId}/grants`,
        headers: await adminIn(orgId),
      });
      expect(listed.json<{ rows: unknown[] }>().rows).toHaveLength(1);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/grants/${grantId}`,
        headers: await adminIn(orgId),
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/orgs/${orgId}/grants`,
            headers: await adminIn(orgId),
          })
        ).json<{
          rows: unknown[];
        }>().rows,
      ).toEqual([]);
    });

    it('returns a problem+json 404 for a grant that does not exist', async () => {
      const orgId = crypto.randomUUID();
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/grants/${crypto.randomUUID()}`,
        headers: await adminIn(orgId),
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects an unknown scope type before it reaches the repo', async () => {
      const orgId = crypto.randomUUID();
      const response = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/grants`,
        headers: await adminIn(orgId),
        payload: {
          principalType: 'user',
          principalId: 'u1',
          permission: 'cdr.export',
          scope: { type: 'not-a-real-scope', id: 'x' },
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  /** A real, active tenant admin of [orgId], signed in as the gateway would forward them. */
  async function adminIn(orgId: string) {
    const email = 'operator@example.com';
    const existing = await h.users.findByOrgAndEmail(orgId, email);
    const user =
      existing ??
      (await h.users.create(
        { requestId: 'test' },
        {
          orgId,
          orgType: 'tenant',
          resellerId: null,
          email,
          displayName: 'Operator',
          password: 'correct horse battery staple',
        },
      ));
    await h.roles.assignRole(user.id, 'tenant_admin', orgId);
    return signInternalHeaders(HEADER_SECRET, {
      actorId: user.id,
      actorType: 'user',
      orgId,
      orgType: 'tenant',
      tenantId: orgId,
    });
  }

  async function createUserViaInternal(
    target: Server,
    orgId: string,
    orgType: 'master' | 'reseller' | 'tenant',
  ): Promise<void> {
    const response = await target.inject({
      method: 'POST',
      url: `/internal/v1/orgs/${orgId}/admin-user`,
      headers: { authorization: `Bearer ${INTERNAL_TOKEN}` },
      payload: {
        orgType,
        email: 'admin@example.com',
        displayName: 'Admin',
        password: 'correct horse battery staple',
      },
    });
    if (response.statusCode !== 201) {
      throw new Error(`setup failed: ${String(response.statusCode)} ${response.body}`);
    }
  }

  async function userIdFor(harness: Harness, orgId: string, email: string): Promise<string> {
    const user = await harness.users.findByOrgAndEmail(orgId, email);
    if (user === undefined) throw new Error(`no such user: ${email} in ${orgId}`);
    return user.id;
  }
});

function createSigningKeyRepoFrom(h: Harness) {
  // Re-derive the same repo the harness built, rather than reaching into it,
  // so this test file does not need to widen Harness's public shape just for
  // itself.
  return {
    forVerification: async (overlapDays: number) => {
      const { createSigningKeyRepo } = await import('../src/repo/signing-key.repo.js');
      return createSigningKeyRepo(h.db, h.kek).forVerification(overlapDays);
    },
  } as never;
}

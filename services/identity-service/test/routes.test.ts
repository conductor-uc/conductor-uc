import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerGrantRoutes } from '../src/routes/grants.routes.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { registerJwksRoute } from '../src/routes/jwks.routes.js';
import { createOrgAccess } from '../src/authz/org-access.js';
import { registerRoleRoutes } from '../src/routes/roles.routes.js';
import { startHarness, TEST_TTL, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

const INTERNAL_TOKEN = 'test-internal-service-token';
const HEADER_SECRET = 'test-internal-header-secret';

/** A signed-in tenant admin of [orgId]. */
function actorIn(orgId: string) {
  return signInternalHeaders(HEADER_SECRET, {
    actorId: 'actor-1',
    actorType: 'user',
    orgId,
    orgType: 'tenant',
    tenantId: orgId,
  });
}

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
    registerInternalRoutes(app, h.users, INTERNAL_TOKEN);
    registerRoleRoutes(
      app,
      h.roles,
      createOrgAccess({ lineage: () => Promise.resolve(undefined) }),
      h.users,
    );
    registerGrantRoutes(app, h.grants);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await h.db.kysely.deleteFrom('sessions').execute();
    await h.db.kysely.deleteFrom('mfa_factors').execute();
    await h.db.kysely.deleteFrom('users').execute();
    await h.db.kysely.deleteFrom('outbox').execute();
    await h.db.kysely.deleteFrom('grants').execute();
    await h.db.kysely.deleteFrom('role_assignments').execute();
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
  });

  describe('GET/POST /v1/orgs/:orgId/roles', () => {
    it('lists the built-in roles even with no custom roles defined', async () => {
      const orgId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${orgId}/roles`,
        headers: actorIn(orgId),
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
        headers: actorIn(orgId),
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
        headers: actorIn(orgId),
      });
      const { rows } = listed.json<{ rows: { name: string; builtIn: boolean }[] }>();
      expect(rows.some((role) => role.name === 'billing-viewer' && !role.builtIn)).toBe(true);
    });

    it('rejects a duplicate role name with 409', async () => {
      const orgId = crypto.randomUUID();
      await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: actorIn(orgId),
        payload: { name: 'dup', permissions: ['cdr.read'] },
      });

      const response = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${orgId}/roles`,
        headers: actorIn(orgId),
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
        headers: actorIn(orgId),
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
        headers: actorIn(orgId),
        payload: { userId },
      });
      expect(assigned.statusCode).toBe(204);
      expect(await h.roles.roleIdsFor(userId)).toEqual(['tenant_admin']);

      const revoked = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/roles/tenant_admin/assignments`,
        headers: actorIn(orgId),
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
        payload: {
          principalType: 'user',
          principalId: 'u1',
          permission: 'cdr.export',
          scope: { type: 'org', id: orgId },
        },
      });
      expect(created.statusCode).toBe(201);
      const grantId = created.json<{ id: string }>().id;

      const listed = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/grants` });
      expect(listed.json<{ rows: unknown[] }>().rows).toHaveLength(1);

      const deleted = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${orgId}/grants/${grantId}`,
      });
      expect(deleted.statusCode).toBe(204);
      expect(
        (await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/grants` })).json<{
          rows: unknown[];
        }>().rows,
      ).toEqual([]);
    });

    it('returns a problem+json 404 for a grant that does not exist', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${crypto.randomUUID()}/grants/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(404);
      expect(response.headers['content-type']).toContain('application/problem+json');
    });

    it('rejects an unknown scope type before it reaches the repo', async () => {
      const response = await app.inject({
        method: 'POST',
        url: `/v1/orgs/${crypto.randomUUID()}/grants`,
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

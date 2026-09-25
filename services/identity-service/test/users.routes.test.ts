import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerUserRoutes } from '../src/routes/users.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const PASSWORD = 'correct horse battery staple';

interface UserBody {
  id: string;
  email: string;
  displayName: string;
  status: 'active' | 'disabled';
  mfaEnrolled: boolean;
  lastLoginAt: string | null;
  roleIds: string[];
}

describe.skipIf(skipReason !== undefined)('users routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerAuthRoutes(app, h.auth, { cookieSecure: true, refreshTokenTtlDays: 30 });
    registerUserRoutes(
      app,
      h.users,
      h.roles,
      createOrgAccess({ lineage: () => Promise.resolve(undefined) }),
      h.mfa,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of [
      'sessions',
      'role_assignments',
      'mfa_factors',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  function makeUser(orgId: string, email: string, displayName = 'Someone') {
    return h.users.create(
      { requestId: 'test' },
      { orgId, orgType: 'tenant', resellerId: null, email, displayName, password: PASSWORD },
    );
  }

  function asUser(orgId: string, actorId: string) {
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType: 'tenant',
      tenantId: orgId,
    });
  }

  it('every route declares user.read (reads) or user.manage (writes) and the config data class (CLAUDE.md rule 3, G-10)', () => {
    const routes = app.registeredRoutes.filter((r) => r.url.includes('/users'));
    expect(routes.length).toBeGreaterThanOrEqual(2);
    for (const route of routes) {
      const expected =
        route.method === 'GET' || route.method === 'HEAD' ? 'user.read' : 'user.manage';
      expect(route.permission, `${route.method} ${route.url}`).toBe(expected);
      expect(route.dataClass, `${route.method} ${route.url}`).toBe('config');
    }
  });

  it("lists the org's users with their roles, and only them", async () => {
    const orgId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com', 'Admin');
    const bob = await makeUser(orgId, 'bob@example.com', 'Bob');
    await makeUser(other, 'outsider@example.com');
    await h.roles.assignRole(admin.id, 'tenant_admin', orgId);
    await h.roles.assignRole(bob.id, 'tenant_user', orgId);
    // A role held in another org does not show here.
    await h.roles.assignRole(bob.id, 'tenant_supervisor', other);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${orgId}/users`,
      headers: asUser(orgId, admin.id),
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ rows: UserBody[] }>().rows;
    expect(rows.map((r) => r.email)).toEqual(['admin@example.com', 'bob@example.com']);
    expect(rows[0]).toMatchObject({
      displayName: 'Admin',
      status: 'active',
      mfaEnrolled: false,
      lastLoginAt: null,
      roleIds: ['tenant_admin'],
    });
    expect(rows[1]?.roleIds).toEqual(['tenant_user']);
    // Nothing secret comes back.
    expect(JSON.stringify(rows)).not.toContain('password');
  });

  it("refuses another org's users, and a caller who is not signed in", async () => {
    const orgId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const victim = await makeUser(other, 'victim@example.com');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${other}/users`,
      headers: asUser(orgId, admin.id),
    });
    expect(list.statusCode).toBe(403);
    expect(list.json<{ code: string }>().code).toBe('users_other_org');

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${other}/users/${victim.id}`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode).toBe(403);
    expect((await h.users.findById(victim.id))?.status).toBe('active');

    const anonymous = await app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/users` });
    expect(anonymous.statusCode).toBe(401);
  });

  it("renames a user, and 404s one who is not in the caller's org", async () => {
    const orgId = crypto.randomUUID();
    const other = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const bob = await makeUser(orgId, 'bob@example.com', 'Bob');
    const outsider = await makeUser(other, 'outsider@example.com');

    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${bob.id}`,
      headers: asUser(orgId, admin.id),
      payload: { displayName: 'Robert' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json<UserBody>()).toMatchObject({ displayName: 'Robert', status: 'active' });

    // A user id from another org, asked for through the caller's own org.
    const missing = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${outsider.id}`,
      headers: asUser(orgId, admin.id),
      payload: { displayName: 'Nope' },
    });
    expect(missing.statusCode).toBe(404);
    expect((await h.users.findById(outsider.id))?.displayName).toBe('Someone');
  });

  it('refuses a blank name', async () => {
    const orgId = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${admin.id}`,
      headers: asUser(orgId, admin.id),
      payload: { displayName: '' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('will not let someone disable their own account', async () => {
    const orgId = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const response = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${admin.id}`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'disabled' },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('cannot_disable_self');
    expect((await h.users.findById(admin.id))?.status).toBe('active');
  });

  it('disabling ends their sessions and stops sign-in; enabling restores it', async () => {
    const orgId = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const bob = await makeUser(orgId, 'bob@example.com');
    const login = () =>
      app.inject({
        method: 'POST',
        url: '/v1/auth/login',
        headers: { 'x-refresh-transport': 'cookie' },
        payload: { orgId, email: 'bob@example.com', password: PASSWORD },
      });

    const signedIn = await login();
    expect(signedIn.statusCode).toBe(200);
    const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;

    const disabled = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${bob.id}`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'disabled' },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json<UserBody>().status).toBe('disabled');

    expect((await login()).statusCode).toBe(401);
    const refreshed = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { cookie, 'x-refresh-transport': 'cookie' },
      payload: {},
    });
    expect(refreshed.statusCode).toBe(401);

    const enabled = await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${bob.id}`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'active' },
    });
    expect(enabled.json<UserBody>().status).toBe('active');
    expect((await login()).statusCode).toBe(200);
  });

  it('publishes identity.user.updated with the new status, in the same transaction', async () => {
    const orgId = crypto.randomUUID();
    const admin = await makeUser(orgId, 'admin@example.com');
    const bob = await makeUser(orgId, 'bob@example.com');
    await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/${bob.id}`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'disabled' },
    });
    // A refused change leaves no event.
    await app.inject({
      method: 'PATCH',
      url: `/v1/orgs/${orgId}/users/nobody`,
      headers: asUser(orgId, admin.id),
      payload: { status: 'disabled' },
    });

    const rows = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    const updated = rows.filter((r) => r.type === 'identity.user.updated');
    expect(updated).toHaveLength(1);
    // The driver returns a json column parsed or as text.
    const payload: unknown = updated[0]!.payload;
    expect(typeof payload === 'string' ? JSON.parse(payload) : payload).toEqual({
      userId: bob.id,
      orgId,
      status: 'disabled',
    });
    expect(updated[0]?.actor_id).toBe(admin.id);
  });
});

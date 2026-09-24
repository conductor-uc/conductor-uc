import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerMeRoutes } from '../src/routes/me.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';

interface MeBody {
  userId: string;
  orgId: string;
  orgType: string;
  roleIds: string[];
  permissions: string[];
}

describe.skipIf(skipReason !== undefined)('GET /v1/orgs/:orgId/me', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerMeRoutes(app, h.roles, h.grants);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of [
      'grants',
      'role_assignments',
      'role_permissions',
      'roles',
      'users',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  /** A real user, since role assignments reference one. */
  async function makeUser(orgId: string, orgType: 'master' | 'reseller' | 'tenant', email: string) {
    const user = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType,
        resellerId: null,
        email,
        displayName: email,
        password: 'correct horse battery staple',
      },
    );
    return user.id;
  }

  function asUser(actorId: string, orgId: string, orgType: 'master' | 'reseller' | 'tenant') {
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType,
      ...(orgType === 'tenant' ? { tenantId: orgId } : {}),
    });
  }

  it('declares org.view and the config data class (CLAUDE.md rule 3)', () => {
    const route = app.registeredRoutes.find((r) => r.url === '/v1/orgs/:orgId/me');
    expect(route).toMatchObject({ permission: 'org.view', dataClass: 'config' });
  });

  it("returns the permissions of the user's built-in roles", async () => {
    const u1 = await makeUser('org-1', 'tenant', 'u1@example.test');
    await h.roles.assignRole(u1, 'tenant_admin', 'org-1');
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/org-1/me',
      headers: asUser(u1, 'org-1', 'tenant'),
    });

    expect(response.statusCode).toBe(200);
    const body = response.json<MeBody>();
    expect(body).toMatchObject({ userId: u1, orgId: 'org-1', orgType: 'tenant' });
    expect(body.roleIds).toEqual(['tenant_admin']);
    expect(body.permissions).toContain('extension.manage');
    expect(body.permissions).toContain('callflow.publish');
    // A tenant admin cannot manage resellers or brands.
    expect(body.permissions).not.toContain('reseller.manage');
    expect(body.permissions).not.toContain('brand.manage');
    expect(body.permissions).toEqual([...body.permissions].sort());
  });

  it('a user with no role has nothing to show', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/org-1/me',
      headers: asUser('nobody', 'org-1', 'tenant'),
    });
    expect(response.json<MeBody>().permissions).toEqual([]);
  });

  it("adds a custom role's permissions and any grant, whatever its scope", async () => {
    const role = await h.roles.createCustomRole('org-1', 'Front desk', ['did.manage']);
    const u2 = await makeUser('org-1', 'tenant', 'u2@example.test');
    await h.roles.assignRole(u2, role.id, 'org-1');
    await h.grants.create('org-1', 'user', u2, 'cdr.read', { type: 'org', id: 'org-1' });
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/orgs/org-1/me',
        headers: asUser(u2, 'org-1', 'tenant'),
      })
    ).json<MeBody>();
    expect(body.permissions).toEqual(['cdr.read', 'did.manage']);
  });

  it('the master holds everything the catalog defines', async () => {
    const m1 = await makeUser('master-org', 'master', 'm1@example.test');
    await h.roles.assignRole(m1, 'master_admin', 'master-org');
    const body = (
      await app.inject({
        method: 'GET',
        url: '/v1/orgs/master-org/me',
        headers: asUser(m1, 'master-org', 'master'),
      })
    ).json<MeBody>();
    expect(body.permissions).toContain('reseller.create');
    expect(body.permissions).toContain('audit.read');
  });

  it("refuses asking about someone else's org, and needs a signed-in actor", async () => {
    const other = await app.inject({
      method: 'GET',
      url: '/v1/orgs/org-2/me',
      headers: asUser('u1', 'org-1', 'tenant'),
    });
    expect(other.statusCode).toBe(403);
    const anonymous = await app.inject({ method: 'GET', url: '/v1/orgs/org-1/me' });
    expect(anonymous.statusCode).toBe(401);
  });
});

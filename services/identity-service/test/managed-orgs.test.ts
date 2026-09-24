import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import {
  createOrgClient,
  OrgClientError,
  type OrgClient,
  type OrgLineage,
} from '../src/org-client.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerRoleRoutes } from '../src/routes/roles.routes.js';
import { registerUserRoutes } from '../src/routes/users.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const PASSWORD = 'correct horse battery staple';

// The org tree org-service would answer for: a master, two resellers, and a
// tenant under each.
const MASTER = 'org-master';
const ACME = 'org-acme';
const OTHER = 'org-other';
const ACME_TENANT = 'org-acme-dental';
const OTHER_TENANT = 'org-other-cafe';

const TREE = new Map<string, OrgLineage>([
  [MASTER, { orgId: MASTER, type: 'master', parentId: null, resellerId: null }],
  [ACME, { orgId: ACME, type: 'reseller', parentId: MASTER, resellerId: ACME }],
  [OTHER, { orgId: OTHER, type: 'reseller', parentId: MASTER, resellerId: OTHER }],
  [ACME_TENANT, { orgId: ACME_TENANT, type: 'tenant', parentId: ACME, resellerId: ACME }],
  [OTHER_TENANT, { orgId: OTHER_TENANT, type: 'tenant', parentId: OTHER, resellerId: OTHER }],
]);

interface UserBody {
  id: string;
  email: string;
  status: 'active' | 'disabled';
  roleIds: string[];
}

describe.skipIf(skipReason !== undefined)('managing the users of orgs beneath you', () => {
  let h: Harness;
  let app: Server;
  let lookups: string[] = [];
  let down = false;

  beforeAll(async () => {
    h = await startHarness();
    const orgClient: Pick<OrgClient, 'lineage'> = {
      lineage(orgId) {
        lookups.push(orgId);
        if (down) return Promise.reject(new OrgClientError('org-service is down'));
        return Promise.resolve(TREE.get(orgId));
      },
    };
    const access = createOrgAccess(orgClient);
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerAuthRoutes(app, h.auth, {
      cookieSecure: true,
      refreshTokenTtlDays: 30,
      orgClient: { ...orgClient, signInScope: () => Promise.resolve(undefined) },
    });
    registerUserRoutes(app, h.users, h.roles, access);
    registerRoleRoutes(app, h.roles, access, h.users);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    down = false;
    for (const table of [
      'sessions',
      'role_assignments',
      'mfa_factors',
      'invitations',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  afterEach(() => {
    lookups = [];
  });

  function makeUser(orgId: string, email: string) {
    const lineage = TREE.get(orgId)!;
    return h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: lineage.type,
        resellerId: lineage.type === 'tenant' ? lineage.resellerId : null,
        email,
        displayName: email,
        password: PASSWORD,
      },
    );
  }

  /** A signed-in user of [orgId], as the gateway would forward them. */
  function actorIn(orgId: string, actorId = 'actor-1') {
    const lineage = TREE.get(orgId)!;
    return signInternalHeaders(SECRET, {
      actorId,
      actorType: 'user',
      orgId,
      orgType: lineage.type,
      ...(lineage.type === 'tenant' && lineage.resellerId !== null
        ? { resellerId: lineage.resellerId }
        : {}),
    });
  }

  const listUsers = (orgId: string, as: string) =>
    app.inject({ method: 'GET', url: `/v1/orgs/${orgId}/users`, headers: actorIn(as) });

  describe('reading and changing users', () => {
    it("a reseller lists its own tenant's people", async () => {
      await makeUser(ACME_TENANT, 'front@dental.test');
      const response = await listUsers(ACME_TENANT, ACME);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ rows: UserBody[] }>().rows.map((r) => r.email)).toEqual([
        'front@dental.test',
      ]);
    });

    it("a reseller disables a tenant's user, which ends their sessions and sign-in", async () => {
      const user = await makeUser(ACME_TENANT, 'front@dental.test');
      const login = () =>
        app.inject({
          method: 'POST',
          url: '/v1/auth/login',
          headers: { 'x-refresh-transport': 'cookie' },
          payload: { orgId: ACME_TENANT, email: 'front@dental.test', password: PASSWORD },
        });
      const signedIn = await login();
      expect(signedIn.statusCode).toBe(200);
      const cookie = String(signedIn.headers['set-cookie']).split(';')[0]!;

      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/orgs/${ACME_TENANT}/users/${user.id}`,
        headers: actorIn(ACME),
        payload: { status: 'disabled' },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json<UserBody>().status).toBe('disabled');
      expect((await login()).statusCode).toBe(401);
      const refreshed = await app.inject({
        method: 'POST',
        url: '/v1/auth/refresh',
        headers: { cookie, 'x-refresh-transport': 'cookie' },
        payload: {},
      });
      expect(refreshed.statusCode).toBe(401);
    });

    it('the master reaches a reseller and any tenant', async () => {
      await makeUser(ACME, 'owner@acme.test');
      await makeUser(OTHER_TENANT, 'cafe@other.test');
      expect((await listUsers(ACME, MASTER)).statusCode).toBe(200);
      expect((await listUsers(OTHER_TENANT, MASTER)).statusCode).toBe(200);
    });

    it("a reseller cannot reach another reseller's tenant, that reseller, or the master", async () => {
      const victim = await makeUser(OTHER_TENANT, 'cafe@other.test');
      for (const target of [OTHER_TENANT, OTHER, MASTER]) {
        const response = await listUsers(target, ACME);
        expect(response.statusCode, target).toBe(403);
        expect(response.json<{ code: string }>().code).toBe('users_other_org');
      }
      const patch = await app.inject({
        method: 'PATCH',
        url: `/v1/orgs/${OTHER_TENANT}/users/${victim.id}`,
        headers: actorIn(ACME),
        payload: { status: 'disabled' },
      });
      expect(patch.statusCode).toBe(403);
      expect((await h.users.findById(victim.id))?.status).toBe('active');
    });

    it('an org that does not exist is refused the same way as one you may not reach', async () => {
      const missing = await listUsers('org-nobody', ACME);
      const forbidden = await listUsers(OTHER_TENANT, ACME);
      expect(missing.statusCode).toBe(403);
      const shape = (r: typeof missing) => {
        const { code, detail, status, title } = r.json<Record<string, unknown>>();
        return { code, detail, status, title };
      };
      expect(shape(missing)).toEqual(shape(forbidden));
    });

    it('a tenant reaches only its own org, without asking org-service', async () => {
      await makeUser(ACME_TENANT, 'front@dental.test');
      lookups = [];
      expect((await listUsers(ACME_TENANT, ACME_TENANT)).statusCode).toBe(200);
      expect((await listUsers(OTHER_TENANT, ACME_TENANT)).statusCode).toBe(403);
      expect((await listUsers(ACME, ACME_TENANT)).statusCode).toBe(403);
      expect(lookups).toEqual([]);
    });

    it("a reseller's own org needs no lookup either", async () => {
      await makeUser(ACME, 'owner@acme.test');
      lookups = [];
      expect((await listUsers(ACME, ACME)).statusCode).toBe(200);
      expect(lookups).toEqual([]);
    });

    it('a user from another org cannot be reached through a descendant org', async () => {
      const outsider = await makeUser(OTHER_TENANT, 'cafe@other.test');
      const response = await app.inject({
        method: 'PATCH',
        url: `/v1/orgs/${ACME_TENANT}/users/${outsider.id}`,
        headers: actorIn(ACME),
        payload: { displayName: 'Hijacked' },
      });
      expect(response.statusCode).toBe(404);
    });

    it('says so, and changes nothing, when org-service cannot be reached', async () => {
      down = true;
      const response = await listUsers(ACME_TENANT, ACME);
      expect(response.statusCode).toBe(503);
      // A reseller's own org still works while org-service is down.
      expect((await listUsers(ACME, ACME)).statusCode).toBe(200);
    });
  });

  describe('inviting into a descendant org', () => {
    const invite = (target: string, as: string, email = 'new@dental.test') =>
      app.inject({
        method: 'POST',
        url: `/v1/orgs/${target}/invitations`,
        headers: actorIn(as),
        payload: { email, displayName: 'New Person' },
      });

    it("a reseller invites into a tenant: the invitation is the tenant's, under the reseller", async () => {
      const response = await invite(ACME_TENANT, ACME);
      expect(response.statusCode).toBe(201);
      const row = await h.db.kysely.selectFrom('invitations').selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({
        org_id: ACME_TENANT,
        org_type: 'tenant',
        reseller_id: ACME,
        email: 'new@dental.test',
      });
    });

    it('the master invites into a reseller', async () => {
      const response = await invite(ACME, MASTER, 'new@acme.test');
      expect(response.statusCode).toBe(201);
      const row = await h.db.kysely.selectFrom('invitations').selectAll().executeTakeFirstOrThrow();
      expect(row).toMatchObject({ org_id: ACME, org_type: 'reseller', reseller_id: null });
    });

    it("refuses another reseller's tenant, and a tenant inviting anywhere but home", async () => {
      expect((await invite(OTHER_TENANT, ACME)).statusCode).toBe(403);
      expect((await invite(OTHER_TENANT, ACME_TENANT)).statusCode).toBe(403);
      expect((await invite(ACME, ACME_TENANT)).statusCode).toBe(403);
      expect(await h.db.kysely.selectFrom('invitations').selectAll().execute()).toHaveLength(0);
    });
  });

  describe('assigning roles in a descendant org', () => {
    const assign = (org: string, as: string, userId: string, method: 'POST' | 'DELETE' = 'POST') =>
      app.inject({
        method,
        url: `/v1/orgs/${org}/roles/tenant_user/assignments`,
        headers: actorIn(as),
        payload: { userId },
      });

    it("a reseller assigns and revokes a role for a tenant's user", async () => {
      const user = await makeUser(ACME_TENANT, 'front@dental.test');
      expect((await assign(ACME_TENANT, ACME, user.id)).statusCode).toBe(204);
      expect(
        (await listUsers(ACME_TENANT, ACME)).json<{ rows: UserBody[] }>().rows[0]?.roleIds,
      ).toEqual(['tenant_user']);
      expect((await assign(ACME_TENANT, ACME, user.id, 'DELETE')).statusCode).toBe(204);
    });

    it("refuses another reseller's tenant, and a user who is not in the org", async () => {
      const mine = await makeUser(ACME_TENANT, 'front@dental.test');
      const theirs = await makeUser(OTHER_TENANT, 'cafe@other.test');
      expect((await assign(OTHER_TENANT, ACME, theirs.id)).statusCode).toBe(403);
      expect((await assign(ACME_TENANT, ACME, theirs.id)).statusCode).toBe(404);
      expect((await assign(ACME_TENANT, ACME, 'no-such-user')).statusCode).toBe(404);
      const roles = await h.roles.roleIdsByUserIn(ACME_TENANT);
      expect(roles.get(mine.id)).toBeUndefined();
      expect((await h.roles.roleIdsByUserIn(OTHER_TENANT)).get(theirs.id)).toBeUndefined();
    });

    it("listing another org's roles is refused too", async () => {
      const own = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${ACME_TENANT}/roles`,
        headers: actorIn(ACME),
      });
      expect(own.statusCode).toBe(200);
      const other = await app.inject({
        method: 'GET',
        url: `/v1/orgs/${OTHER_TENANT}/roles`,
        headers: actorIn(ACME),
      });
      expect(other.statusCode).toBe(403);
    });
  });
});

describe('the org client remembers where an org sits', () => {
  const body: OrgLineage = {
    orgId: 'org-1',
    type: 'tenant',
    parentId: 'org-r',
    resellerId: 'org-r',
  };

  function client(answer: () => Response) {
    const calls: string[] = [];
    const orgClient = createOrgClient({
      baseUrl: 'http://org.test/',
      internalServiceToken: 'token',
      fetchImpl: ((url: string, init?: RequestInit) => {
        calls.push(`${url} ${String((init?.headers as Record<string, string>).authorization)}`);
        return Promise.resolve(answer());
      }) as typeof fetch,
    });
    return { orgClient, calls };
  }

  it('asks once for an org that exists, with the service token', async () => {
    const { orgClient, calls } = client(() => Response.json(body));
    expect(await orgClient.lineage('org-1')).toEqual(body);
    expect(await orgClient.lineage('org-1')).toEqual(body);
    expect(calls).toEqual(['http://org.test/internal/v1/orgs/org-1/lineage Bearer token']);
  });

  it('asks again for an org it was told does not exist, because it may be created', async () => {
    const { orgClient, calls } = client(() => new Response(null, { status: 404 }));
    expect(await orgClient.lineage('org-2')).toBeUndefined();
    expect(await orgClient.lineage('org-2')).toBeUndefined();
    expect(calls).toHaveLength(2);
  });

  it('fails loudly rather than guessing when org-service errors', async () => {
    const { orgClient } = client(() => new Response(null, { status: 500 }));
    await expect(orgClient.lineage('org-3')).rejects.toBeInstanceOf(OrgClientError);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import { createPermissionLookup } from '../src/authz/permission-lookup.js';
import { registerAuthRoutes } from '../src/routes/auth.routes.js';
import { registerGrantRoutes } from '../src/routes/grants.routes.js';
import { registerMeRoutes } from '../src/routes/me.routes.js';
import { registerPermissionsInternalRoutes } from '../src/routes/permissions.routes.js';
import { registerRoleRoutes } from '../src/routes/roles.routes.js';
import { registerUserRoutes } from '../src/routes/users.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TOKEN = 'test-internal-service-token';
const PASSWORD = 'correct horse battery staple';

/**
 * Parity 1e: ordinary people get a login, so the API has to refuse what their
 * role does not carry: the per-request permission guard is on here, exactly as
 * in `main.ts`, and the routes that manage people, roles and grants must not
 * let a self-scoped user (`tenant_user`) raise their own access.
 */
describe.skipIf(skipReason !== undefined)('self-service: authorization in identity-service', () => {
  let h: Harness;
  let app: Server;
  let n = 0;

  beforeAll(async () => {
    h = await startHarness();
    const lookup = createPermissionLookup(h.users, h.roles, h.grants);
    const access = createOrgAccess({ lineage: () => Promise.resolve(undefined) });
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      permissions: async (actor, permission) =>
        (await lookup.ofUser(actor.id, actor.orgId)).has(permission),
    });
    registerAuthRoutes(app, h.auth, { cookieSecure: true, refreshTokenTtlDays: 30 });
    registerUserRoutes(app, h.users, h.roles, access, h.mfa);
    registerRoleRoutes(app, h.roles, access, h.users, lookup);
    registerGrantRoutes(app, h.grants, access, lookup);
    registerMeRoutes(app, h.roles, h.grants);
    registerPermissionsInternalRoutes(app, lookup, TOKEN);
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
      'grants',
      'role_permissions',
      'roles',
      'mfa_factors',
      'invitations',
      'users',
      'outbox',
    ] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  async function person(orgId: string, roleId: string | undefined, orgType = 'tenant' as const) {
    n += 1;
    const user = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType,
        resellerId: null,
        email: `person${String(n)}@example.com`,
        displayName: `Person ${String(n)}`,
        password: PASSWORD,
      },
    );
    if (roleId !== undefined) await h.roles.assignRole(user.id, roleId, orgId);
    return {
      id: user.id,
      as: signInternalHeaders(SECRET, {
        actorId: user.id,
        actorType: 'user',
        orgId,
        orgType,
        tenantId: orgId,
      }),
    };
  }

  const call = async (
    method: 'GET' | 'POST' | 'DELETE' | 'PATCH',
    url: string,
    headers: Record<string, string>,
    payload?: object,
  ) => {
    const response = await app.inject({
      method,
      url,
      headers,
      ...(payload === undefined ? {} : { payload }),
    });
    return response;
  };

  describe('GET /internal/v1/orgs/:orgId/users/:userId/permissions', () => {
    const url = (orgId: string, userId: string) =>
      `/internal/v1/orgs/${orgId}/users/${userId}/permissions`;
    const auth = { authorization: `Bearer ${TOKEN}` };

    it('needs the internal service token', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      expect((await call('GET', url(org, u.id), {})).statusCode).toBe(401);
      expect((await call('GET', url(org, u.id), { authorization: 'Bearer nope' })).statusCode).toBe(
        401,
      );
    });

    it('a tenant_user holds only the self-service permissions and what everyone holds', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const response = await call('GET', url(org, u.id), auth);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        permissions: [
          'monitor.presence',
          'org.view',
          'self.history',
          'self.settings',
          'self.voicemail',
        ],
      });
    });

    it('holds nothing (404) for a person in another org, a disabled person, or nobody', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_admin');
      expect((await call('GET', url(crypto.randomUUID(), u.id), auth)).statusCode).toBe(404);
      expect((await call('GET', url(org, crypto.randomUUID()), auth)).statusCode).toBe(404);
      await h.users.update({ requestId: 't' }, org, u.id, { status: 'disabled' });
      expect((await call('GET', url(org, u.id), auth)).statusCode).toBe(404);
    });

    it('ignores a role assigned in some other org, and a grant that is not org-wide', async () => {
      const org = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      const u = await person(org, undefined);
      await h.roles.assignRole(u.id, 'tenant_admin', elsewhere);
      await h.grants.create(org, 'user', u.id, 'cdr.read', { type: 'extension', id: 'ext-1' });
      expect((await call('GET', url(org, u.id), auth)).statusCode).toBe(404);

      await h.grants.create(org, 'user', u.id, 'cdr.export', { type: 'org', id: org });
      const response = await call('GET', url(org, u.id), auth);
      expect(response.json()).toEqual({ permissions: ['cdr.export'] });
    });

    it('includes a custom role and its permissions', async () => {
      const org = crypto.randomUUID();
      const role = await h.roles.createCustomRole(org, 'reader', ['cdr.read']);
      const u = await person(org, role.id);
      expect((await call('GET', url(org, u.id), auth)).json()).toEqual({
        permissions: ['cdr.read'],
      });
    });

    it('includes the read twin of every management permission held, by role or org-wide grant (G-10)', async () => {
      const org = crypto.randomUUID();
      const role = await h.roles.createCustomRole(org, 'front desk', ['did.manage']);
      const u = await person(org, role.id);
      await h.grants.create(org, 'user', u.id, 'callflow.edit', { type: 'org', id: org });
      expect((await call('GET', url(org, u.id), auth)).json()).toEqual({
        permissions: ['callflow.edit', 'callflow.read', 'did.manage', 'did.read'],
      });
    });
  });

  describe('read permissions (G-10)', () => {
    it('a custom role with only user.manage still lists users, with no re-granting', async () => {
      const org = crypto.randomUUID();
      const role = await h.roles.createCustomRole(org, 'people', ['user.manage']);
      const u = await person(org, role.id);
      expect((await call('GET', `/v1/orgs/${org}/users`, u.as)).statusCode).toBe(200);
    });

    it('a custom role with only user.read lists users but cannot change one', async () => {
      const org = crypto.randomUUID();
      const role = await h.roles.createCustomRole(org, 'viewer', ['user.read', 'role.read']);
      const u = await person(org, role.id);
      const other = await person(org, undefined);
      expect((await call('GET', `/v1/orgs/${org}/users`, u.as)).statusCode).toBe(200);
      expect((await call('GET', `/v1/orgs/${org}/roles`, u.as)).statusCode).toBe(200);
      const patch = await call('PATCH', `/v1/orgs/${org}/users/${other.id}`, u.as, {
        status: 'disabled',
      });
      expect(patch.statusCode).toBe(403);
      expect(patch.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('a tenant admin may put a read permission it holds only by implication into a custom role', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const response = await call('POST', `/v1/orgs/${org}/roles`, admin.as, {
        name: 'Viewer',
        permissions: ['extension.read', 'trunk.read'],
      });
      expect(response.statusCode).toBe(201);
    });
  });

  describe('a tenant_user cannot manage people, roles, grants or invitations', () => {
    it.each([
      ['GET', (o: string) => `/v1/orgs/${o}/users`],
      ['GET', (o: string) => `/v1/orgs/${o}/roles`],
      ['GET', (o: string) => `/v1/orgs/${o}/grants`],
    ] as const)('%s %s is 403', async (method, path) => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const response = await call(method, path(org), u.as);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('cannot give themselves (or anyone) a role', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const other = await person(org, undefined);
      for (const userId of [u.id, other.id]) {
        const response = await call(
          'POST',
          `/v1/orgs/${org}/roles/tenant_admin/assignments`,
          u.as,
          { userId },
        );
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'permission_denied' });
      }
      expect(await h.roles.roleIdsFor(u.id)).toEqual(['tenant_user']);
      expect(await h.roles.roleIdsFor(other.id)).toEqual([]);
    });

    it('cannot create a role, a grant or an invitation, or enable or rename anyone', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const other = await person(org, undefined);
      const attempts = [
        call('POST', `/v1/orgs/${org}/roles`, u.as, {
          name: 'mine',
          permissions: ['self.settings'],
        }),
        call('POST', `/v1/orgs/${org}/grants`, u.as, {
          principalType: 'user',
          principalId: u.id,
          permission: 'cdr.read',
          scope: { type: 'org', id: org },
        }),
        call('POST', `/v1/orgs/${org}/invitations`, u.as, {
          email: 'friend@example.com',
          displayName: 'Friend',
        }),
        call('PATCH', `/v1/orgs/${org}/users/${other.id}`, u.as, { displayName: 'Renamed' }),
      ];
      for (const response of await Promise.all(attempts)) {
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({ code: 'permission_denied' });
      }
      expect(await h.roles.listCustomRoles(org)).toEqual([]);
      expect(await h.grants.listForOrg(org)).toEqual([]);
    });

    it('cannot reach another tenant even by naming it', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const response = await call('GET', `/v1/orgs/${crypto.randomUUID()}/me`, u.as);
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'me_other_org' });
    });

    it('can still ask what they may do (org.view), and gets exactly the self-service set', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, 'tenant_user');
      const response = await call('GET', `/v1/orgs/${org}/me`, u.as);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ permissions: string[] }>().permissions).toEqual([
        'monitor.presence',
        'org.view',
        'self.history',
        'self.settings',
        'self.voicemail',
      ]);
    });

    it('a person with no role at all can still call /me, and holds nothing', async () => {
      const org = crypto.randomUUID();
      const u = await person(org, undefined);
      const response = await call('GET', `/v1/orgs/${org}/me`, u.as);
      expect(response.statusCode).toBe(200);
      expect(response.json<{ permissions: string[] }>().permissions).toEqual([]);
      expect((await call('GET', `/v1/orgs/${org}/users`, u.as)).statusCode).toBe(403);
    });

    it('a disabled admin with a still-valid token is refused', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const boss = await person(org, 'tenant_admin');
      expect((await call('GET', `/v1/orgs/${org}/users`, admin.as)).statusCode).toBe(200);
      await h.users.update({ requestId: 't' }, org, admin.id, { status: 'disabled' });
      expect((await call('GET', `/v1/orgs/${org}/users`, admin.as)).statusCode).toBe(403);
      expect((await call('GET', `/v1/orgs/${org}/users`, boss.as)).statusCode).toBe(200);
    });
  });

  describe('an administrator cannot escalate either', () => {
    it('cannot change their own roles, giving or taking', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const add = await call(
        'POST',
        `/v1/orgs/${org}/roles/tenant_supervisor/assignments`,
        admin.as,
        {
          userId: admin.id,
        },
      );
      expect(add.statusCode).toBe(403);
      expect(add.json()).toMatchObject({ code: 'cannot_change_own_roles' });
      const drop = await call(
        'DELETE',
        `/v1/orgs/${org}/roles/tenant_admin/assignments`,
        admin.as,
        {
          userId: admin.id,
        },
      );
      expect(drop.statusCode).toBe(403);
      expect(await h.roles.roleIdsFor(admin.id)).toEqual(['tenant_admin']);
    });

    it('can make someone else a tenant_user, and only a role of their own tier', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const other = await person(org, undefined);
      const ok = await call('POST', `/v1/orgs/${org}/roles/tenant_user/assignments`, admin.as, {
        userId: other.id,
      });
      expect(ok.statusCode).toBe(204);
      for (const roleId of [
        'master_admin',
        'master_support',
        'reseller_admin',
        'reseller_support',
      ]) {
        const response = await call(
          'POST',
          `/v1/orgs/${org}/roles/${roleId}/assignments`,
          admin.as,
          {
            userId: other.id,
          },
        );
        expect(response.statusCode, roleId).toBe(403);
        expect(response.json(), roleId).toMatchObject({ code: 'role_wrong_tier' });
      }
      expect(await h.roles.roleIdsFor(other.id)).toEqual(['tenant_user']);
    });

    it("cannot assign a role that does not exist, or another org's custom role", async () => {
      const org = crypto.randomUUID();
      const elsewhere = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const other = await person(org, undefined);
      const foreign = await h.roles.createCustomRole(elsewhere, 'foreign', ['cdr.read']);
      for (const roleId of ['made-up', foreign.id]) {
        const response = await call(
          'POST',
          `/v1/orgs/${org}/roles/${roleId}/assignments`,
          admin.as,
          {
            userId: other.id,
          },
        );
        expect(response.statusCode, roleId).toBe(404);
      }
      expect(await h.roles.roleIdsFor(other.id)).toEqual([]);
    });

    it('cannot put a permission they lack into a custom role, or one that is not a permission', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      // Held by tenant_supervisor and the reseller/master tiers, not by a tenant admin.
      for (const permission of ['monitor.barge', 'reseller.manage', 'billing.read']) {
        const response = await call('POST', `/v1/orgs/${org}/roles`, admin.as, {
          name: `r-${permission}`,
          permissions: ['cdr.read', permission],
        });
        expect(response.statusCode, permission).toBe(403);
        expect(response.json(), permission).toMatchObject({ code: 'permission_escalation' });
      }
      const unknown = await call('POST', `/v1/orgs/${org}/roles`, admin.as, {
        name: 'typo',
        permissions: ['cdr.raed'],
      });
      expect(unknown.statusCode).toBe(400);
      expect(await h.roles.listCustomRoles(org)).toEqual([]);

      const fine = await call('POST', `/v1/orgs/${org}/roles`, admin.as, {
        name: 'reader',
        permissions: ['cdr.read'],
      });
      expect(fine.statusCode).toBe(201);
    });

    it('cannot grant themselves anything, or a permission they lack', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const other = await person(org, 'tenant_user');
      const self = await call('POST', `/v1/orgs/${org}/grants`, admin.as, {
        principalType: 'user',
        principalId: admin.id,
        permission: 'cdr.read',
        scope: { type: 'org', id: org },
      });
      expect(self.statusCode).toBe(403);
      expect(self.json()).toMatchObject({ code: 'cannot_grant_self' });

      const lacking = await call('POST', `/v1/orgs/${org}/grants`, admin.as, {
        principalType: 'user',
        principalId: other.id,
        permission: 'reseller.manage',
        scope: { type: 'org', id: org },
      });
      expect(lacking.statusCode).toBe(403);
      expect(lacking.json()).toMatchObject({ code: 'permission_escalation' });
      expect(await h.grants.listForOrg(org)).toEqual([]);
    });

    it("cannot list or change another org's grants or roles", async () => {
      const org = crypto.randomUUID();
      const victim = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');
      const grant = await h.grants.create(victim, 'user', 'someone', 'cdr.read', {
        type: 'org',
        id: victim,
      });
      const list = await call('GET', `/v1/orgs/${victim}/grants`, admin.as);
      expect(list.statusCode).toBe(403);
      const revoke = await call('DELETE', `/v1/orgs/${victim}/grants/${grant.id}`, admin.as);
      expect(revoke.statusCode).toBe(403);
      expect(await h.grants.listForOrg(victim)).toHaveLength(1);
    });
  });

  describe('invitations', () => {
    it('never carry a role: a person who accepts one holds nothing until an admin assigns a role', async () => {
      const org = crypto.randomUUID();
      const admin = await person(org, 'tenant_admin');

      // A role named in the body is not part of the contract and is not stored.
      const invited = await call('POST', `/v1/orgs/${org}/invitations`, admin.as, {
        email: 'new@example.com',
        displayName: 'New',
        roleId: 'tenant_admin',
        roleIds: ['tenant_admin'],
      });
      expect(invited.statusCode).toBe(201);
      const stored = await h.db.kysely.selectFrom('invitations').selectAll().execute();
      expect(stored).toHaveLength(1);
      expect(Object.keys(stored[0] ?? {}).some((key) => key.includes('role'))).toBe(false);

      const invitation = await h.auth.invite(
        { requestId: 't' },
        { orgId: org, orgType: 'tenant', resellerId: null, userId: admin.id },
        { email: 'other@example.com', displayName: 'Other' },
      );
      const link = await h.auth.issueInvitationLink(org, invitation.id);
      if (link.status !== 'issued') throw new Error(link.status);
      const user = await h.auth.acceptInvitation({ requestId: 't' }, link.token, PASSWORD);
      expect(await h.roles.roleIdsFor(user.id)).toEqual([]);
    });
  });
});

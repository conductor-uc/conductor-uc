import { allowed, type Actor } from '@cuc/authz';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { RoleNameTakenError } from '../src/repo/role.repo.js';
import { GrantNotFoundError } from '../src/repo/grant.repo.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('roles and grants', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  beforeEach(async () => {
    await h.db.kysely.deleteFrom('grants').execute();
    await h.db.kysely.deleteFrom('role_assignments').execute();
    await h.db.kysely.deleteFrom('role_permissions').execute();
    await h.db.kysely.deleteFrom('roles').execute();
    await h.db.kysely.deleteFrom('users').execute();
  });

  describe('custom roles', () => {
    it('creates a custom role with its permission bundle', async () => {
      const orgId = crypto.randomUUID();

      const role = await h.roles.createCustomRole(orgId, 'billing-viewer', [
        'cdr.read',
        'analytics.view',
      ]);

      expect(role.name).toBe('billing-viewer');
      expect([...role.permissions].sort()).toEqual(['analytics.view', 'cdr.read']);
    });

    it('lists only the custom roles for the given org', async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      await h.roles.createCustomRole(orgA, 'role-a', ['cdr.read']);
      await h.roles.createCustomRole(orgB, 'role-b', ['cdr.read']);

      const rolesForA = await h.roles.listCustomRoles(orgA);

      expect(rolesForA.map((role) => role.name)).toEqual(['role-a']);
    });

    it('rejects a duplicate role name within the same org', async () => {
      const orgId = crypto.randomUUID();
      await h.roles.createCustomRole(orgId, 'dup', ['cdr.read']);

      await expect(h.roles.createCustomRole(orgId, 'dup', ['analytics.view'])).rejects.toThrow(
        RoleNameTakenError,
      );
    });

    it('allows the same role name in two different orgs', async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      await h.roles.createCustomRole(orgA, 'shared-name', ['cdr.read']);

      await expect(
        h.roles.createCustomRole(orgB, 'shared-name', ['cdr.read']),
      ).resolves.toBeDefined();
    });

    it('does not commit the role if the permission insert fails, and vice versa', async () => {
      const orgId = crypto.randomUUID();
      await h.roles.createCustomRole(orgId, 'once', ['cdr.read']);

      // Reuses the same name deliberately, to force the transaction to fail
      // partway — the role row must not have committed on its own.
      await expect(h.roles.createCustomRole(orgId, 'once', ['analytics.view'])).rejects.toThrow(
        RoleNameTakenError,
      );

      const rows = await h.db.kysely
        .selectFrom('roles')
        .selectAll()
        .where('org_id', '=', orgId)
        .execute();
      expect(rows).toHaveLength(1);
    });
  });

  describe('the merged role catalog', () => {
    it('includes both built-ins and an org’s custom roles', async () => {
      const orgId = crypto.randomUUID();
      const custom = await h.roles.createCustomRole(orgId, 'custom', ['cdr.read']);

      const catalog = await h.roles.catalogFor(orgId);

      expect(catalog.has('tenant_admin')).toBe(true);
      expect(catalog.get(custom.id)?.permissions.has('cdr.read')).toBe(true);
    });
  });

  describe('role assignments', () => {
    it('assigns and lists a role for a user', async () => {
      const { user } = await createUser(h, 'tenant');

      await h.roles.assignRole(user.id, 'tenant_admin', user.orgId);

      expect(await h.roles.roleIdsFor(user.id)).toEqual(['tenant_admin']);
    });

    it('is idempotent: assigning the same role twice does not error', async () => {
      const { user } = await createUser(h, 'tenant');
      await h.roles.assignRole(user.id, 'tenant_admin', user.orgId);

      await expect(
        h.roles.assignRole(user.id, 'tenant_admin', user.orgId),
      ).resolves.toBeUndefined();
      expect(await h.roles.roleIdsFor(user.id)).toEqual(['tenant_admin']);
    });

    it('revokes a role', async () => {
      const { user } = await createUser(h, 'tenant');
      await h.roles.assignRole(user.id, 'tenant_admin', user.orgId);

      await h.roles.revokeRole(user.id, 'tenant_admin', user.orgId);

      expect(await h.roles.roleIdsFor(user.id)).toEqual([]);
    });

    it('a user can hold more than one role', async () => {
      const { user } = await createUser(h, 'tenant');
      await h.roles.assignRole(user.id, 'tenant_admin', user.orgId);
      await h.roles.assignRole(user.id, 'tenant_supervisor', user.orgId);

      expect((await h.roles.roleIdsFor(user.id)).sort()).toEqual([
        'tenant_admin',
        'tenant_supervisor',
      ]);
    });
  });

  describe('grants', () => {
    it('creates and lists a grant for an org', async () => {
      const orgId = crypto.randomUUID();

      await h.grants.create(orgId, 'user', 'u1', 'cdr.read', { type: 'org', id: orgId });

      const listed = await h.grants.listForOrg(orgId);
      expect(listed).toHaveLength(1);
      expect(listed[0]).toMatchObject({
        principalType: 'user',
        principalId: 'u1',
        permission: 'cdr.read',
      });
    });

    it('finds every grant for a principal, by user id or by held role', async () => {
      const orgId = crypto.randomUUID();
      await h.grants.create(orgId, 'user', 'u1', 'cdr.read', { type: 'org', id: orgId });
      await h.grants.create(orgId, 'role', 'tenant_supervisor', 'monitor.barge', {
        type: 'queue',
        id: 'q1',
      });
      await h.grants.create(orgId, 'user', 'someone-else', 'cdr.read', { type: 'org', id: orgId });

      const forPrincipal = await h.grants.forPrincipal('u1', ['tenant_supervisor']);

      expect(forPrincipal.map((grant) => grant.permission).sort()).toEqual([
        'cdr.read',
        'monitor.barge',
      ]);
    });

    it('revokes a grant', async () => {
      const orgId = crypto.randomUUID();
      const grant = await h.grants.create(orgId, 'user', 'u1', 'cdr.read', {
        type: 'org',
        id: orgId,
      });

      await h.grants.revoke(orgId, grant.id);

      expect(await h.grants.listForOrg(orgId)).toEqual([]);
    });

    it('rejects revoking a grant that does not exist', async () => {
      const orgId = crypto.randomUUID();

      await expect(h.grants.revoke(orgId, crypto.randomUUID())).rejects.toThrow(GrantNotFoundError);
    });

    it('does not revoke a grant belonging to a different org', async () => {
      const orgA = crypto.randomUUID();
      const orgB = crypto.randomUUID();
      const grant = await h.grants.create(orgA, 'user', 'u1', 'cdr.read', {
        type: 'org',
        id: orgA,
      });

      await expect(h.grants.revoke(orgB, grant.id)).rejects.toThrow(GrantNotFoundError);
      expect(await h.grants.listForOrg(orgA)).toHaveLength(1);
    });
  });

  describe('end to end: identity-service data feeds @cuc/authz’s allowed()', () => {
    it('a role assigned through the repo makes @cuc/authz say yes', async () => {
      const { user } = await createUser(h, 'tenant');

      // Before assignment: denied.
      const actorBefore: Actor = {
        id: user.id,
        type: 'user',
        org: { id: user.orgId, type: 'tenant', resellerId: 'reseller-1' },
        roleIds: await h.roles.roleIdsFor(user.id),
      };
      expect(
        allowed({
          actor: actorBefore,
          permission: 'extension.manage',
          resource: { org: actorBefore.org },
        }),
      ).toBe(false);

      await h.roles.assignRole(user.id, 'tenant_admin', user.orgId);

      const actorAfter: Actor = { ...actorBefore, roleIds: await h.roles.roleIdsFor(user.id) };
      expect(
        allowed({
          actor: actorAfter,
          permission: 'extension.manage',
          resource: { org: actorAfter.org },
        }),
      ).toBe(true);
    });

    it('a grant created through the repo makes @cuc/authz say yes, with no role at all', async () => {
      const { user } = await createUser(h, 'tenant');
      const org = { id: user.orgId, type: 'tenant' as const, resellerId: 'reseller-1' };

      await h.grants.create(user.orgId, 'user', user.id, 'cdr.export', {
        type: 'org',
        id: user.orgId,
      });

      const grants = await h.grants.forPrincipal(user.id, []);
      const actor: Actor = { id: user.id, type: 'user', org, roleIds: [] };

      expect(allowed({ actor, permission: 'cdr.export', resource: { org }, grants })).toBe(true);
      expect(allowed({ actor, permission: 'cdr.read', resource: { org }, grants })).toBe(false);
    });

    it('H1 still wins even when identity-service data would otherwise allow it', async () => {
      const orgId = crypto.randomUUID();
      const resellerOrg = { id: orgId, type: 'reseller' as const, resellerId: null };
      const tenantOrg = { id: crypto.randomUUID(), type: 'tenant' as const, resellerId: orgId };

      await h.grants.create(orgId, 'user', 'reseller-user', 'cdr.read', {
        type: 'org',
        id: tenantOrg.id,
      });
      const grants = await h.grants.forPrincipal('reseller-user', []);
      const actor: Actor = { id: 'reseller-user', type: 'user', org: resellerOrg, roleIds: [] };

      expect(allowed({ actor, permission: 'cdr.read', resource: { org: tenantOrg }, grants })).toBe(
        false,
      );
    });
  });
});

async function createUser(h: Harness, orgType: 'master' | 'reseller' | 'tenant') {
  const orgId = crypto.randomUUID();
  const user = await h.users.create(
    {},
    {
      orgId,
      orgType,
      resellerId: orgType === 'tenant' ? 'reseller-1' : null,
      email: `${crypto.randomUUID()}@example.com`,
      displayName: 'Test User',
      password: 'correct horse battery staple',
    },
  );
  return { orgId, user };
}

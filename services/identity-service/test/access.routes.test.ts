import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { createPermissionLookup } from '../src/authz/permission-lookup.js';
import { registerAccessRoutes } from '../src/routes/access.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-internal-service-token';

interface AccessBody {
  roles: { id: string; permissions: string[] }[];
  grants: {
    principalType: string;
    principalId: string;
    permission: string;
    scope: { type: string; id: string };
  }[];
}

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/orgs/:orgId/users/:userId/access',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'identity-service', logger: silentLogger() });
      registerAccessRoutes(app, createPermissionLookup(h.users, h.roles, h.grants), TOKEN);
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

    async function makeUser(orgId: string, email: string) {
      const user = await h.users.create(
        { requestId: 'test' },
        {
          orgId,
          orgType: 'tenant',
          resellerId: null,
          email,
          displayName: email,
          password: 'correct horse battery staple',
        },
      );
      return user.id;
    }

    const get = (orgId: string, userId: string, token: string | null = TOKEN) =>
      app.inject({
        method: 'GET',
        url: `/internal/v1/orgs/${orgId}/users/${userId}/access`,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
      });

    it('requires the internal service token', async () => {
      expect((await get('org-1', 'nobody', null)).statusCode).toBe(401);
      expect((await get('org-1', 'nobody', 'wrong')).statusCode).toBe(401);
    });

    it('returns the roles a user holds with their permissions, and nothing for one with none', async () => {
      const admin = await makeUser('org-1', 'admin@example.test');
      await h.roles.assignRole(admin, 'tenant_admin', 'org-1');
      const plain = await makeUser('org-1', 'plain@example.test');

      const adminBody = (await get('org-1', admin)).json<AccessBody>();
      expect(adminBody.roles.map((r) => r.id)).toEqual(['tenant_admin']);
      expect(adminBody.roles[0]?.permissions).toContain('recording.listen');

      const plainBody = (await get('org-1', plain)).json<AccessBody>();
      expect(plainBody).toEqual({ roles: [], grants: [] });
    });

    it("returns the user's own grants and their roles' grants, only those of the named org", async () => {
      const supervisor = await makeUser('org-1', 'sup@example.test');
      await h.roles.assignRole(supervisor, 'tenant_supervisor', 'org-1');
      await h.grants.create('org-1', 'user', supervisor, 'recording.listen', {
        type: 'queue',
        id: 'Q1',
      });
      await h.grants.create('org-1', 'role', 'tenant_supervisor', 'recording.download', {
        type: 'queue',
        id: 'Q2',
      });
      await h.grants.create('org-2', 'user', supervisor, 'recording.delete', {
        type: 'queue',
        id: 'Q9',
      });

      const body = (await get('org-1', supervisor)).json<AccessBody>();
      expect(
        body.grants.map((g) => `${g.permission}@${g.scope.type}:${g.scope.id}`).sort(),
      ).toEqual(['recording.download@queue:Q2', 'recording.listen@queue:Q1']);
    });

    it('answers 404 for someone disabled, unknown, or asked about under another org', async () => {
      const supervisor = await makeUser('org-1', 'gone@example.test');
      await h.roles.assignRole(supervisor, 'tenant_supervisor', 'org-1');
      await h.grants.create('org-1', 'user', supervisor, 'recording.listen', {
        type: 'queue',
        id: 'Q1',
      });
      expect((await get('org-1', supervisor)).statusCode).toBe(200);
      // Their own org is the only one they can be looked up under.
      expect((await get('org-2', supervisor)).statusCode).toBe(404);
      expect((await get('org-1', 'no-such-user')).statusCode).toBe(404);

      await h.users.update({ requestId: 'test' }, 'org-1', supervisor, { status: 'disabled' });
      expect((await get('org-1', supervisor)).statusCode).toBe(404);
    });
  },
);

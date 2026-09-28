import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { purgeOrg } from '../src/org-deletion.js';
import { createApiKeyRepo } from '../src/repo/api-key.repo.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const PASSWORD = 'correct horse battery staple';

describe.skipIf(skipReason !== undefined)(
  "removing a deleted org's people and access (S1-16)",
  () => {
    let h: Harness;

    beforeAll(async () => {
      h = await startHarness();
    });

    afterAll(async () => {
      await h?.close();
    });

    /** One org's worth of identity data: a person with a role, a custom role, a grant, a key. */
    async function populate(orgId: string) {
      const user = await h.users.create(
        { requestId: 'test' },
        {
          orgId,
          orgType: 'tenant',
          resellerId: null,
          email: `${crypto.randomUUID()}@example.test`,
          displayName: 'Someone',
          password: PASSWORD,
        },
      );
      await h.roles.assignRole(user.id, 'tenant_admin', orgId);
      const role = await h.roles.createCustomRole(orgId, 'Front desk', ['extension.read']);
      await h.grants.create(orgId, 'user', user.id, 'cdr.read', { type: 'org', id: orgId });
      await createApiKeyRepo(h.db).create(
        { actorId: user.id, orgId },
        {
          orgId,
          orgType: 'tenant',
          resellerId: null,
          name: 'k',
          permissions: ['extension.read'],
          expiresAt: null,
        },
      );
      return { user, role };
    }

    async function count(orgId: string, userId: string) {
      const k = h.db.kysely;
      const n = async (q: Promise<unknown[]>) => (await q).length;
      return {
        users: await n(k.selectFrom('users').select('id').where('org_id', '=', orgId).execute()),
        assignments: await n(
          k
            .selectFrom('role_assignments')
            .select('user_id')
            .where('user_id', '=', userId)
            .execute(),
        ),
        roles: await n(k.selectFrom('roles').select('id').where('org_id', '=', orgId).execute()),
        grants: await n(k.selectFrom('grants').select('id').where('org_id', '=', orgId).execute()),
        keys: await n(k.selectFrom('api_keys').select('id').where('org_id', '=', orgId).execute()),
      };
    }

    it('removes every row of that org, leaves every other org alone, and keeps the audit trail', async () => {
      const gone = crypto.randomUUID();
      const kept = crypto.randomUUID();
      const a = await populate(gone);
      const b = await populate(kept);
      const auditBefore = (await h.db.kysely.selectFrom('audit_events').select('id').execute())
        .length;

      await h.db.kysely.transaction().execute((trx) => purgeOrg(trx, gone));

      expect(await count(gone, a.user.id)).toEqual({
        users: 0,
        assignments: 0,
        roles: 0,
        grants: 0,
        keys: 0,
      });
      expect(await count(kept, b.user.id)).toEqual({
        users: 1,
        assignments: 1,
        roles: 1,
        grants: 1,
        keys: 1,
      });
      const auditAfter = (await h.db.kysely.selectFrom('audit_events').select('id').execute())
        .length;
      expect(auditAfter).toBe(auditBefore);

      // Again: nothing left to remove, and no error.
      await h.db.kysely.transaction().execute((trx) => purgeOrg(trx, gone));
    });
  },
);

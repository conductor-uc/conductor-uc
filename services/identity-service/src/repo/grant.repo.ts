import { randomUUID } from 'node:crypto';

import type { Grant, Permission, Scope } from '@cuc/authz';
import type { Database } from '@cuc/db';

import type { IdentityServiceDb } from '../schema.js';

export interface GrantRecord extends Grant {
  readonly id: string;
  readonly orgId: string;
}

export class GrantNotFoundError extends Error {
  override readonly name = 'GrantNotFoundError';

  constructor(id: string) {
    super(`No grant with id '${id}'.`);
  }
}

/**
 * Data access for grants (07 §3.1). Not tenant-owned in the `@cuc/db` sense —
 * `grants.org_id` can name a master, reseller, or tenant org — so, as with
 * every other table here, queries filter by an explicit org id.
 */
export function createGrantRepo(db: Database<IdentityServiceDb>) {
  const kysely = db.kysely;

  function toRecord(row: {
    id: string;
    org_id: string;
    principal_type: 'user' | 'role';
    principal_id: string;
    permission: string;
    scope_type: string;
    scope_id: string;
  }): GrantRecord {
    return {
      id: row.id,
      orgId: row.org_id,
      principalType: row.principal_type,
      principalId: row.principal_id,
      permission: row.permission,
      scope: { type: row.scope_type as Scope['type'], id: row.scope_id },
    };
  }

  return {
    async listForOrg(orgId: string): Promise<GrantRecord[]> {
      const rows = await kysely
        .selectFrom('grants')
        .selectAll()
        .where('org_id', '=', orgId)
        .execute();
      return rows.map(toRecord);
    },

    /**
     * Every grant naming `userId` directly, or naming a role in `roleIds` —
     * exactly the set `@cuc/authz`'s `grantMatches` needs. It does its own
     * principal filtering, so passing a superset here is safe, but this is
     * already the precise set.
     */
    async forPrincipal(userId: string, roleIds: readonly string[]): Promise<GrantRecord[]> {
      const rows = await kysely
        .selectFrom('grants')
        .selectAll()
        .where((eb) =>
          eb.or([
            eb.and([eb('principal_type', '=', 'user'), eb('principal_id', '=', userId)]),
            ...(roleIds.length > 0
              ? [eb.and([eb('principal_type', '=', 'role'), eb('principal_id', 'in', roleIds)])]
              : []),
          ]),
        )
        .execute();
      return rows.map(toRecord);
    },

    async create(
      orgId: string,
      principalType: 'user' | 'role',
      principalId: string,
      permission: Permission,
      scope: Scope,
    ): Promise<GrantRecord> {
      const id = randomUUID();
      await kysely
        .insertInto('grants')
        .values({
          id,
          org_id: orgId,
          principal_type: principalType,
          principal_id: principalId,
          permission,
          scope_type: scope.type,
          scope_id: scope.id,
          created_at: new Date(),
        })
        .execute();
      return { id, orgId, principalType, principalId, permission, scope };
    },

    async revoke(orgId: string, grantId: string): Promise<void> {
      const result = await kysely
        .deleteFrom('grants')
        .where('id', '=', grantId)
        .where('org_id', '=', orgId)
        .executeTakeFirst();
      if (Number(result.numDeletedRows) === 0) throw new GrantNotFoundError(grantId);
    },
  };
}

export type GrantRepo = ReturnType<typeof createGrantRepo>;

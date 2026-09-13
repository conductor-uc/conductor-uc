import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { assertValidParentType, resellerIdFor, validateSlug } from '../domain/org.js';
import { orgEvents } from '../events.js';
import type { OrgServiceDb, OrgStatus, OrgType } from '../schema.js';

export interface Org {
  readonly id: string;
  readonly type: OrgType;
  readonly parentId: string | null;
  readonly resellerId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly status: OrgStatus;
}

export class MasterAlreadyExistsError extends Error {
  override readonly name = 'MasterAlreadyExistsError';

  constructor() {
    super('A master org already exists. There is exactly one per deployment (02 §1).');
  }
}

export class ParentNotFoundError extends Error {
  override readonly name = 'ParentNotFoundError';

  constructor(parentId: string) {
    super(`No org with id '${parentId}'.`);
  }
}

export class SlugTakenError extends Error {
  override readonly name = 'SlugTakenError';

  constructor(slug: string) {
    super(`The slug '${slug}' is already in use. Slugs are globally unique (02 §3).`);
  }
}

const DEFAULT_LIMITS = '{}';

/**
 * Data access for the org hierarchy.
 *
 * `orgs` has no `tenant_id` — it is what defines tenants, not tenant-owned
 * data, so it does not go through `scoped(ctx)` (see `schema.ts`). Where a
 * query needs to stay inside one reseller's tree, this repository filters by
 * `reseller_id` explicitly (05 §2.5), which is the ancestry check
 * `@cuc/authz` will take over in S1-06. Until then, calling this repository at
 * all is the access control: nothing routes to it except the bootstrap CLI.
 */
export function createOrgRepo(db: Database<OrgServiceDb>) {
  const orgs = db.kysely;

  function toOrg(row: {
    id: string;
    type: OrgType;
    parent_id: string | null;
    reseller_id: string | null;
    slug: string;
    name: string;
    status: OrgStatus;
  }): Org {
    return {
      id: row.id,
      type: row.type,
      parentId: row.parent_id,
      resellerId: row.reseller_id,
      slug: row.slug,
      name: row.name,
      status: row.status,
    };
  }

  return {
    findById: async (id: string): Promise<Org | undefined> => {
      const row = await orgs
        .selectFrom('orgs')
        .select(['id', 'type', 'parent_id', 'reseller_id', 'slug', 'name', 'status'])
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toOrg(row);
    },

    /** Immediate children of `parentId`, e.g. a reseller's tenants. */
    listChildren: async (parentId: string): Promise<Org[]> => {
      const rows = await orgs
        .selectFrom('orgs')
        .select(['id', 'type', 'parent_id', 'reseller_id', 'slug', 'name', 'status'])
        .where('parent_id', '=', parentId)
        .orderBy('created_at', 'asc')
        .execute();
      return rows.map(toOrg);
    },

    /**
     * Creates the single master org.
     *
     * Never through an API (02 §1) — only the bootstrap CLI calls this. A
     * second attempt throws {@link MasterAlreadyExistsError} rather than
     * silently doing nothing, so a misfired bootstrap script is loud about it.
     * The partial-unique index in the migration is what actually makes the
     * guarantee hold under concurrent bootstraps; this catches that race and
     * turns it into a clean error instead of a raw duplicate-key one.
     */
    async createMaster(input: { slug: string; name: string }): Promise<Org> {
      const slug = validateSlug(input.slug);
      const id = randomUUID();
      const now = new Date();

      try {
        await orgs
          .insertInto('orgs')
          .values({
            id,
            type: 'master',
            parent_id: null,
            reseller_id: null,
            slug,
            name: input.name,
            status: 'active',
            timezone: 'UTC',
            country: 'US',
            limits: DEFAULT_LIMITS,
            created_at: now,
            updated_at: now,
            version: 1,
          })
          .execute();
      } catch (error) {
        if (isDuplicateKeyError(error)) throw new MasterAlreadyExistsError();
        throw error;
      }

      return {
        id,
        type: 'master',
        parentId: null,
        resellerId: null,
        slug,
        name: input.name,
        status: 'active',
      };
    },

    /**
     * Creates a reseller or a tenant under `parentId`, publishing
     * `org.reseller.created` or `org.tenant.created`.
     *
     * The parent-type rule (02 §1) needs the parent's *actual* row, which is
     * why this reads it inside the same transaction as the insert: reading
     * outside the transaction would leave a window where the parent could be
     * deleted or change type between the check and the write.
     */
    async create(
      ctx: DbContext,
      type: 'reseller' | 'tenant',
      input: {
        parentId: string;
        slug: string;
        name: string;
      },
    ): Promise<Org> {
      const slug = validateSlug(input.slug);
      const id = randomUUID();
      const now = new Date();

      return db.kysely.transaction().execute(async (trx) => {
        const parent = await trx
          .selectFrom('orgs')
          .select(['id', 'type'])
          .where('id', '=', input.parentId)
          .executeTakeFirst();
        if (parent === undefined) throw new ParentNotFoundError(input.parentId);

        assertValidParentType(type, parent.type);
        const resellerId = resellerIdFor(type, parent);

        try {
          await trx
            .insertInto('orgs')
            .values({
              id,
              type,
              parent_id: input.parentId,
              reseller_id: resellerId,
              slug,
              name: input.name,
              status: 'active',
              timezone: 'UTC',
              country: 'US',
              limits: DEFAULT_LIMITS,
              created_at: now,
              updated_at: now,
              version: 1,
            })
            .execute();
        } catch (error) {
          if (isDuplicateKeyError(error)) throw new SlugTakenError(slug);
          throw error;
        }

        await enqueueEvent(trx, orgEvents, {
          type: type === 'reseller' ? 'org.reseller.created' : 'org.tenant.created',
          data: { orgId: id, slug, name: input.name, parentId: input.parentId },
          ...(ctx.actorId === undefined || ctx.orgId === undefined
            ? {}
            : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
          ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
        });

        return {
          id,
          type,
          parentId: input.parentId,
          resellerId,
          slug,
          name: input.name,
          status: 'active',
        };
      });
    },
  };
}

export type OrgRepo = ReturnType<typeof createOrgRepo>;

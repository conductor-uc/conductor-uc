import { randomUUID } from 'node:crypto';

import type { Database, DbContext } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { enqueueEvent } from '@cuc/events';

import { tenantDomainFor } from '../domain/domain.js';
import {
  assertCanResume,
  assertCanSuspend,
  assertValidParentType,
  InvalidOrgHierarchyError,
  resellerIdFor,
  validateSlug,
} from '../domain/org.js';
import { orgEvents } from '../events.js';
import { DomainTakenError } from './domain.repo.js';
import type { OrgServiceDb, OrgStatus, OrgType } from '../schema.js';

export interface Org {
  readonly id: string;
  readonly type: OrgType;
  readonly parentId: string | null;
  readonly resellerId: string | null;
  readonly slug: string;
  readonly name: string;
  readonly status: OrgStatus;
  readonly timezone: string;
  readonly country: string;
  /** Parsed from the `limits` JSON column. */
  readonly limits: Record<string, unknown>;
}

const ORG_COLUMNS = [
  'id',
  'type',
  'parent_id',
  'reseller_id',
  'slug',
  'name',
  'status',
  'timezone',
  'country',
  'limits',
  'version',
] as const;

interface OrgRow {
  id: string;
  type: OrgType;
  parent_id: string | null;
  reseller_id: string | null;
  slug: string;
  name: string;
  status: OrgStatus;
  timezone: string;
  country: string;
  limits: string;
  version: number;
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

export class OrgNotFoundError extends Error {
  override readonly name = 'OrgNotFoundError';

  constructor(id: string) {
    super(`No org with id '${id}'.`);
  }
}

const DEFAULT_LIMITS = '{}';

/**
 * `orgs.limits` is declared `json` in the migration, but whether the driver
 * hands it back already parsed depends on the server: MariaDB's docs say JSON
 * columns are LONGTEXT under the hood, yet mysql2 parses it into an object
 * here regardless — so this accepts either shape rather than assume one.
 */
function parseLimits(value: unknown): Record<string, unknown> {
  return typeof value === 'string'
    ? (JSON.parse(value) as Record<string, unknown>)
    : (value as Record<string, unknown>);
}

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
export interface CreateOrgRepoOptions {
  /**
   * The deployment-wide fallback base for a tenant's primary domain
   * (`PLATFORM_BASE_DOMAIN`, 02 §3) — used whenever the owning reseller has
   * no active base domain of its own yet.
   */
  readonly platformBaseDomain: string;
}

export function createOrgRepo(db: Database<OrgServiceDb>, options: CreateOrgRepoOptions) {
  const orgs = db.kysely;

  function toOrg(row: OrgRow): Org {
    return {
      id: row.id,
      type: row.type,
      parentId: row.parent_id,
      resellerId: row.reseller_id,
      slug: row.slug,
      name: row.name,
      status: row.status,
      timezone: row.timezone,
      country: row.country,
      limits: parseLimits(row.limits),
    };
  }

  return {
    findById: async (id: string): Promise<Org | undefined> => {
      const row = await orgs
        .selectFrom('orgs')
        .select(ORG_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      return row === undefined ? undefined : toOrg(row);
    },

    /** The single master org, or `undefined` before bootstrap has run. */
    findMaster: async (): Promise<Org | undefined> => {
      const row = await orgs
        .selectFrom('orgs')
        .select(ORG_COLUMNS)
        .where('type', '=', 'master')
        .executeTakeFirst();
      return row === undefined ? undefined : toOrg(row);
    },

    /** Immediate children of `parentId`, e.g. a reseller's tenants. */
    listChildren: async (parentId: string): Promise<Org[]> => {
      const rows = await orgs
        .selectFrom('orgs')
        .select(ORG_COLUMNS)
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
        timezone: 'UTC',
        country: 'US',
        limits: {},
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
          ...eventMeta(ctx),
        });

        // A tenant's primary domain is assigned in the same transaction as
        // the tenant row: unlike identity-service's admin-user call, nothing
        // stops this one from being atomic, so a tenant is never left
        // without a domain (02 §3).
        if (type === 'tenant') {
          const base = await trx
            .selectFrom('reseller_base_domains')
            .select('fqdn')
            .where('reseller_id', '=', input.parentId)
            .where('status', '=', 'active')
            .orderBy('created_at', 'asc')
            .executeTakeFirst();
          const fqdn = tenantDomainFor(slug, base?.fqdn ?? options.platformBaseDomain);
          const domainId = randomUUID();

          try {
            await trx
              .insertInto('tenant_domains')
              .values({ id: domainId, tenant_id: id, fqdn, is_primary: true, created_at: now })
              .execute();
          } catch (error) {
            if (isDuplicateKeyError(error)) throw new DomainTakenError(fqdn);
            throw error;
          }

          await enqueueEvent(trx, orgEvents, {
            type: 'org.domain.added',
            data: { domainId, fqdn, scope: 'tenant', ownerId: id },
            ...eventMeta(ctx),
          });
        }

        return {
          id,
          type,
          parentId: input.parentId,
          resellerId,
          slug,
          name: input.name,
          status: 'active',
          timezone: 'UTC',
          country: 'US',
          limits: {},
        };
      });
    },

    /**
     * Updates name, timezone, country, and/or limits. Publishes
     * `org.reseller.updated` or `org.tenant.updated`.
     *
     * Never used to move an org — `parentId`/`type` are immutable in v1
     * (02 §1: no re-parenting) — and never used to change `status`; that is
     * `suspend`/`resume`'s job, so a status change always has its own event.
     */
    async update(
      ctx: DbContext,
      id: string,
      patch: {
        readonly name?: string;
        readonly timezone?: string;
        readonly country?: string;
        readonly limits?: Record<string, unknown>;
      },
    ): Promise<Org> {
      return db.kysely.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('orgs')
          .select(ORG_COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new OrgNotFoundError(id);
        if (existing.type === 'master') {
          throw new InvalidOrgHierarchyError(
            'The master org is managed only by its bootstrap CLI.',
          );
        }

        await trx
          .updateTable('orgs')
          .set({
            ...(patch.name === undefined ? {} : { name: patch.name }),
            ...(patch.timezone === undefined ? {} : { timezone: patch.timezone }),
            ...(patch.country === undefined ? {} : { country: patch.country }),
            ...(patch.limits === undefined ? {} : { limits: JSON.stringify(patch.limits) }),
            updated_at: new Date(),
            version: existing.version + 1,
          })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(trx, orgEvents, {
          type: existing.type === 'reseller' ? 'org.reseller.updated' : 'org.tenant.updated',
          data: { orgId: id },
          ...eventMeta(ctx),
        });

        return toOrg({
          ...existing,
          name: patch.name ?? existing.name,
          timezone: patch.timezone ?? existing.timezone,
          country: patch.country ?? existing.country,
          limits: patch.limits === undefined ? existing.limits : JSON.stringify(patch.limits),
        });
      });
    },

    /**
     * `active` -> `suspended` (02 §2). Blocks console login and SIP for the
     * org's domain once `telephony-config` reacts to the event; data is
     * retained. Suspending a reseller does not cascade to its tenants here —
     * that fan-out belongs to whichever consumer needs it (`telephony-config`
     * or a saga), since a cascading write from this repository would mean
     * this transaction touching rows outside the one it was asked to change.
     */
    async suspend(ctx: DbContext, id: string): Promise<Org> {
      return db.kysely.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('orgs')
          .select(ORG_COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new OrgNotFoundError(id);
        if (existing.type === 'master') {
          throw new InvalidOrgHierarchyError('The master org has no suspend/resume lifecycle.');
        }
        assertCanSuspend(existing.status);

        await trx
          .updateTable('orgs')
          .set({ status: 'suspended', updated_at: new Date(), version: existing.version + 1 })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(trx, orgEvents, {
          type: existing.type === 'reseller' ? 'org.reseller.suspended' : 'org.tenant.suspended',
          data: { orgId: id },
          ...eventMeta(ctx),
        });

        return toOrg({ ...existing, status: 'suspended' });
      });
    },

    /** `suspended` -> `active` (02 §2). */
    async resume(ctx: DbContext, id: string): Promise<Org> {
      return db.kysely.transaction().execute(async (trx) => {
        const existing = await trx
          .selectFrom('orgs')
          .select(ORG_COLUMNS)
          .where('id', '=', id)
          .executeTakeFirst();
        if (existing === undefined) throw new OrgNotFoundError(id);
        if (existing.type === 'master') {
          throw new InvalidOrgHierarchyError('The master org has no suspend/resume lifecycle.');
        }
        assertCanResume(existing.status);

        await trx
          .updateTable('orgs')
          .set({ status: 'active', updated_at: new Date(), version: existing.version + 1 })
          .where('id', '=', id)
          .execute();

        await enqueueEvent(trx, orgEvents, {
          type: existing.type === 'reseller' ? 'org.reseller.resumed' : 'org.tenant.resumed',
          data: { orgId: id },
          ...eventMeta(ctx),
        });

        return toOrg({ ...existing, status: 'active' });
      });
    },
  };
}

function eventMeta(ctx: DbContext): {
  actor?: { type: 'user'; id: string; orgId: string };
  correlationId?: string;
} {
  return {
    ...(ctx.actorId === undefined || ctx.orgId === undefined
      ? {}
      : { actor: { type: 'user', id: ctx.actorId, orgId: ctx.orgId } }),
    ...(ctx.requestId === undefined ? {} : { correlationId: ctx.requestId }),
  };
}

export type OrgRepo = ReturnType<typeof createOrgRepo>;

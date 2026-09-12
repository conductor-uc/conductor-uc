import { randomUUID } from 'node:crypto';

import type { TenantProbeSubject } from '@cuc/testing';

import type { Database } from '../../src/client.js';
import type { DbContext } from '../../src/context.js';
import type { TestDb } from './schema.js';

type Db = Database<TestDb>;

const ctxFor = (tenantId: string): DbContext => ({ tenantId, orgType: 'tenant' });

/**
 * A repository written the way the rules require: every query goes through
 * `scoped(ctx)`, so the `tenant_id` predicate is not something the author has
 * to remember (CLAUDE.md rule 2).
 */
export function correctWidgetsRepo(db: Db): TenantProbeSubject<string> {
  return {
    name: 'widgets (scoped)',

    seed: async (tenantId) => {
      const id = randomUUID();
      await db
        .scoped(ctxFor(tenantId))
        .insertInto('widgets')
        .values({ id, label: `probe-${id.slice(0, 8)}`, version: 1 })
        .execute();
      return id;
    },

    list: (tenantId) => db.scoped(ctxFor(tenantId)).selectFrom('widgets').select(['id']).execute(),

    findById: (tenantId, id) =>
      db
        .scoped(ctxFor(tenantId))
        .selectFrom('widgets')
        .select(['id'])
        .where('id', '=', id)
        .executeTakeFirst(),

    update: async (tenantId, id) => {
      const result = await db
        .scoped(ctxFor(tenantId))
        .updateTable('widgets')
        .set({ label: 'renamed' })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    remove: async (tenantId, id) => {
      const result = await db
        .scoped(ctxFor(tenantId))
        .deleteFrom('widgets')
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

/**
 * The same repository with the tenant predicate left out — what a developer
 * writes when they reach past `scoped(ctx)` for the raw Kysely instance.
 *
 * It exists so the probe can be shown to fail. Nothing else should import it,
 * and the lint rule plus code review are what stop this shape reaching a
 * service.
 */
export function brokenWidgetsRepo(db: Db): TenantProbeSubject<string> {
  const raw = db.kysely;

  return {
    name: 'widgets (unscoped, deliberately broken)',

    seed: async (tenantId) => {
      const id = randomUUID();
      await raw
        .insertInto('widgets')
        .values({ id, tenant_id: tenantId, label: `probe-${id.slice(0, 8)}`, version: 1 })
        .execute();
      return id;
    },

    // No `where tenant_id = ?`: every tenant sees every row.
    list: () => raw.selectFrom('widgets').select(['id']).execute(),

    findById: (_tenantId, id) =>
      raw.selectFrom('widgets').select(['id']).where('id', '=', id).executeTakeFirst(),

    update: async (_tenantId, id) => {
      const result = await raw
        .updateTable('widgets')
        .set({ label: 'renamed' })
        .where('id', '=', id)
        .executeTakeFirst();
      return Number(result.numUpdatedRows);
    },

    remove: async (_tenantId, id) => {
      const result = await raw.deleteFrom('widgets').where('id', '=', id).executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

/**
 * A repository that reads nothing at all.
 *
 * It leaks nothing, so an isolation-only probe would pass it. The probe asserts
 * visibility too, and this fixture is what proves that assertion is load-bearing.
 */
export function emptyWidgetsRepo(db: Db): TenantProbeSubject<string> {
  const correct = correctWidgetsRepo(db);
  return {
    ...correct,
    name: 'widgets (reads nothing)',
    list: () => Promise.resolve([]),
    findById: () => Promise.resolve(undefined),
  };
}

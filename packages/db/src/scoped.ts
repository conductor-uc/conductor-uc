import type {
  DeleteQueryBuilder,
  DeleteResult,
  InsertObject,
  InsertQueryBuilder,
  InsertResult,
  Kysely,
  SelectQueryBuilder,
  Transaction,
  UpdateQueryBuilder,
  UpdateResult,
} from 'kysely';

import { requireTenant, type DbContext, type TenantContext } from './context.js';

/**
 * The tables `scoped` will touch: those whose row type has a `tenant_id`.
 *
 * A table without one is not tenant-owned (05 §2.1), so
 * `scoped(ctx).selectFrom('orgs')` is a type error rather than a query that
 * silently filters on nothing.
 */
export type TenantOwnedTable<DB> = {
  [K in keyof DB]: 'tenant_id' extends keyof DB[K] ? K : never;
}[keyof DB] &
  keyof DB &
  string;

/** Insert values minus `tenant_id`, which the scope supplies. */
export type ScopedInsertValues<DB, T extends keyof DB> = Omit<InsertObject<DB, T>, 'tenant_id'>;

/**
 * A scoped insert. `values()` injects `tenant_id` and then hands back the real
 * Kysely builder, so `onDuplicateKeyUpdate`, `ignore`, and the rest still work.
 */
export interface ScopedInsertBuilder<DB, T extends keyof DB> {
  values(
    values: ScopedInsertValues<DB, T> | readonly ScopedInsertValues<DB, T>[],
  ): InsertQueryBuilder<DB, T, InsertResult>;
}

/**
 * Data access for exactly one tenant.
 *
 * Every builder arrives with `tenant_id` already constrained, which is what
 * makes CLAUDE.md rule 2 mechanical rather than a habit: a repository cannot
 * reach another tenant's rows without asking for `unscoped`, which is named,
 * reasoned, and audited.
 */
export interface ScopedDb<DB> {
  readonly tenantId: string;
  readonly ctx: TenantContext;

  selectFrom<T extends TenantOwnedTable<DB>>(table: T): SelectQueryBuilder<DB, T, object>;
  insertInto<T extends TenantOwnedTable<DB>>(table: T): ScopedInsertBuilder<DB, T>;
  updateTable<T extends TenantOwnedTable<DB>>(table: T): UpdateQueryBuilder<DB, T, T, UpdateResult>;
  deleteFrom<T extends TenantOwnedTable<DB>>(table: T): DeleteQueryBuilder<DB, T, DeleteResult>;

  /** Runs `fn` in a transaction, still scoped to the same tenant. */
  transaction<R>(fn: (trx: ScopedDb<DB>) => Promise<R>): Promise<R>;
}

/**
 * Builds the tenant-scoped accessor over a connection or an open transaction.
 *
 * The predicate uses a qualified column (`extensions.tenant_id`) so it stays
 * unambiguous once a repository joins another table that also has one.
 */
export function scopedFor<DB>(
  executor: Kysely<DB> | Transaction<DB>,
  ctx: DbContext,
): ScopedDb<DB> {
  const tenantCtx = requireTenant(ctx);
  const { tenantId } = tenantCtx;

  return {
    tenantId,
    ctx: tenantCtx,

    selectFrom<T extends TenantOwnedTable<DB>>(table: T): SelectQueryBuilder<DB, T, object> {
      // Two things need help here, and both are confined to these four methods
      // so nothing downstream of them is loosely typed.
      //
      // Kysely keys its builders on `ExtractTableAlias<DB, T>`, which does not
      // reduce to `T` while `T` is still generic — hence the widening. And
      // `${table}.tenant_id` is a column reference assembled from a generic
      // table name, which Kysely cannot type at all.
      const builder = executor.selectFrom(table) as unknown as SelectQueryBuilder<DB, T, object>;
      return builder.where(`${table}.tenant_id` as never, '=', tenantId as never);
    },

    insertInto<T extends TenantOwnedTable<DB>>(table: T): ScopedInsertBuilder<DB, T> {
      return {
        values(values) {
          const rows: readonly object[] = Array.isArray(values) ? values : [values];
          const withTenant = rows.map((row) => ({ ...row, tenant_id: tenantId }));
          const builder: InsertQueryBuilder<DB, T, InsertResult> = executor
            .insertInto(table)
            .values(withTenant as never);
          return builder;
        },
      };
    },

    updateTable<T extends TenantOwnedTable<DB>>(
      table: T,
    ): UpdateQueryBuilder<DB, T, T, UpdateResult> {
      const builder = executor.updateTable(table) as unknown as UpdateQueryBuilder<
        DB,
        T,
        T,
        UpdateResult
      >;
      return builder.where(`${table}.tenant_id` as never, '=', tenantId as never);
    },

    deleteFrom<T extends TenantOwnedTable<DB>>(table: T): DeleteQueryBuilder<DB, T, DeleteResult> {
      const builder = executor.deleteFrom(table) as unknown as DeleteQueryBuilder<
        DB,
        T,
        DeleteResult
      >;
      return builder.where(`${table}.tenant_id` as never, '=', tenantId as never);
    },

    async transaction<R>(fn: (trx: ScopedDb<DB>) => Promise<R>): Promise<R> {
      if (executor.isTransaction) {
        // MariaDB has no true nested transactions, so joining the open one is
        // the honest behaviour rather than pretending to start a new one.
        return fn(scopedFor(executor, tenantCtx));
      }
      return executor.transaction().execute((trx) => fn(scopedFor(trx, tenantCtx)));
    },
  };
}

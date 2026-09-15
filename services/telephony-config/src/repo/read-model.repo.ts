import type { Database } from '@cuc/db';
import type { Kysely, Transaction } from 'kysely';

import type { TelephonyConfigDb } from '../schema.js';

export interface TenantRow {
  readonly id: string;
  readonly status: 'active' | 'suspended';
}

export interface DomainRow {
  readonly id: string;
  readonly tenantId: string;
  readonly fqdn: string;
}

export interface ExtensionRow {
  readonly id: string;
  readonly tenantId: string;
  readonly number: string;
  readonly username: string;
  readonly ha1: string;
  readonly realm: string;
}

type Executor = Kysely<TelephonyConfigDb> | Transaction<TelephonyConfigDb>;

/**
 * telephony-config's own local read model (S1-12; `src/schema.ts`).
 *
 * Not `scoped(ctx)`: these tables have no per-request tenant actor to scope
 * to at all — every write here happens inside a NATS consumer's handler or
 * the reconciliation pass, neither of which is a tenant's own HTTP request.
 * `tenant_id` exists for correctness (joins, indexing) rather than access
 * control, so this repo works directly against the executor it is given —
 * a consumer's transaction, or `db.kysely` for the reconciliation pass's
 * read-only queries.
 */
export function createReadModelRepo(db: Database<TelephonyConfigDb>) {
  return {
    async upsertTenant(trx: Executor, tenant: TenantRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('tenants')
        .values({ id: tenant.id, status: tenant.status, created_at: now, updated_at: now })
        .onDuplicateKeyUpdate({ status: tenant.status, updated_at: now })
        .execute();
    },

    async setTenantStatus(
      trx: Executor,
      tenantId: string,
      status: 'active' | 'suspended',
    ): Promise<void> {
      await trx
        .updateTable('tenants')
        .set({ status, updated_at: new Date() })
        .where('id', '=', tenantId)
        .execute();
    },

    findTenant(trx: Executor, tenantId: string): Promise<TenantRow | undefined> {
      return trx
        .selectFrom('tenants')
        .select(['id', 'status'])
        .where('id', '=', tenantId)
        .executeTakeFirst();
    },

    /** Every tenant this service knows about, for reconciliation. */
    listTenants(): Promise<TenantRow[]> {
      return db.kysely.selectFrom('tenants').select(['id', 'status']).execute();
    },

    /**
     * Replaces the tenant's current primary domain, if any, and returns the
     * previous row (so a consumer can remove the *old* fqdn from the
     * projection before adding the new one — 02 §3's domain-change case).
     */
    async upsertDomain(trx: Executor, domain: DomainRow): Promise<DomainRow | undefined> {
      const previous = await trx
        .selectFrom('domains')
        .select(['id', 'tenant_id as tenantId', 'fqdn'])
        .where('tenant_id', '=', domain.tenantId)
        .executeTakeFirst();

      const now = new Date();
      if (previous === undefined) {
        await trx
          .insertInto('domains')
          .values({
            id: domain.id,
            tenant_id: domain.tenantId,
            fqdn: domain.fqdn,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await trx
          .updateTable('domains')
          .set({ id: domain.id, fqdn: domain.fqdn, updated_at: now })
          .where('tenant_id', '=', domain.tenantId)
          .execute();
      }
      return previous;
    },

    findDomain(trx: Executor, tenantId: string): Promise<DomainRow | undefined> {
      return trx
        .selectFrom('domains')
        .select(['id', 'tenant_id as tenantId', 'fqdn'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
    },

    /** Every tenant's current primary domain, for reconciliation. */
    listDomains(): Promise<DomainRow[]> {
      return db.kysely
        .selectFrom('domains')
        .select(['id', 'tenant_id as tenantId', 'fqdn'])
        .execute();
    },

    /** Returns the previous row (if `username`/`realm` changed), for projection cleanup. */
    async upsertExtension(
      trx: Executor,
      extension: ExtensionRow,
    ): Promise<ExtensionRow | undefined> {
      const previous = await trx
        .selectFrom('extensions')
        .select(['id', 'tenant_id as tenantId', 'number', 'username', 'ha1', 'realm'])
        .where('id', '=', extension.id)
        .executeTakeFirst();

      const now = new Date();
      if (previous === undefined) {
        await trx
          .insertInto('extensions')
          .values({
            id: extension.id,
            tenant_id: extension.tenantId,
            number: extension.number,
            username: extension.username,
            ha1: extension.ha1,
            realm: extension.realm,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await trx
          .updateTable('extensions')
          .set({
            number: extension.number,
            username: extension.username,
            ha1: extension.ha1,
            realm: extension.realm,
            updated_at: now,
          })
          .where('id', '=', extension.id)
          .execute();
      }
      return previous;
    },

    async deleteExtension(trx: Executor, id: string): Promise<ExtensionRow | undefined> {
      const existing = await trx
        .selectFrom('extensions')
        .select(['id', 'tenant_id as tenantId', 'number', 'username', 'ha1', 'realm'])
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) return undefined;

      await trx.deleteFrom('extensions').where('id', '=', id).execute();
      return existing;
    },

    listExtensionsForTenant(trx: Executor, tenantId: string): Promise<ExtensionRow[]> {
      return trx
        .selectFrom('extensions')
        .select(['id', 'tenant_id as tenantId', 'number', 'username', 'ha1', 'realm'])
        .where('tenant_id', '=', tenantId)
        .execute();
    },

    /** Every extension this service knows about, for reconciliation. */
    listExtensions(): Promise<ExtensionRow[]> {
      return db.kysely
        .selectFrom('extensions')
        .select(['id', 'tenant_id as tenantId', 'number', 'username', 'ha1', 'realm'])
        .execute();
    },

    /** `/fs/directory`'s domain lookup (S1-13): which tenant a SIP domain belongs to. */
    async findTenantIdByFqdn(fqdn: string): Promise<string | undefined> {
      const row = await db.kysely
        .selectFrom('domains')
        .select('tenant_id')
        .where('fqdn', '=', fqdn)
        .executeTakeFirst();
      return row?.tenant_id;
    },

    /**
     * `/fs/dialplan`'s ext→ext lookup (S1-13): a tenant's extension by its
     * current dialable number, not its (possibly stale) SIP `username`.
     */
    findExtensionByNumber(tenantId: string, number: string): Promise<ExtensionRow | undefined> {
      return db.kysely
        .selectFrom('extensions')
        .select(['id', 'tenant_id as tenantId', 'number', 'username', 'ha1', 'realm'])
        .where('tenant_id', '=', tenantId)
        .where('number', '=', number)
        .executeTakeFirst();
    },
  };
}

export type ReadModelRepo = ReturnType<typeof createReadModelRepo>;

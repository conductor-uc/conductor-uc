import { randomUUID } from 'node:crypto';

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

export interface TrunkRow {
  readonly id: string;
  readonly tenantId: string;
  readonly name: string;
  readonly authMode: string;
  readonly host: string;
  readonly port: number;
  readonly transport: string;
  readonly username: string | null;
  readonly secret: string | null;
  readonly fromDomain: string | null;
  readonly status: string;
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

    /** Returns the previous row, if any, so a consumer can clean up a stale projection (S2-02). */
    async upsertTrunk(trx: Executor, trunk: TrunkRow): Promise<TrunkRow | undefined> {
      const previous = await trx
        .selectFrom('trunks')
        .select([
          'id',
          'tenant_id as tenantId',
          'name',
          'auth_mode as authMode',
          'host',
          'port',
          'transport',
          'username',
          'secret',
          'from_domain as fromDomain',
          'status',
        ])
        .where('id', '=', trunk.id)
        .executeTakeFirst();

      const now = new Date();
      if (previous === undefined) {
        await trx
          .insertInto('trunks')
          .values({
            id: trunk.id,
            tenant_id: trunk.tenantId,
            name: trunk.name,
            auth_mode: trunk.authMode,
            host: trunk.host,
            port: trunk.port,
            transport: trunk.transport,
            username: trunk.username,
            secret: trunk.secret,
            from_domain: trunk.fromDomain,
            status: trunk.status,
            created_at: now,
            updated_at: now,
          })
          .execute();
      } else {
        await trx
          .updateTable('trunks')
          .set({
            name: trunk.name,
            auth_mode: trunk.authMode,
            host: trunk.host,
            port: trunk.port,
            transport: trunk.transport,
            username: trunk.username,
            secret: trunk.secret,
            from_domain: trunk.fromDomain,
            status: trunk.status,
            updated_at: now,
          })
          .where('id', '=', trunk.id)
          .execute();
      }
      return previous;
    },

    async deleteTrunk(trx: Executor, id: string): Promise<TrunkRow | undefined> {
      const existing = await trx
        .selectFrom('trunks')
        .select([
          'id',
          'tenant_id as tenantId',
          'name',
          'auth_mode as authMode',
          'host',
          'port',
          'transport',
          'username',
          'secret',
          'from_domain as fromDomain',
          'status',
        ])
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) return undefined;

      await trx.deleteFrom('trunk_ips').where('trunk_id', '=', id).execute();
      await trx.deleteFrom('trunks').where('id', '=', id).execute();
      return existing;
    },

    /** `/internal/v1/tenants/:tenantId/trunks/:id/status`'s lookup (S2-02). */
    findTrunkById(id: string): Promise<TrunkRow | undefined> {
      return db.kysely
        .selectFrom('trunks')
        .select([
          'id',
          'tenant_id as tenantId',
          'name',
          'auth_mode as authMode',
          'host',
          'port',
          'transport',
          'username',
          'secret',
          'from_domain as fromDomain',
          'status',
        ])
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** Every trunk this service knows about, for reconciliation. */
    listTrunks(): Promise<TrunkRow[]> {
      return db.kysely
        .selectFrom('trunks')
        .select([
          'id',
          'tenant_id as tenantId',
          'name',
          'auth_mode as authMode',
          'host',
          'port',
          'transport',
          'username',
          'secret',
          'from_domain as fromDomain',
          'status',
        ])
        .execute();
    },

    /** Every IP currently mirrored for a trunk. */
    listTrunkIps(trx: Executor, trunkId: string): Promise<string[]> {
      return trx
        .selectFrom('trunk_ips')
        .select('cidr')
        .where('trunk_id', '=', trunkId)
        .execute()
        .then((rows) => rows.map((row) => row.cidr));
    },

    /** Every (trunkId, cidr) pair this service knows about, for reconciliation. */
    listAllTrunkIps(): Promise<{ trunkId: string; cidr: string }[]> {
      return db.kysely
        .selectFrom('trunk_ips')
        .select(['trunk_id as trunkId', 'cidr'])
        .execute();
    },

    /**
     * Replaces a trunk's mirrored IP set and returns the diff (which CIDRs
     * were added/removed), so a consumer can add/remove exactly those rows
     * in `opensips.address` rather than reprojecting every IP unconditionally.
     */
    async replaceTrunkIps(
      trx: Executor,
      trunkId: string,
      cidrs: readonly string[],
    ): Promise<{ added: string[]; removed: string[] }> {
      const existing = await trx
        .selectFrom('trunk_ips')
        .select('cidr')
        .where('trunk_id', '=', trunkId)
        .execute()
        .then((rows) => new Set(rows.map((row) => row.cidr)));
      const desired = new Set(cidrs);

      const added = [...desired].filter((cidr) => !existing.has(cidr));
      const removed = [...existing].filter((cidr) => !desired.has(cidr));

      if (added.length + removed.length === 0) return { added: [], removed: [] };

      await trx.deleteFrom('trunk_ips').where('trunk_id', '=', trunkId).execute();
      if (cidrs.length > 0) {
        await trx
          .insertInto('trunk_ips')
          .values(
            cidrs.map((cidr) => ({
              id: randomUUID(),
              trunk_id: trunkId,
              cidr,
              created_at: new Date(),
            })),
          )
          .execute();
      }
      return { added, removed };
    },
  };
}

export type ReadModelRepo = ReturnType<typeof createReadModelRepo>;

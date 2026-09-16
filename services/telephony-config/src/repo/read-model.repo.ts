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
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
  /** S2-06 (G-1) — an `emergency_locations` id, resolved via `pbx-config-client.ts`'s `findEmergencyLocation` at the moment an emergency call actually needs it. */
  readonly emergencyLocationId: string;
}

const EXTENSION_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'number',
  'username',
  'ha1',
  'realm',
  'caller_id_name as callerIdName',
  'caller_id_number as callerIdNumber',
  'emergency_location_id as emergencyLocationId',
] as const;

export interface DidRow {
  readonly id: string;
  readonly tenantId: string;
  readonly e164: string;
  readonly trunkId: string;
  readonly destinationType: string;
  readonly destinationId: string;
}

export interface OutboundRouteRow {
  readonly id: string;
  readonly tenantId: string;
  readonly priority: number;
  readonly pattern: string;
  readonly trunkIds: readonly string[];
  readonly strip: number;
  readonly prepend: string | null;
}

/** S2-06 (G-1) — one per tenant, mirroring trunk-service's own `emergency_routes` singleton. */
export interface EmergencyRouteRow {
  readonly id: string;
  readonly tenantId: string;
  readonly trunkId: string;
  readonly numbers: readonly string[];
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
  readonly callerIdName: string | null;
  readonly callerIdNumber: string | null;
}

const TRUNK_COLUMNS = [
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
  'caller_id_name as callerIdName',
  'caller_id_number as callerIdNumber',
] as const;

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

    /** Returns the previous row (if anything changed), for projection cleanup. */
    async upsertExtension(
      trx: Executor,
      extension: ExtensionRow,
    ): Promise<ExtensionRow | undefined> {
      const previous = await trx
        .selectFrom('extensions')
        .select(EXTENSION_COLUMNS)
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
            caller_id_name: extension.callerIdName,
            caller_id_number: extension.callerIdNumber,
            emergency_location_id: extension.emergencyLocationId,
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
            caller_id_name: extension.callerIdName,
            caller_id_number: extension.callerIdNumber,
            emergency_location_id: extension.emergencyLocationId,
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
        .select(EXTENSION_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
      if (existing === undefined) return undefined;

      await trx.deleteFrom('extensions').where('id', '=', id).execute();
      return existing;
    },

    listExtensionsForTenant(trx: Executor, tenantId: string): Promise<ExtensionRow[]> {
      return trx
        .selectFrom('extensions')
        .select(EXTENSION_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .execute();
    },

    /** Every extension this service knows about, for reconciliation. */
    listExtensions(): Promise<ExtensionRow[]> {
      return db.kysely.selectFrom('extensions').select(EXTENSION_COLUMNS).execute();
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
        .select(EXTENSION_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('number', '=', number)
        .executeTakeFirst();
    },

    /**
     * `/fs/dialplan`'s from-trunk lookup (S2-03): a DID's `destination_id`
     * names an extension by id, not by number — this is the resolution step
     * from "which extension" to "what number to actually bridge to".
     */
    findExtensionById(id: string): Promise<ExtensionRow | undefined> {
      return db.kysely
        .selectFrom('extensions')
        .select(EXTENSION_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** Returns the previous row, if any, so a consumer can clean up a stale projection (S2-02). */
    async upsertTrunk(trx: Executor, trunk: TrunkRow): Promise<TrunkRow | undefined> {
      const previous = await trx
        .selectFrom('trunks')
        .select(TRUNK_COLUMNS)
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
            caller_id_name: trunk.callerIdName,
            caller_id_number: trunk.callerIdNumber,
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
            caller_id_name: trunk.callerIdName,
            caller_id_number: trunk.callerIdNumber,
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
        .select(TRUNK_COLUMNS)
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
        .select(TRUNK_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** Every trunk this service knows about, for reconciliation. */
    listTrunks(): Promise<TrunkRow[]> {
      return db.kysely.selectFrom('trunks').select(TRUNK_COLUMNS).execute();
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
      return db.kysely.selectFrom('trunk_ips').select(['trunk_id as trunkId', 'cidr']).execute();
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

    /** Upserts a DID's current state (S2-03), keyed by id (pbx-config-service's own primary key). */
    async upsertDid(trx: Executor, did: DidRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('dids')
        .values({
          id: did.id,
          tenant_id: did.tenantId,
          e164: did.e164,
          trunk_id: did.trunkId,
          destination_type: did.destinationType,
          destination_id: did.destinationId,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          e164: did.e164,
          trunk_id: did.trunkId,
          destination_type: did.destinationType,
          destination_id: did.destinationId,
          updated_at: now,
        })
        .execute();
    },

    async deleteDid(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('dids').where('id', '=', id).execute();
    },

    /**
     * `/fs/dialplan`'s from-trunk lookup (S2-03): a tenant's DID by its
     * dialed E.164 number. Scoped to `tenantId` — the tenant resolved from
     * the *trunk* the call arrived on, not anything the caller claims — so a
     * DID actually owned by a different tenant is simply not found here,
     * which is exactly the rejection 03 §2.1 and this task's own "Done when"
     * (a DID owned by tenant B arriving on tenant A's trunk) call for.
     */
    findDidByE164(tenantId: string, e164: string): Promise<DidRow | undefined> {
      return db.kysely
        .selectFrom('dids')
        .select([
          'id',
          'tenant_id as tenantId',
          'e164',
          'trunk_id as trunkId',
          'destination_type as destinationType',
          'destination_id as destinationId',
        ])
        .where('tenant_id', '=', tenantId)
        .where('e164', '=', e164)
        .executeTakeFirst();
    },

    /**
     * S2-04's caller-ID precedence, second tier: does this extension own one
     * of the tenant's own DIDs? (`projection.ts`'s `resolveOutboundCallerId`.)
     * Scoped to `tenantId` for the same reason `findDidByE164` is — belt and
     * suspenders alongside `destination_id`'s own uniqueness within a tenant.
     */
    findDidByDestination(tenantId: string, destinationId: string): Promise<DidRow | undefined> {
      return db.kysely
        .selectFrom('dids')
        .select([
          'id',
          'tenant_id as tenantId',
          'e164',
          'trunk_id as trunkId',
          'destination_type as destinationType',
          'destination_id as destinationId',
        ])
        .where('tenant_id', '=', tenantId)
        .where('destination_type', '=', 'extension')
        .where('destination_id', '=', destinationId)
        .executeTakeFirst();
    },

    /** ISO 3166-1 alpha-2, or `undefined` if not yet known (`org-client.ts`'s own comment on when that happens). */
    async findTenantCountry(tenantId: string): Promise<string | undefined> {
      const row = await db.kysely
        .selectFrom('tenants')
        .select('country')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      return row?.country ?? undefined;
    },

    async setTenantCountry(trx: Executor, tenantId: string, country: string): Promise<void> {
      await trx.updateTable('tenants').set({ country }).where('id', '=', tenantId).execute();
    },

    /**
     * The tenant's own small integer `dr_rules.groupid`/`X-Dr-Group-Id`
     * value (`schema.ts`'s own comment on `tenant_dr_groups` for why this
     * exists at all) — assigned the first time it's needed and stable after
     * that. `INSERT ... ON DUPLICATE KEY UPDATE tenant_id = tenant_id` is a
     * no-op write that still lets a single statement double as "insert if
     * missing, then tell me the id either way" without a races-prone
     * select-then-insert.
     */
    async findOrCreateDrGroupId(trx: Executor, tenantId: string): Promise<number> {
      await trx
        .insertInto('tenant_dr_groups')
        .values({ tenant_id: tenantId })
        .onDuplicateKeyUpdate({ tenant_id: tenantId })
        .execute();
      const row = await trx
        .selectFrom('tenant_dr_groups')
        .select('dr_group_id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow();
      return row.dr_group_id;
    },

    /**
     * Replaces one outbound route's mirrored row (S2-04) — same "local
     * mirror is the trusted desired state" pattern `trunks` already
     * establishes. Returns the previous row, if any, so `projection.ts` can
     * tell whether `dr_rules` actually needs re-writing.
     */
    async upsertOutboundRoute(trx: Executor, route: OutboundRouteRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('outbound_routes')
        .values({
          id: route.id,
          tenant_id: route.tenantId,
          priority: route.priority,
          pattern: route.pattern,
          trunk_ids: JSON.stringify(route.trunkIds),
          strip: route.strip,
          prepend: route.prepend,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          priority: route.priority,
          pattern: route.pattern,
          trunk_ids: JSON.stringify(route.trunkIds),
          strip: route.strip,
          prepend: route.prepend,
          updated_at: now,
        })
        .execute();
    },

    async deleteOutboundRoute(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('outbound_routes').where('id', '=', id).execute();
    },

    /** `/fs/dialplan`'s outbound branch (S2-04): a tenant's own routes, longest/most-specific pattern first. */
    findOutboundRoutesForTenant(tenantId: string): Promise<OutboundRouteRow[]> {
      return db.kysely
        .selectFrom('outbound_routes')
        .select([
          'id',
          'tenant_id as tenantId',
          'priority',
          'pattern',
          'trunk_ids as trunkIds',
          'strip',
          'prepend',
        ])
        .where('tenant_id', '=', tenantId)
        .orderBy('priority', 'asc')
        .execute()
        .then((rows) => rows.map(parseOutboundRouteRow));
    },

    /** Replaces the tenant's mirrored emergency route (S2-06) — same "local mirror is the trusted desired state" pattern `upsertOutboundRoute` establishes. */
    async upsertEmergencyRoute(trx: Executor, route: EmergencyRouteRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('emergency_routes')
        .values({
          id: route.id,
          tenant_id: route.tenantId,
          trunk_id: route.trunkId,
          numbers: JSON.stringify(route.numbers),
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          trunk_id: route.trunkId,
          numbers: JSON.stringify(route.numbers),
          updated_at: now,
        })
        .execute();
    },

    async deleteEmergencyRoute(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('emergency_routes').where('id', '=', id).execute();
    },

    /** `/fs/dialplan`'s emergency-number check (S2-06): a tenant's own single route, if it has one. */
    findEmergencyRouteForTenant(tenantId: string): Promise<EmergencyRouteRow | undefined> {
      return db.kysely
        .selectFrom('emergency_routes')
        .select(['id', 'tenant_id as tenantId', 'trunk_id as trunkId', 'numbers'])
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst()
        .then((row) => (row === undefined ? undefined : parseEmergencyRouteRow(row)));
    },
  };
}

/** `emergency_routes.numbers` is declared `json` — same driver-parsing quirk `parseOutboundRouteRow` documents. */
function parseEmergencyRouteRow(row: {
  id: string;
  tenantId: string;
  trunkId: string;
  numbers: unknown;
}): EmergencyRouteRow {
  return {
    ...row,
    numbers:
      typeof row.numbers === 'string'
        ? (JSON.parse(row.numbers) as string[])
        : (row.numbers as string[]),
  };
}

/** `outbound_routes.trunk_ids` is declared `json` — same driver-parsing quirk `trunks`' own columns document elsewhere in this file. */
function parseOutboundRouteRow(row: {
  id: string;
  tenantId: string;
  priority: number;
  pattern: string;
  trunkIds: unknown;
  strip: number;
  prepend: string | null;
}): OutboundRouteRow {
  return {
    ...row,
    trunkIds:
      typeof row.trunkIds === 'string'
        ? (JSON.parse(row.trunkIds) as string[])
        : (row.trunkIds as string[]),
  };
}

export type ReadModelRepo = ReturnType<typeof createReadModelRepo>;

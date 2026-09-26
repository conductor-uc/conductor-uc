import { parseCallHandling, type CallHandlingConfig } from '../domain/call-handling.js';
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

/** S2-08's own local mirror row — `member_extension_ids` stays a JSON string here, the same "JSON as text" choice `outbound_routes.trunk_ids` already made; `xml.ts`'s `buildRingGroupDialplanDocument` is what actually parses it. */
export interface RingGroupRow {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly strategy: string;
  readonly memberExtensionIds: string;
  readonly ringTimeoutSeconds: number;
  readonly noAnswerDestinationType: string | null;
  readonly noAnswerDestinationId: string | null;
}

const RING_GROUP_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'label',
  'strategy',
  'member_extension_ids as memberExtensionIds',
  'ring_timeout_seconds as ringTimeoutSeconds',
  'no_answer_destination_type as noAnswerDestinationType',
  'no_answer_destination_id as noAnswerDestinationId',
] as const;

/** S2-13's own local mirror row of a queue (`pbx-config-client.ts`'s `QueueConfig`). */
export interface QueueRow {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly strategy: string;
  readonly mohMediaAssetId: string | null;
  readonly maxWaitSeconds: number;
  readonly announcePosition: boolean;
  readonly announceFrequencySeconds: number | null;
  readonly noAgentDestinationType: string | null;
  readonly noAgentDestinationId: string | null;
}

const QUEUE_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'label',
  'strategy',
  'moh_media_asset_id as mohMediaAssetId',
  'max_wait_seconds as maxWaitSeconds',
  'announce_position as announcePosition',
  'announce_frequency_seconds as announceFrequencySeconds',
  'no_agent_destination_type as noAgentDestinationType',
  'no_agent_destination_id as noAgentDestinationId',
] as const;

/** S2-13's own local mirror row of an agent (`pbx-config-client.ts`'s `AgentConfig`). */
export interface AgentRow {
  readonly id: string;
  readonly tenantId: string;
  readonly extensionId: string;
  readonly maxNoAnswer: number;
  readonly wrapUpSeconds: number;
  readonly rejectDelaySeconds: number;
}

const AGENT_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'extension_id as extensionId',
  'max_no_answer as maxNoAnswer',
  'wrap_up_seconds as wrapUpSeconds',
  'reject_delay_seconds as rejectDelaySeconds',
] as const;

/** S2-13's own local mirror row of a queue tier (`pbx-config-client.ts`'s `QueueTierConfig`). */
export interface QueueTierRow {
  readonly id: string;
  readonly tenantId: string;
  readonly queueId: string;
  readonly agentId: string;
  readonly level: number;
  readonly position: number;
}

const QUEUE_TIER_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'queue_id as queueId',
  'agent_id as agentId',
  'level',
  'position',
] as const;

/** S2-14's own local mirror row of a parking lot (`pbx-config-client.ts`'s `ParkingLotConfig`). */
export interface ParkingLotRow {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly slotStart: number;
  readonly slotEnd: number;
  readonly timeoutSeconds: number;
  readonly returnDestinationType: string | null;
  readonly returnDestinationId: string | null;
}

const PARKING_LOT_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'label',
  'slot_start as slotStart',
  'slot_end as slotEnd',
  'timeout_seconds as timeoutSeconds',
  'return_destination_type as returnDestinationType',
  'return_destination_id as returnDestinationId',
] as const;

/** S2-15's own local mirror row of a conference room (`pbx-config-client.ts`'s `ConferenceRoomConfig`). No PIN here — `010_add_conference_rooms.ts`'s own comment on why. */
export interface ConferenceRoomRow {
  readonly id: string;
  readonly tenantId: string;
  readonly label: string;
  readonly number: string;
  readonly pinRequired: boolean;
  readonly maxMembers: number;
}

const CONFERENCE_ROOM_COLUMNS = [
  'id',
  'tenant_id as tenantId',
  'label',
  'number',
  'pin_required as pinRequired',
  'max_members as maxMembers',
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

    /** Upserts a ring group's current state (S2-08), keyed by id (pbx-config-service's own primary key) — the same shape `upsertDid` already establishes. */
    async upsertRingGroup(trx: Executor, ringGroup: RingGroupRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('ring_groups')
        .values({
          id: ringGroup.id,
          tenant_id: ringGroup.tenantId,
          label: ringGroup.label,
          strategy: ringGroup.strategy,
          member_extension_ids: ringGroup.memberExtensionIds,
          ring_timeout_seconds: ringGroup.ringTimeoutSeconds,
          no_answer_destination_type: ringGroup.noAnswerDestinationType,
          no_answer_destination_id: ringGroup.noAnswerDestinationId,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          label: ringGroup.label,
          strategy: ringGroup.strategy,
          member_extension_ids: ringGroup.memberExtensionIds,
          ring_timeout_seconds: ringGroup.ringTimeoutSeconds,
          no_answer_destination_type: ringGroup.noAnswerDestinationType,
          no_answer_destination_id: ringGroup.noAnswerDestinationId,
          updated_at: now,
        })
        .execute();
    },

    async deleteRingGroup(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('ring_groups').where('id', '=', id).execute();
    },

    /** `/fs/dialplan`'s from-trunk lookup, once a DID's destination resolves to a ring group (S2-08). */
    findRingGroupById(id: string): Promise<RingGroupRow | undefined> {
      return db.kysely
        .selectFrom('ring_groups')
        .select(RING_GROUP_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** Upserts a queue's current state (S2-13), keyed by id — the same shape `upsertRingGroup` already establishes. */
    async upsertQueue(trx: Executor, queue: QueueRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('queues')
        .values({
          id: queue.id,
          tenant_id: queue.tenantId,
          label: queue.label,
          strategy: queue.strategy,
          moh_media_asset_id: queue.mohMediaAssetId,
          max_wait_seconds: queue.maxWaitSeconds,
          announce_position: queue.announcePosition,
          announce_frequency_seconds: queue.announceFrequencySeconds,
          no_agent_destination_type: queue.noAgentDestinationType,
          no_agent_destination_id: queue.noAgentDestinationId,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          label: queue.label,
          strategy: queue.strategy,
          moh_media_asset_id: queue.mohMediaAssetId,
          max_wait_seconds: queue.maxWaitSeconds,
          announce_position: queue.announcePosition,
          announce_frequency_seconds: queue.announceFrequencySeconds,
          no_agent_destination_type: queue.noAgentDestinationType,
          no_agent_destination_id: queue.noAgentDestinationId,
          updated_at: now,
        })
        .execute();
    },

    async deleteQueue(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('queue_tiers').where('queue_id', '=', id).execute();
      await trx.deleteFrom('queues').where('id', '=', id).execute();
    },

    /** `/fs/dialplan`'s from-trunk lookup and `/fs/configuration`'s `callcenter.conf` builder both resolve against this (S2-13). */
    findQueueById(id: string): Promise<QueueRow | undefined> {
      return db.kysely
        .selectFrom('queues')
        .select(QUEUE_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** Every queue in a tenant. */
    findQueuesForTenant(tenantId: string): Promise<QueueRow[]> {
      return db.kysely
        .selectFrom('queues')
        .select(QUEUE_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .orderBy('label', 'asc')
        .execute();
    },

    /**
     * Every queue across every tenant — `/fs/configuration`'s `callcenter.conf`
     * builder walks all of them, then filters to the ones leased to the
     * requesting node (S2-13). One FS node's `callcenter.conf` genuinely can
     * span several tenants at once (each queue's own affinity lease is
     * independent), so this has no tenant scope to give it, the same "no
     * per-request tenant actor" reasoning this whole repo's own doc comment
     * already gives for why it isn't `scoped(ctx)`.
     */
    findAllQueues(): Promise<QueueRow[]> {
      return db.kysely.selectFrom('queues').select(QUEUE_COLUMNS).execute();
    },

    /** Upserts an agent's current state (S2-13). */
    async upsertAgent(trx: Executor, agent: AgentRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('agents')
        .values({
          id: agent.id,
          tenant_id: agent.tenantId,
          extension_id: agent.extensionId,
          max_no_answer: agent.maxNoAnswer,
          wrap_up_seconds: agent.wrapUpSeconds,
          reject_delay_seconds: agent.rejectDelaySeconds,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          extension_id: agent.extensionId,
          max_no_answer: agent.maxNoAnswer,
          wrap_up_seconds: agent.wrapUpSeconds,
          reject_delay_seconds: agent.rejectDelaySeconds,
          updated_at: now,
        })
        .execute();
    },

    async deleteAgent(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('queue_tiers').where('agent_id', '=', id).execute();
      await trx.deleteFrom('agents').where('id', '=', id).execute();
    },

    findAgentById(id: string): Promise<AgentRow | undefined> {
      return db.kysely
        .selectFrom('agents')
        .select(AGENT_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /** The agent login/logout feature codes resolve the *calling* extension to its agent identity (S2-13; `fs.routes.ts`'s `buildAgentStatusDialplanDocument`). */
    findAgentByExtensionId(tenantId: string, extensionId: string): Promise<AgentRow | undefined> {
      return db.kysely
        .selectFrom('agents')
        .select(AGENT_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
    },

    /**
     * Replaces a queue's entire tier list (S2-13) — the "thin event,
     * re-fetch current state" pattern applied at list granularity
     * (`projection.ts`'s `projectQueueTiers` doc comment on why a single
     * tier row has no stable id an event alone identifies it by).
     */
    async replaceQueueTiersForQueue(
      trx: Executor,
      tenantId: string,
      queueId: string,
      tiers: readonly QueueTierRow[],
    ): Promise<void> {
      await trx.deleteFrom('queue_tiers').where('queue_id', '=', queueId).execute();
      if (tiers.length === 0) return;
      await trx
        .insertInto('queue_tiers')
        .values(
          tiers.map((tier) => ({
            id: tier.id,
            tenant_id: tenantId,
            queue_id: queueId,
            agent_id: tier.agentId,
            level: tier.level,
            position: tier.position,
          })),
        )
        .execute();
    },

    /** Every tier row for a queue, in strategy-relevant order (S2-13; `callcenter.conf`'s own `<tier>` ordering). */
    findQueueTiersForQueue(queueId: string): Promise<QueueTierRow[]> {
      return db.kysely
        .selectFrom('queue_tiers')
        .select(QUEUE_TIER_COLUMNS)
        .where('queue_id', '=', queueId)
        .orderBy('level', 'asc')
        .orderBy('position', 'asc')
        .execute();
    },

    /** Upserts a parking lot's current state (S2-14), keyed by id — the same shape `upsertQueue` already establishes. */
    async upsertParkingLot(trx: Executor, lot: ParkingLotRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('parking_lots')
        .values({
          id: lot.id,
          tenant_id: lot.tenantId,
          label: lot.label,
          slot_start: lot.slotStart,
          slot_end: lot.slotEnd,
          timeout_seconds: lot.timeoutSeconds,
          return_destination_type: lot.returnDestinationType,
          return_destination_id: lot.returnDestinationId,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          label: lot.label,
          slot_start: lot.slotStart,
          slot_end: lot.slotEnd,
          timeout_seconds: lot.timeoutSeconds,
          return_destination_type: lot.returnDestinationType,
          return_destination_id: lot.returnDestinationId,
          updated_at: now,
        })
        .execute();
    },

    async deleteParkingLot(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('parking_lots').where('id', '=', id).execute();
    },

    findParkingLotById(id: string): Promise<ParkingLotRow | undefined> {
      return db.kysely
        .selectFrom('parking_lots')
        .select(PARKING_LOT_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /**
     * Every parking lot across every tenant — `/fs/configuration`'s
     * `valet_parking.conf` builder walks all of them, then filters to the
     * ones leased to the requesting node (S2-14), the same cross-tenant
     * reasoning `findAllQueues` already gives.
     */
    findAllParkingLots(): Promise<ParkingLotRow[]> {
      return db.kysely.selectFrom('parking_lots').select(PARKING_LOT_COLUMNS).execute();
    },

    /**
     * The lot whose slot range contains `slotNumber`, if any (S2-14;
     * `/fs/dialplan`'s park/retrieve branch) — a numeric range check done
     * here in TS rather than as an FS-side dialplan regex, since this
     * service already resolves the destination number before building any
     * response.
     */
    async findParkingLotBySlot(
      tenantId: string,
      slotNumber: number,
    ): Promise<ParkingLotRow | undefined> {
      const lots = await db.kysely
        .selectFrom('parking_lots')
        .select(PARKING_LOT_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .execute();
      return lots.find((lot) => slotNumber >= lot.slotStart && slotNumber <= lot.slotEnd);
    },

    /** Upserts a conference room's current state (S2-15), keyed by id — the same shape `upsertParkingLot` already establishes. */
    async upsertConferenceRoom(trx: Executor, room: ConferenceRoomRow): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('conference_rooms')
        .values({
          id: room.id,
          tenant_id: room.tenantId,
          label: room.label,
          number: room.number,
          pin_required: room.pinRequired,
          max_members: room.maxMembers,
          created_at: now,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({
          label: room.label,
          number: room.number,
          pin_required: room.pinRequired,
          max_members: room.maxMembers,
          updated_at: now,
        })
        .execute();
    },

    async deleteConferenceRoom(trx: Executor, id: string): Promise<void> {
      await trx.deleteFrom('conference_rooms').where('id', '=', id).execute();
    },

    findConferenceRoomById(id: string): Promise<ConferenceRoomRow | undefined> {
      return db.kysely
        .selectFrom('conference_rooms')
        .select(CONFERENCE_ROOM_COLUMNS)
        .where('id', '=', id)
        .executeTakeFirst();
    },

    /**
     * Every conference room across every tenant — mirrors `findAllParkingLots`'
     * own cross-tenant reasoning, though S2-15 has no `/fs/configuration`
     * binding to walk it with yet (`docs/decisions.md` G-50: the
     * `conference.conf` xml_curl binding was deliberately not built).
     */
    findAllConferenceRooms(): Promise<ConferenceRoomRow[]> {
      return db.kysely.selectFrom('conference_rooms').select(CONFERENCE_ROOM_COLUMNS).execute();
    },

    /** The room dialed by exact number, if any in this tenant (S2-15; `/fs/dialplan`'s conference-room branch) — unlike a parking lot's slot range, a room's number is a single value, so an exact-match query is enough. */
    findConferenceRoomByNumber(
      tenantId: string,
      number: string,
    ): Promise<ConferenceRoomRow | undefined> {
      return db.kysely
        .selectFrom('conference_rooms')
        .select(CONFERENCE_ROOM_COLUMNS)
        .where('tenant_id', '=', tenantId)
        .where('number', '=', number)
        .executeTakeFirst();
    },

    /** Upserts an extension's call handling (parity 1a), keyed by extension id. */
    async upsertCallHandling(
      trx: Executor,
      row: { extensionId: string; tenantId: string; settings: CallHandlingConfig },
    ): Promise<void> {
      const settings = JSON.stringify(row.settings);
      const now = new Date();
      await trx
        .insertInto('extension_call_handling')
        .values({
          extension_id: row.extensionId,
          tenant_id: row.tenantId,
          settings,
          updated_at: now,
        })
        .onDuplicateKeyUpdate({ tenant_id: row.tenantId, settings, updated_at: now })
        .execute();
    },

    async deleteCallHandling(trx: Executor, extensionId: string): Promise<void> {
      await trx
        .deleteFrom('extension_call_handling')
        .where('extension_id', '=', extensionId)
        .execute();
    },

    /** What `/fs/dialplan` reads on a call to an extension; undefined when none is configured. */
    async findCallHandling(extensionId: string): Promise<CallHandlingConfig | undefined> {
      const row = await db.kysely
        .selectFrom('extension_call_handling')
        .select('settings')
        .where('extension_id', '=', extensionId)
        .executeTakeFirst();
      return row === undefined ? undefined : parseCallHandling(row.settings);
    },

    async listCallHandlingForTenant(
      tenantId: string,
    ): Promise<{ extensionId: string; settings: CallHandlingConfig }[]> {
      const rows = await db.kysely
        .selectFrom('extension_call_handling')
        .select(['extension_id', 'settings'])
        .where('tenant_id', '=', tenantId)
        .execute();
      return rows.map((r) => ({
        extensionId: r.extension_id,
        settings: parseCallHandling(r.settings),
      }));
    },

    /**
     * Makes the tenant's mirrored call handling exactly `desired` (what
     * pbx-config-service says it is now): upserts rows that are missing or
     * differ, deletes rows it no longer has. Returns how many it repaired,
     * for the reconciler's log.
     */
    async syncCallHandlingForTenant(
      tenantId: string,
      desired: readonly { extensionId: string; settings: CallHandlingConfig }[],
    ): Promise<{ upserted: number; removed: number }> {
      const currentRows = await db.kysely
        .selectFrom('extension_call_handling')
        .select(['extension_id', 'settings'])
        .where('tenant_id', '=', tenantId)
        .execute();
      const current = new Map(
        currentRows.map(
          (r) => [r.extension_id, JSON.stringify(parseCallHandling(r.settings))] as const,
        ),
      );
      let upserted = 0;
      let removed = 0;
      const wanted = new Set<string>();
      const now = new Date();
      for (const row of desired) {
        wanted.add(row.extensionId);
        const settings = JSON.stringify(row.settings);
        if (current.get(row.extensionId) === settings) continue;
        await db.kysely
          .insertInto('extension_call_handling')
          .values({ extension_id: row.extensionId, tenant_id: tenantId, settings, updated_at: now })
          .onDuplicateKeyUpdate({ tenant_id: tenantId, settings, updated_at: now })
          .execute();
        upserted += 1;
      }
      for (const extensionId of current.keys()) {
        if (wanted.has(extensionId)) continue;
        await db.kysely
          .deleteFrom('extension_call_handling')
          .where('extension_id', '=', extensionId)
          .execute();
        removed += 1;
      }
      return { upserted, removed };
    },

    /**
     * S5-12: whether the tenant requires recording (fail closed). Read only when a recording
     * decision is unavailable. No row means fail open.
     */
    async findRecordingFailClosed(tenantId: string): Promise<boolean> {
      const row = await db.kysely
        .selectFrom('recording_settings')
        .select('fail_closed')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirst();
      return Boolean(row?.fail_closed ?? false);
    },

    /** S5-12: stores the tenant's fail-closed flag, from `recording.settings.updated`. */
    async upsertRecordingFailClosed(
      trx: Executor,
      tenantId: string,
      failClosed: boolean,
    ): Promise<void> {
      const now = new Date();
      await trx
        .insertInto('recording_settings')
        .values({ tenant_id: tenantId, fail_closed: failClosed, updated_at: now })
        .onDuplicateKeyUpdate({ fail_closed: failClosed, updated_at: now })
        .execute();
    },

    /**
     * S5-12 reconciliation: makes the stored flags match `failClosedTenantIds` (recording-service's
     * own list): listed tenants on, every other stored tenant off. Returns how many it changed.
     */
    async syncRecordingFailClosed(failClosedTenantIds: readonly string[]): Promise<number> {
      const wanted = new Set(failClosedTenantIds);
      const rows = await db.kysely
        .selectFrom('recording_settings')
        .select(['tenant_id', 'fail_closed'])
        .execute();
      const current = new Map(rows.map((r) => [r.tenant_id, Boolean(r.fail_closed)] as const));
      const now = new Date();
      let changed = 0;
      for (const tenantId of wanted) {
        if (current.get(tenantId) === true) continue;
        await db.kysely
          .insertInto('recording_settings')
          .values({ tenant_id: tenantId, fail_closed: true, updated_at: now })
          .onDuplicateKeyUpdate({ fail_closed: true, updated_at: now })
          .execute();
        changed += 1;
      }
      for (const [tenantId, failClosed] of current) {
        if (!failClosed || wanted.has(tenantId)) continue;
        await db.kysely
          .updateTable('recording_settings')
          .set({ fail_closed: false, updated_at: now })
          .where('tenant_id', '=', tenantId)
          .execute();
        changed += 1;
      }
      return changed;
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

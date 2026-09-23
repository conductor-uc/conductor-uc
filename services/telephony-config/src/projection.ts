import type { Transaction } from 'kysely';
import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { PbxConfigClient } from './pbx-config-client.js';
import type {
  EmergencyRouteRow,
  OutboundRouteRow,
  ReadModelRepo,
  TrunkRow,
} from './repo/read-model.repo.js';
import {
  DR_TAG_WIDTH,
  drTag,
  outboundGwid,
  stripLeadingPlus,
  type OpenSipsProjectionRepo,
} from './repo/opensips-projection.repo.js';
import type { TelephonyConfigDb } from './schema.js';
import type {
  EmergencyRouteConfig,
  OutboundRouteConfig,
  TrunkConfig,
  TrunkConfigClient,
} from './trunk-config-client.js';

/**
 * `dr_gateways.attrs` for a trunk with a register credential (S2-04) —
 * `route{}`'s outbound branch reads this back to answer a carrier's own
 * 401/407 challenge with `uac_auth()`. `null` for an ip-mode trunk with
 * nothing to authenticate with.
 */
function drGatewayAttrsFor(
  trunk: Pick<TrunkConfig, 'username' | 'secret' | 'host'>,
): string | null {
  if (trunk.username === null || trunk.secret === null) return null;
  return `${trunk.username}:${trunk.secret}:${trunk.host}`;
}

/** `203.0.113.0/24` -> `{ ip: '203.0.113.0', mask: 24 }` (03 §1's `address` table). */
export function parseCidr(cidr: string): { ip: string; mask: number } {
  const [ip, maskText] = cidr.split('/');
  return { ip: ip ?? cidr, mask: maskText === undefined ? 32 : Number(maskText) };
}

/**
 * The `(registrar, aor, bindingUri)` triple `uac_registrant`'s unique
 * constraint keys on (S2-02) — derived the same way every time, from a
 * trunk's own config plus this OpenSIPs cluster's own SIP URI (what the
 * carrier should send calls and challenges back to).
 */
export function registrantKeyFor(
  trunk: Pick<TrunkConfig, 'host' | 'port' | 'username' | 'fromDomain'>,
  opensipsSipUri: string,
): { registrar: string; aor: string; bindingUri: string } {
  return {
    registrar: `sip:${trunk.host}:${String(trunk.port)}`,
    aor: `sip:${trunk.username ?? ''}@${trunk.fromDomain ?? trunk.host}`,
    bindingUri: `sip:${opensipsSipUri}`,
  };
}

/**
 * The projection operations both consumers (`consumers/org.consumer.ts`,
 * `consumers/pbx.consumer.ts`) share (S1-12).
 *
 * Every write here happens in two uncoordinated steps — the `opensips`
 * schema (a separate DB connection/user, 05 §1.1) first, then the local
 * read model on the caller's own transaction — because the two schemas can
 * never share one MariaDB transaction. If the process dies between them, the
 * event is redelivered (it was never acked) and both steps simply run again;
 * every operation here is an upsert or an idempotent delete, so a retry is
 * safe. The reconciliation pass (`reconcile.ts`) is the backstop for
 * anything that isn't retried this way — a partial write left behind by a
 * crash that never resulted in a redelivery.
 */
export function createProjection(
  readModel: ReadModelRepo,
  opensips: OpenSipsProjectionRepo,
  mi: OpenSipsMiClient,
  pbxConfig: PbxConfigClient,
  logger: Logger,
  trunkConfig: TrunkConfigClient,
  /** This OpenSIPs cluster's own SIP URI, e.g. `opensips:5060` (`config.ts`'s `OPENSIPS_SIP_URI`). */
  opensipsSipUri: string,
) {
  return {
    /**
     * A tenant becoming active with a known domain: project `domain` and
     * trigger `domain_reload` (03 §2 — `domain` is db_mode=1, cached).
     */
    async activateDomain(fqdn: string, tenantId: string): Promise<void> {
      await opensips.upsertDomain(fqdn, tenantId);
      await mi.call('domain_reload');
    },

    /** A tenant being suspended, or losing its domain: remove it and reload. */
    async deactivateDomain(fqdn: string): Promise<void> {
      await opensips.deleteDomain(fqdn);
      await mi.call('domain_reload');
    },

    /**
     * Fetches an extension's current digest credential and projects it —
     * shared by `pbx.extension.created` and `.updated` (the latter is
     * otherwise a no-op for this service, since renumbering never touches
     * `sip_credentials`; re-fetching is cheap self-healing, not dead code).
     * A 404 from pbx-config-service means the extension is already gone
     * (raced with a delete) — nothing to project.
     *
     * `auth_db` queries MariaDB live (no cache), so no MI reload follows a
     * `subscriber` change.
     */
    async projectExtension(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      extensionId: string,
    ): Promise<void> {
      const credential = await pbxConfig.findCredential(tenantId, extensionId);
      if (credential === undefined) {
        logger.warn({ tenantId, extensionId }, 'extension not found in pbx-config-service');
        return;
      }

      const previous = await readModel.upsertExtension(trx, {
        id: extensionId,
        tenantId,
        number: credential.number,
        username: credential.username,
        ha1: credential.ha1,
        realm: credential.realm,
        callerIdName: credential.callerIdName,
        callerIdNumber: credential.callerIdNumber,
        emergencyLocationId: credential.emergencyLocationId,
      });

      if (
        previous !== undefined &&
        (previous.username !== credential.username || previous.realm !== credential.realm)
      ) {
        await opensips.deleteSubscriber(previous.username, previous.realm);
      }
      await opensips.upsertSubscriber(credential.username, credential.realm, credential.ha1);
    },

    /** `pbx.extension.deleted`: remove the local row and its subscriber projection. */
    async removeExtension(trx: Transaction<TelephonyConfigDb>, extensionId: string): Promise<void> {
      const removed = await readModel.deleteExtension(trx, extensionId);
      if (removed === undefined) return;
      await opensips.deleteSubscriber(removed.username, removed.realm);
    },

    /**
     * Fetches a DID's current state and mirrors it locally (S2-03) — shared
     * by `pbx.did.created` and `.updated`, the same "thin event, re-fetch
     * current state" story `projectExtension` tells. A DID has no `opensips`
     * schema counterpart at all (`schema.ts`'s own comment on `dids`): unlike
     * every other projection here, this never touches `opensips` or triggers
     * an MI reload — `/fs/dialplan`'s from-trunk lookup reads this local
     * mirror directly, on every inbound trunk call, so keeping it current is
     * the whole point. A 404 from pbx-config-service means the DID is
     * already gone (raced with a delete) — nothing to project.
     */
    async projectDid(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      didId: string,
    ): Promise<void> {
      const did = await pbxConfig.findDid(tenantId, didId);
      if (did === undefined) {
        logger.warn({ tenantId, didId }, 'DID not found in pbx-config-service');
        return;
      }

      await readModel.upsertDid(trx, {
        id: did.id,
        tenantId,
        e164: did.e164,
        trunkId: did.trunkId,
        destinationType: did.destinationType,
        destinationId: did.destinationId,
      });
    },

    /** `pbx.did.deleted`: remove the local mirror. Nothing else to clean up (no `opensips` projection). */
    async removeDid(trx: Transaction<TelephonyConfigDb>, didId: string): Promise<void> {
      await readModel.deleteDid(trx, didId);
    },

    /**
     * Fetches a ring group's current state and mirrors it locally (S2-08) —
     * shared by `pbx.ring_group.created` and `.updated`, the same "thin
     * event, re-fetch current state" story `projectDid` tells. No `opensips`
     * counterpart either: a ring group's own dial-string resolution is
     * entirely FS's own dialplan decision (`/fs/dialplan`'s ring-group
     * branch), not anything OpenSIPs' script needs to know about. A 404 from
     * pbx-config-service means the ring group is already gone (raced with a
     * delete) — nothing to project.
     */
    async projectRingGroup(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      ringGroupId: string,
    ): Promise<void> {
      const ringGroup = await pbxConfig.findRingGroup(tenantId, ringGroupId);
      if (ringGroup === undefined) {
        logger.warn({ tenantId, ringGroupId }, 'ring group not found in pbx-config-service');
        return;
      }

      await readModel.upsertRingGroup(trx, {
        id: ringGroup.id,
        tenantId,
        label: ringGroup.label,
        strategy: ringGroup.strategy,
        memberExtensionIds: JSON.stringify(ringGroup.memberExtensionIds),
        ringTimeoutSeconds: ringGroup.ringTimeoutSeconds,
        noAnswerDestinationType: ringGroup.noAnswerDestinationType,
        noAnswerDestinationId: ringGroup.noAnswerDestinationId,
      });
    },

    /** `pbx.ring_group.deleted`: remove the local mirror. Nothing else to clean up (no `opensips` projection). */
    async removeRingGroup(trx: Transaction<TelephonyConfigDb>, ringGroupId: string): Promise<void> {
      await readModel.deleteRingGroup(trx, ringGroupId);
    },

    /**
     * Fetches a queue's current state and mirrors it locally (S2-13) —
     * shared by `pbx.queue.created` and `.updated`, the same "thin event,
     * re-fetch current state" story `projectRingGroup` tells. No `opensips`
     * counterpart: a queue's config is entirely FS's own `mod_callcenter`
     * concern, reached through `/fs/configuration`'s `callcenter.conf`
     * builder, not anything OpenSIPs' script needs to know about.
     */
    async projectQueue(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      queueId: string,
    ): Promise<void> {
      const queue = await pbxConfig.findQueue(tenantId, queueId);
      if (queue === undefined) {
        logger.warn({ tenantId, queueId }, 'queue not found in pbx-config-service');
        return;
      }

      await readModel.upsertQueue(trx, {
        id: queue.id,
        tenantId,
        label: queue.label,
        strategy: queue.strategy,
        mohMediaAssetId: queue.mohMediaAssetId,
        maxWaitSeconds: queue.maxWaitSeconds,
        announcePosition: queue.announcePosition,
        announceFrequencySeconds: queue.announceFrequencySeconds,
        noAgentDestinationType: queue.noAgentDestinationType,
        noAgentDestinationId: queue.noAgentDestinationId,
      });
    },

    /** `pbx.queue.deleted`: remove the local mirror (its tiers cascade with it, `read-model.repo.ts`'s `deleteQueue`). */
    async removeQueue(trx: Transaction<TelephonyConfigDb>, queueId: string): Promise<void> {
      await readModel.deleteQueue(trx, queueId);
    },

    /** Fetches an agent's current state and mirrors it locally (S2-13) — shared by `pbx.agent.created` and `.updated`. */
    async projectAgent(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      agentId: string,
    ): Promise<void> {
      const agent = await pbxConfig.findAgent(tenantId, agentId);
      if (agent === undefined) {
        logger.warn({ tenantId, agentId }, 'agent not found in pbx-config-service');
        return;
      }

      await readModel.upsertAgent(trx, {
        id: agent.id,
        tenantId,
        extensionId: agent.extensionId,
        maxNoAnswer: agent.maxNoAnswer,
        wrapUpSeconds: agent.wrapUpSeconds,
        rejectDelaySeconds: agent.rejectDelaySeconds,
      });
    },

    /** `pbx.agent.deleted`: remove the local mirror (its tiers cascade with it, `read-model.repo.ts`'s `deleteAgent`). */
    async removeAgent(trx: Transaction<TelephonyConfigDb>, agentId: string): Promise<void> {
      await readModel.deleteAgent(trx, agentId);
    },

    /**
     * `pbx.queue_tier.added`/`.updated`/`.removed` all land here: rather
     * than trying to patch one row from an event that only ever carries
     * `{ queueId, agentId }` (no stable tier-row id of its own to key an
     * upsert on), this re-fetches the queue's *entire* current tier list
     * and replaces the local mirror wholesale (`read-model.repo.ts`'s
     * `replaceQueueTiersForQueue`) — correct for all three event types
     * (added/updated/removed) with one code path, at the cost of a list
     * fetch instead of a single-row one. Tiers change rarely enough
     * (console-driven config, not a call-setup-path write) that this cost
     * is not worth avoiding.
     */
    async projectQueueTiers(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      queueId: string,
    ): Promise<void> {
      const tiers = await pbxConfig.findQueueTiers(tenantId, queueId);
      await readModel.replaceQueueTiersForQueue(
        trx,
        tenantId,
        queueId,
        tiers.map((tier) => ({
          id: tier.id,
          tenantId,
          queueId: tier.queueId,
          agentId: tier.agentId,
          level: tier.level,
          position: tier.position,
        })),
      );
    },

    /**
     * Fetches a trunk's current full config (including its decrypted
     * secret and IPs) and projects it into `registrant` (register/both),
     * `address` (ip/both), and `dr_gateways` (always — 03 §1's LCR needs a
     * gateway row regardless of auth mode) — shared by `trunk.trunk.created`
     * and `.updated`, the same "thin event, re-fetch current state" story
     * `projectExtension` tells. A 404 from trunk-service means the trunk is
     * already gone (raced with a delete) — nothing to project.
     */
    async projectTrunk(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      trunkId: string,
    ): Promise<void> {
      const trunk = await trunkConfig.findTrunk(tenantId, trunkId);
      if (trunk === undefined) {
        logger.warn({ tenantId, trunkId }, 'trunk not found in trunk-service');
        return;
      }

      const previous = await readModel.upsertTrunk(trx, toTrunkRow(trunk));
      const needsRegistration = trunk.authMode === 'register' || trunk.authMode === 'both';
      const needsAddress = trunk.authMode === 'ip' || trunk.authMode === 'both';

      let reloadRegistrant = false;
      if (previous !== undefined) {
        const previousNeedsRegistration =
          previous.authMode === 'register' || previous.authMode === 'both';
        if (previousNeedsRegistration) {
          const previousKey = registrantKeyFor(previous, opensipsSipUri);
          const currentKey = registrantKeyFor(trunk, opensipsSipUri);
          if (
            !needsRegistration ||
            previousKey.aor !== currentKey.aor ||
            previousKey.registrar !== currentKey.registrar
          ) {
            await opensips.deleteRegistrant(
              previousKey.aor,
              previousKey.registrar,
              previousKey.bindingUri,
            );
            reloadRegistrant = true;
          }
        }
      }
      if (needsRegistration && trunk.username !== null && trunk.secret !== null) {
        const key = registrantKeyFor(trunk, opensipsSipUri);
        await opensips.upsertRegistrant({
          ...key,
          username: trunk.username,
          password: trunk.secret,
        });
        reloadRegistrant = true;
      }
      if (reloadRegistrant) await mi.call('reg_reload');

      const desiredIps = needsAddress ? trunk.ips : [];
      const { added, removed } = await readModel.replaceTrunkIps(trx, trunk.id, desiredIps);
      if (added.length + removed.length > 0) {
        await opensips.replaceAddresses(trunk.id, desiredIps.map(parseCidr));
        await mi.call('address_reload');
      }

      const gatewayChanged =
        previous === undefined ||
        previous.host !== trunk.host ||
        previous.port !== trunk.port ||
        previous.username !== trunk.username ||
        previous.secret !== trunk.secret;
      await opensips.upsertDrGateway({
        gwid: trunk.id,
        address: `${trunk.host}:${String(trunk.port)}`,
        description: trunk.name,
        attrs: drGatewayAttrsFor(trunk),
      });
      if (gatewayChanged) await mi.call('dr_reload');
    },

    /**
     * `trunk.trunk.deleted`: remove the local row and every projection it
     * fed — `registrant` (if it registered), `address` (if it had IPs), and
     * `dr_gateways` (always).
     */
    async removeTrunk(trx: Transaction<TelephonyConfigDb>, trunkId: string): Promise<void> {
      const removed = await readModel.deleteTrunk(trx, trunkId);
      if (removed === undefined) return;

      const neededRegistration = removed.authMode === 'register' || removed.authMode === 'both';
      if (neededRegistration) {
        const key = registrantKeyFor(removed, opensipsSipUri);
        await opensips.deleteRegistrant(key.aor, key.registrar, key.bindingUri);
        await mi.call('reg_reload');
      }

      const neededAddress = removed.authMode === 'ip' || removed.authMode === 'both';
      if (neededAddress) {
        await opensips.replaceAddresses(trunkId, []);
        await mi.call('address_reload');
      }

      await opensips.deleteDrGateway(trunkId);
      await mi.call('dr_reload');
    },

    /**
     * Fetches an outbound route's current definition and projects it into
     * `dr_rules` (S2-04) — shared by `trunk.outbound_route.created` and
     * `.updated`, the same "thin event, re-fetch current state" story every
     * other projection here tells. A 404 from trunk-service means the route
     * is already gone (raced with a delete) — nothing to project.
     */
    async projectOutboundRoute(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      outboundRouteId: string,
    ): Promise<void> {
      const route = await trunkConfig.findOutboundRoute(tenantId, outboundRouteId);
      if (route === undefined) {
        logger.warn({ tenantId, outboundRouteId }, 'outbound route not found in trunk-service');
        return;
      }

      const groupId = await readModel.findOrCreateDrGroupId(trx, tenantId);

      // Full replace, not a diff: an `.updated` event's own `trunkIds` may
      // have dropped a trunk since the last projection, and this is the
      // simplest way to guarantee no stale synthesized gateway lingers for
      // it — matches `replaceAddresses`' own "replace the whole set" shape
      // (S2-02), for the same reason (the vendored schema gives no natural
      // per-row upsert key to diff against cheaply).
      await opensips.deleteOutboundGatewaysForRoute(route.id);

      // A trunk this route names but that this service has not (yet, or
      // ever) projected is skipped rather than failing the whole route —
      // the same "honest miss, not a guess" discipline the rest of this
      // file follows; `reconcile.ts` has no equivalent repair pass for this
      // yet (docs/decisions.md gap).
      const gwids: string[] = [];
      for (const trunkId of route.trunkIds) {
        const trunk = await readModel.findTrunkById(trunkId);
        if (trunk === undefined) {
          logger.warn(
            { outboundRouteId: route.id, trunkId },
            'outbound route names a trunk this service has not projected; skipping it',
          );
          continue;
        }
        await opensips.upsertOutboundGateway({
          routeId: route.id,
          trunkId,
          address: `${trunk.host}:${String(trunk.port)}`,
          description: `${trunk.name} (${route.pattern || 'catch-all'})`,
          // Widened by `DR_TAG_WIDTH`: `$rU` reaching this gateway carries
          // the tenant's own tag ahead of the dialed number (G-28), and
          // `strip` must eat that tag too, not just the route's own value.
          strip: DR_TAG_WIDTH + route.strip,
          prepend: route.prepend,
          attrs: drGatewayAttrsFor(trunk),
        });
        gwids.push(outboundGwid(route.id, trunkId));
      }

      await readModel.upsertOutboundRoute(trx, toOutboundRouteRow(route));
      await opensips.upsertDrRule({
        routeId: route.id,
        // G-28/G-29: tenant-tagged and digit-only — `drouting` rejects a
        // leading `+` outright, and the tag is what `do_routing()`'s own
        // (now-omitted) group param can no longer provide.
        prefix: drTag(groupId) + stripLeadingPlus(route.pattern),
        priority: route.priority,
        gwlist: gwids,
      });
      await mi.call('dr_reload');
    },

    /**
     * `trunk.outbound_route.deleted`: remove the local mirror, every
     * synthesized per-route gateway it fed, and the `dr_rules` row itself.
     */
    async removeOutboundRoute(
      trx: Transaction<TelephonyConfigDb>,
      outboundRouteId: string,
    ): Promise<void> {
      await readModel.deleteOutboundRoute(trx, outboundRouteId);
      await opensips.deleteOutboundGatewaysForRoute(outboundRouteId);
      await opensips.deleteDrRule(outboundRouteId);
      await mi.call('dr_reload');
    },

    /**
     * Fetches the tenant's current emergency route and projects it into
     * `dr_rules` (S2-06; G-1) — shared by `trunk.emergency_route.created`
     * and `.updated`, the same "thin event, re-fetch current state" story
     * `projectOutboundRoute` tells. One synthesized gateway (reused across
     * every number — there is only ever one trunk), but one `dr_rules` row
     * *per number*: `drouting`'s own `prefix` matches a single value, and
     * `emergency_routes.numbers` can list more than one (e.g. `911`, a
     * local equivalent). No `strip`/`prepend` — G-1's own "direct dial, no
     * prefix" means the number reaches the carrier exactly as dialed, and
     * `strip` only needs to eat this route's own tenant tag, not
     * `route.strip` (there is no such field here at all).
     */
    async projectEmergencyRoute(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      emergencyRouteId: string,
    ): Promise<void> {
      const route = await trunkConfig.findEmergencyRoute(tenantId);
      if (route === undefined || route.id !== emergencyRouteId) {
        logger.warn(
          { tenantId, emergencyRouteId },
          'emergency route not found (or superseded) in trunk-service',
        );
        return;
      }

      const groupId = await readModel.findOrCreateDrGroupId(trx, tenantId);
      await opensips.deleteOutboundGatewaysForRoute(route.id);
      await opensips.deleteDrRulesByDescriptionPrefix(route.id);

      const trunk = await readModel.findTrunkById(route.trunkId);
      if (trunk === undefined) {
        logger.warn(
          { emergencyRouteId: route.id, trunkId: route.trunkId },
          'emergency route names a trunk this service has not projected; skipping it',
        );
        await readModel.upsertEmergencyRoute(trx, toEmergencyRouteRow(route));
        await mi.call('dr_reload');
        return;
      }

      await opensips.upsertOutboundGateway({
        routeId: route.id,
        trunkId: route.trunkId,
        address: `${trunk.host}:${String(trunk.port)}`,
        description: `${trunk.name} (emergency)`,
        strip: DR_TAG_WIDTH,
        prepend: null,
        attrs: drGatewayAttrsFor(trunk),
      });
      const gwid = outboundGwid(route.id, route.trunkId);

      for (const number of route.numbers) {
        await opensips.upsertDrRule({
          routeId: `${route.id}:${number}`,
          prefix: drTag(groupId) + number,
          priority: 0,
          gwlist: [gwid],
        });
      }

      await readModel.upsertEmergencyRoute(trx, toEmergencyRouteRow(route));
      await mi.call('dr_reload');
    },

    /**
     * `trunk.emergency_route.deleted`: remove the local mirror, the
     * synthesized gateway, and every per-number `dr_rules` row it fed.
     */
    async removeEmergencyRoute(
      trx: Transaction<TelephonyConfigDb>,
      emergencyRouteId: string,
    ): Promise<void> {
      await readModel.deleteEmergencyRoute(trx, emergencyRouteId);
      await opensips.deleteOutboundGatewaysForRoute(emergencyRouteId);
      await opensips.deleteDrRulesByDescriptionPrefix(emergencyRouteId);
      await mi.call('dr_reload');
    },
  };
}

function toOutboundRouteRow(route: OutboundRouteConfig): OutboundRouteRow {
  return {
    id: route.id,
    tenantId: route.tenantId,
    priority: route.priority,
    pattern: route.pattern,
    trunkIds: route.trunkIds,
    strip: route.strip,
    prepend: route.prepend,
  };
}

function toEmergencyRouteRow(route: EmergencyRouteConfig): EmergencyRouteRow {
  return {
    id: route.id,
    tenantId: route.tenantId,
    trunkId: route.trunkId,
    numbers: route.numbers,
  };
}

function toTrunkRow(trunk: TrunkConfig): TrunkRow {
  return {
    id: trunk.id,
    tenantId: trunk.tenantId,
    name: trunk.name,
    authMode: trunk.authMode,
    host: trunk.host,
    port: trunk.port,
    transport: trunk.transport,
    username: trunk.username,
    secret: trunk.secret,
    fromDomain: trunk.fromDomain,
    status: trunk.status,
    callerIdName: trunk.callerIdPolicy?.name ?? null,
    callerIdNumber: trunk.callerIdPolicy?.number ?? null,
  };
}

export type Projection = ReturnType<typeof createProjection>;

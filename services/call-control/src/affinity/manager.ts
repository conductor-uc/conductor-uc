import {
  createAffinityRegistry,
  type AffinityKind,
  type AffinityLease,
  type AffinityRegistry,
} from '@cuc/affinity';
import type { Logger } from '@cuc/logger';
import type { Redis } from 'ioredis';

import type { EslClient } from '../esl/client.js';
import type { CallRegistry } from '../redis/registry.js';

export interface AcquireResult {
  /** The node that now holds the lease — the existing holder if there was one, otherwise the node just chosen. */
  readonly nodeId: string;
  /** True only when this call is the one that newly won the lease (and therefore triggered the FS reload commands below). */
  readonly acquired: boolean;
}

export interface AffinityManagerOptions {
  readonly redis: Redis;
  readonly keyPrefix: string;
  readonly callRegistry: CallRegistry;
  /** One ESL client per configured FS node, keyed by node id — how the manager reaches the node it just chose (04 §3.3: "call-control sends `xml_flush_cache` and module reload commands to the chosen node"). */
  readonly eslClients: ReadonlyMap<string, EslClient>;
  readonly logger: Logger;
  /** 04 §3.3: "30 s lease". */
  readonly leaseTtlMs: number;
  /** 04 §3.3: "renewed every 10 s by call-control while the resource is active on that node". */
  readonly renewIntervalMs: number;
}

export interface AcquireOptions {
  /** Sent as `api <command>` to the chosen node, after `xml_flush_cache`, only on a fresh acquire — e.g. a queue's own `callcenter_config reload` (S2-13's concern, not this one's). */
  readonly reloadCommands?: readonly string[];
  /**
   * S2-13: when a call is already anchored on a specific node (a DID's own
   * `from-trunk` dialplan, or a flow already running there) and the
   * resource is not yet leased to anyone, 04 §3.3's "otherwise the runner
   * acquires the lease locally" means *that* node, not whichever one this
   * manager would otherwise load-balance to — transferring an in-progress
   * call to a different node for a resource nothing else has claimed yet
   * would be a pointless hairpin. Ignored if the resource is already leased
   * (existing holder wins regardless) or if this node is not currently live
   * (falls back to the least-loaded live node instead, since granting a
   * lease to a dead node would just strand it until the 30 s TTL lapses).
   */
  readonly preferredNodeId?: string;
}

export interface AffinityManager {
  /**
   * Returns the resource's current lease holder, acquiring it if nothing
   * holds it yet (04 §3.3's own "Acquisition" paragraph) — on
   * `preferredNodeId` when given and live, otherwise the least-loaded live
   * node. Idempotent: calling this again for a lease this manager already
   * won just returns the same node, without repeating the FS reload
   * commands.
   */
  acquire(
    tenantId: string,
    kind: AffinityKind,
    resourceId: string,
    options?: AcquireOptions,
  ): Promise<AcquireResult>;
  /**
   * Releases the lease and stops renewing it — "When a resource goes idle
   * ... the lease is allowed to lapse" (04 §3.3): deciding *when* a
   * resource is idle belongs to whichever future caller owns that resource
   * kind (S2-13/14/15), not to this manager.
   */
  release(tenantId: string, kind: AffinityKind, resourceId: string): Promise<void>;
  getOwner(tenantId: string, kind: AffinityKind, resourceId: string): Promise<string | undefined>;
  /**
   * S4-02 (G-123): releases every lease the node holds, so the next call to each of those queues,
   * parking lots and conferences acquires it again on a node in service. Called when the node is
   * drained, after it has stopped counting as live. The calls already there stay where they are;
   * a busy conference can briefly run on two nodes (revisited in S4-05). A lease another replica
   * renews is released all the same: its renewal fails and that replica stops. Returns how many
   * were released.
   */
  handOver(nodeId: string): Promise<number>;
  /** S4-02: the leases a node holds now, whichever replica renews them. */
  leasesHeldBy(nodeId: string): Promise<AffinityLease[]>;
  /**
   * S4-03: renews every lease the node holds, whichever replica acquired it. The node's owner
   * does this on every renewal interval, so a busy queue, parking lot or conference keeps its node
   * when the replica that acquired its lease dies. Returns how many were renewed.
   */
  renewHeldBy(nodeId: string): Promise<number>;
  /**
   * S4-04 (04 §5): after Redis lost its data, sets again every lease this replica was renewing,
   * to the node it was on (`SET NX`: a lease someone else has since taken is theirs, and this
   * replica stops renewing it). Returns how many were restored.
   */
  restore(): Promise<number>;
  /** Clears every renewal timer without releasing the underlying leases — process shutdown, not resource teardown (a lease this replica was renewing simply lapses on its own 30 s TTL if nothing else renews it). */
  stop(): void;
}

function leaseTrackingKey(tenantId: string, kind: AffinityKind, resourceId: string): string {
  return `${tenantId}:${kind}:${resourceId}`;
}

export function createAffinityManager(options: AffinityManagerOptions): AffinityManager {
  const { redis, keyPrefix, callRegistry, eslClients, logger, leaseTtlMs, renewIntervalMs } =
    options;
  const registry: AffinityRegistry = createAffinityRegistry(redis, keyPrefix);

  // Renewal timers this replica is running, keyed by lease. Only a lease
  // *this* manager just acquired gets one — 04 §3.3 puts the renewal duty on
  // "call-control" generically, and one replica actively renewing per lease
  // is what that requires, not every replica renewing every lease.
  const renewals = new Map<
    string,
    { nodeId: string; lease: AffinityLease; timer: ReturnType<typeof setInterval> }
  >();

  async function chooseNode(preferredNodeId: string | undefined): Promise<string> {
    const liveNodeIds = await callRegistry.liveNodeIds();
    if (liveNodeIds.length === 0) {
      throw new Error('no live FreeSWITCH nodes available to acquire an affinity lease');
    }
    if (preferredNodeId !== undefined && liveNodeIds.includes(preferredNodeId)) {
      return preferredNodeId;
    }

    const loads = await Promise.all(
      liveNodeIds.map((nodeId) => callRegistry.callsForNode(nodeId).then((calls) => calls.length)),
    );

    let chosen = liveNodeIds[0] as string;
    let chosenLoad = loads[0] as number;
    for (let i = 1; i < liveNodeIds.length; i++) {
      const load = loads[i] as number;
      if (load < chosenLoad) {
        chosen = liveNodeIds[i] as string;
        chosenLoad = load;
      }
    }
    return chosen;
  }

  async function sendReloadCommands(
    nodeId: string,
    resourceId: string,
    kind: AffinityKind,
    reloadCommands: readonly string[],
  ): Promise<void> {
    const client = eslClients.get(nodeId);
    if (client === undefined) {
      logger.error({ nodeId, kind, resourceId }, 'affinity: no ESL client for the chosen node');
      return;
    }
    for (const command of ['xml_flush_cache', ...reloadCommands]) {
      try {
        const result = await client.sendApi(command);
        if (!result.ok) {
          logger.warn(
            { nodeId, kind, resourceId, command, body: result.body },
            'affinity: FS reload command failed',
          );
        }
      } catch (error) {
        logger.error(
          { nodeId, kind, resourceId, command, err: error },
          'affinity: could not send FS reload command',
        );
      }
    }
  }

  function startRenewing(
    tenantId: string,
    kind: AffinityKind,
    resourceId: string,
    nodeId: string,
  ): void {
    const trackingKey = leaseTrackingKey(tenantId, kind, resourceId);
    const timer = setInterval(() => {
      void registry
        .renew({ tenantId, kind, resourceId }, nodeId, leaseTtlMs)
        .then((renewed: boolean) => {
          if (!renewed) {
            logger.warn(
              { tenantId, kind, resourceId, nodeId },
              'affinity: lost the lease; stopped renewing',
            );
            const tracked = renewals.get(trackingKey);
            if (tracked !== undefined && tracked.nodeId === nodeId) {
              clearInterval(tracked.timer);
              renewals.delete(trackingKey);
            }
          }
        });
    }, renewIntervalMs);
    renewals.set(trackingKey, { nodeId, lease: { tenantId, kind, resourceId }, timer });
  }

  return {
    async acquire(tenantId, kind, resourceId, options = {}) {
      const { reloadCommands = [], preferredNodeId } = options;
      const lease = { tenantId, kind, resourceId };
      const trackingKey = leaseTrackingKey(tenantId, kind, resourceId);

      // Redis, not this replica's memory, says who holds it (S4-03): with several replicas,
      // another may have released it since (a drain, a dead node), and answering from memory
      // would send the call to the old node (found live).
      const existingOwner = await registry.getOwner(lease);
      const tracked = renewals.get(trackingKey);
      if (tracked !== undefined && tracked.nodeId !== existingOwner) {
        clearInterval(tracked.timer);
        renewals.delete(trackingKey);
      }
      if (existingOwner !== undefined) return { nodeId: existingOwner, acquired: false };

      const chosenNodeId = await chooseNode(preferredNodeId);
      const won = await registry.acquire(lease, chosenNodeId, leaseTtlMs);
      if (!won) {
        // Lost a race against a concurrent acquire between the read above and this write.
        const owner = await registry.getOwner(lease);
        if (owner === undefined) {
          throw new Error(`affinity: could not acquire or read back the lease for ${trackingKey}`);
        }
        return { nodeId: owner, acquired: false };
      }

      await sendReloadCommands(chosenNodeId, resourceId, kind, reloadCommands);
      startRenewing(tenantId, kind, resourceId, chosenNodeId);
      return { nodeId: chosenNodeId, acquired: true };
    },

    async release(tenantId, kind, resourceId) {
      const lease = { tenantId, kind, resourceId };
      const trackingKey = leaseTrackingKey(tenantId, kind, resourceId);

      const tracked = renewals.get(trackingKey);
      if (tracked !== undefined) {
        clearInterval(tracked.timer);
        renewals.delete(trackingKey);
        await registry.release(lease, tracked.nodeId);
        return;
      }

      // Not a lease this replica is renewing (a different replica acquired
      // it, or this process restarted) — best-effort release against
      // whoever currently holds it.
      const owner = await registry.getOwner(lease);
      if (owner !== undefined) await registry.release(lease, owner);
    },

    async getOwner(tenantId, kind, resourceId) {
      return registry.getOwner({ tenantId, kind, resourceId });
    },

    async leasesHeldBy(nodeId) {
      return registry.leasesHeldBy(nodeId);
    },

    async renewHeldBy(nodeId) {
      let renewed = 0;
      for (const lease of await registry.leasesHeldBy(nodeId)) {
        if (await registry.renew(lease, nodeId, leaseTtlMs)) renewed += 1;
      }
      return renewed;
    },

    async restore() {
      let restored = 0;
      for (const [trackingKey, tracked] of [...renewals.entries()]) {
        if (await registry.acquire(tracked.lease, tracked.nodeId, leaseTtlMs)) {
          restored += 1;
          continue;
        }
        const owner = await registry.getOwner(tracked.lease);
        if (owner !== tracked.nodeId) {
          clearInterval(tracked.timer);
          renewals.delete(trackingKey);
        }
      }
      if (restored > 0)
        logger.info({ restored }, 'affinity: leases set again after Redis lost them');
      return restored;
    },

    async handOver(nodeId) {
      let released = 0;
      for (const lease of await registry.leasesHeldBy(nodeId)) {
        const trackingKey = leaseTrackingKey(lease.tenantId, lease.kind, lease.resourceId);
        const tracked = renewals.get(trackingKey);
        if (tracked !== undefined && tracked.nodeId === nodeId) {
          clearInterval(tracked.timer);
          renewals.delete(trackingKey);
        }
        if (await registry.release(lease, nodeId)) released++;
      }
      if (released > 0) logger.info({ nodeId, released }, "affinity: handed over a node's leases");
      return released;
    },

    stop() {
      for (const { timer } of renewals.values()) clearInterval(timer);
      renewals.clear();
    },
  };
}

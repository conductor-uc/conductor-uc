import { enqueueEvent } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Kysely } from 'kysely';

import type { AffinityManager } from './affinity/manager.js';
import { callEvents } from './events.js';
import type { CallRegistry, NodeState } from './redis/registry.js';
import type { CallControlDb } from './schema.js';

export interface NodeDrainOptions {
  readonly db: Kysely<CallControlDb>;
  readonly registry: CallRegistry;
  readonly affinity: AffinityManager;
  /** The configured nodes (`FS_NODES`), in their configured order. */
  readonly nodeIds: readonly string[];
  readonly logger: Logger;
}

export interface NodeView extends NodeState {
  /** Resource leases (queues, parking lots, conferences) the node holds now. */
  readonly leases: number;
}

export interface DrainResult {
  readonly node: NodeView;
  /** Leases released by this drain (always 0 when undraining). */
  readonly leasesHandedOver: number;
}

export interface NodeDrain {
  list(): Promise<NodeView[]>;
  /** Undefined when the node is not one of `FS_NODES`. */
  get(nodeId: string): Promise<NodeView | undefined>;
  /** Undefined when the node is not one of `FS_NODES`. */
  setDraining(nodeId: string, draining: boolean): Promise<DrainResult | undefined>;
}

/**
 * S4-02 (G-123; 04 §6): taking an FS node out of service for a rolling upgrade, and putting it
 * back. Draining, in this order:
 *
 * 1. marks the node draining in the registry, so it stops counting as live and wins no new lease;
 * 2. commits `call.node.drain_changed`, on which telephony-config takes the node's dispatcher
 *    destination out of rotation, so OpenSIPs sends it no new calls (this service never writes
 *    OpenSIPs' tables);
 * 3. hands its leases over (`AffinityManager.handOver`), so the next caller to each of its
 *    queues, parking lots and conferences re-pins on a node in service.
 *
 * Calls already on the node are left alone; the node is stopped once its call count is 0.
 * Undraining clears the mark and commits the event; leases come back as resources are next used.
 * Both are idempotent, so repeating one after a failure is the retry.
 */
export function createNodeDrain(options: NodeDrainOptions): NodeDrain {
  const { db, registry, affinity, nodeIds, logger } = options;
  const configured = new Set(nodeIds);

  async function views(ids: readonly string[]): Promise<NodeView[]> {
    const states = await registry.nodeStates(ids);
    return Promise.all(
      states.map(async (state) => ({
        ...state,
        leases: await affinity.leasesHeldBy(state.nodeId).then((held) => held.length),
      })),
    );
  }

  return {
    list: () => views(nodeIds),

    async get(nodeId) {
      if (!configured.has(nodeId)) return undefined;
      return (await views([nodeId]))[0];
    },

    async setDraining(nodeId, draining) {
      if (!configured.has(nodeId)) return undefined;
      await registry.setDraining(nodeId, draining);
      await enqueueEvent(db, callEvents, {
        type: 'call.node.drain_changed',
        data: { nodeId, draining },
      });
      const leasesHandedOver = draining ? await affinity.handOver(nodeId) : 0;
      logger.info({ nodeId, draining, leasesHandedOver }, 'fs node drain changed');
      const [node] = await views([nodeId]);
      return { node: node as NodeView, leasesHandedOver };
    },
  };
}

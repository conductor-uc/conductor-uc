import { recordAuditEvent } from '@cuc/audit';
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

/** S4-12: who asked, for the audit event a console action writes. */
export interface NodeActor {
  readonly type: 'user' | 'apikey' | 'service';
  readonly id: string;
  readonly orgId: string;
  readonly ip?: string;
  readonly requestId?: string;
}

export interface NodeDrain {
  list(): Promise<NodeView[]>;
  /** Undefined when the node is not one of `FS_NODES`. */
  get(nodeId: string): Promise<NodeView | undefined>;
  /**
   * Undefined when the node is not one of `FS_NODES`. With an actor (the operations console,
   * S4-12), an audit event is committed with the domain event.
   */
  setDraining(
    nodeId: string,
    draining: boolean,
    actor?: NodeActor,
  ): Promise<DrainResult | undefined>;
  /**
   * S4-12 (G-124): the node's share of new calls (1 to 999). Commits `call.node.weight_changed`,
   * which telephony-config writes to the node's dispatcher row; this service keeps no copy.
   * Undefined when the node is not one of `FS_NODES`.
   */
  setWeight(nodeId: string, weight: number, actor?: NodeActor): Promise<NodeView | undefined>;
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

  /** The domain event, and the audit event when a person asked, in one transaction. */
  async function commit(
    event:
      | { type: 'call.node.drain_changed'; data: { nodeId: string; draining: boolean } }
      | { type: 'call.node.weight_changed'; data: { nodeId: string; weight: number } },
    action: string,
    actor: NodeActor | undefined,
  ): Promise<void> {
    await db.transaction().execute(async (trx) => {
      await enqueueEvent(trx, callEvents, event);
      if (actor === undefined) return;
      await recordAuditEvent(trx, {
        actorType: actor.type,
        actorId: actor.id,
        actorOrgId: actor.orgId,
        action,
        resource: `fs-node:${event.data.nodeId}`,
        dataClass: 'config',
        ...(event.type === 'call.node.weight_changed'
          ? { reason: `weight ${String(event.data.weight)}` }
          : {}),
        ...(actor.ip === undefined ? {} : { ip: actor.ip }),
        ...(actor.requestId === undefined ? {} : { requestId: actor.requestId }),
      });
    });
  }

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

    async setDraining(nodeId, draining, actor) {
      if (!configured.has(nodeId)) return undefined;
      await registry.setDraining(nodeId, draining);
      await commit(
        { type: 'call.node.drain_changed', data: { nodeId, draining } },
        draining ? 'platform.node.drained' : 'platform.node.undrained',
        actor,
      );
      const leasesHandedOver = draining ? await affinity.handOver(nodeId) : 0;
      logger.info({ nodeId, draining, leasesHandedOver }, 'fs node drain changed');
      const [node] = await views([nodeId]);
      return { node: node as NodeView, leasesHandedOver };
    },

    async setWeight(nodeId, weight, actor) {
      if (!configured.has(nodeId)) return undefined;
      await commit(
        { type: 'call.node.weight_changed', data: { nodeId, weight } },
        'platform.node.weight_changed',
        actor,
      );
      logger.info({ nodeId, weight }, 'fs node weight changed');
      return (await views([nodeId]))[0];
    },
  };
}

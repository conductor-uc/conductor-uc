import type { Redis } from 'ioredis';

import type { Logger } from '@cuc/logger';

export interface NodeOwnershipOptions {
  readonly redis: Redis;
  readonly keyPrefix: string;
  /** This process, as other replicas see it in `nodeowner:{id}`. */
  readonly replicaId: string;
  readonly nodeIds: readonly string[];
  /** Whether this replica's event socket to the node is up; only a connected replica may own it. */
  readonly isConnected: (nodeId: string) => boolean;
  /** This replica now owns the node: handle its events, heartbeat it, and catch up on its calls. */
  readonly onAcquired: (nodeId: string) => void;
  /** This replica no longer owns the node. */
  readonly onLost: (nodeId: string) => void;
  readonly logger: Logger;
  readonly leaseTtlMs?: number;
  readonly intervalMs?: number;
}

/**
 * How long an owner's claim lasts without renewal. With {@link NODE_OWNER_INTERVAL_MS}, a node
 * whose owner dies is taken over within 8 s, inside the node heartbeat's 10 s expiry, so the node
 * is never declared dead for its owner's death (04 §2: "≤ 10 s").
 */
export const NODE_OWNER_TTL_MS = 6_000;
/** How often each replica renews what it owns and tries to own what nobody does. */
export const NODE_OWNER_INTERVAL_MS = 2_000;

/** KEYS: nodeowner:{id}. ARGV: replica id, TTL (ms). 1 if this replica owned it and still does. */
const RENEW = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('PEXPIRE', KEYS[1], ARGV[2]) end return 0`;
/** KEYS: nodeowner:{id}. ARGV: replica id. Deletes the claim only if it is this replica's. */
const RELEASE = `if redis.call('GET', KEYS[1]) == ARGV[1] then return redis.call('DEL', KEYS[1]) end return 0`;

/**
 * S4-03 (04 §2, 10 §3): with several call-control replicas, each FreeSWITCH node has exactly one
 * owner, by a lease in Redis (`nodeowner:{id}` = the replica, `SET NX PX`). Every replica stays
 * connected to every node, so any replica can serve any request and send the node commands; only
 * the owner handles the node's events (the registry, the outbox), heartbeats it, and renews the
 * leases of the queues, parking lots and conference rooms on it. The others drop its events.
 *
 * Every {@link NODE_OWNER_INTERVAL_MS} each replica renews the nodes it owns and claims any
 * connected node nobody owns. A replica whose socket to a node drops gives the node up at once, so
 * a replica still connected takes it. A replica that dies simply stops renewing, and another takes
 * its nodes within the lease's expiry. One that shuts down gives its nodes up first
 * ({@link stop}).
 */
export function createNodeOwnership(options: NodeOwnershipOptions) {
  const { redis, keyPrefix, replicaId, nodeIds, isConnected, logger } = options;
  const leaseTtlMs = options.leaseTtlMs ?? NODE_OWNER_TTL_MS;
  const owned = new Set<string>();
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | undefined;

  const key = (nodeId: string) => `${keyPrefix}nodeowner:${nodeId}`;

  function lose(nodeId: string, reason: string): void {
    if (!owned.delete(nodeId)) return;
    logger.warn({ nodeId, replicaId, reason }, `no longer the owner of media node ${nodeId}`);
    options.onLost(nodeId);
  }

  async function checkNode(nodeId: string): Promise<void> {
    if (!isConnected(nodeId)) {
      if (owned.has(nodeId)) {
        await redis.eval(RELEASE, 1, key(nodeId), replicaId);
        lose(nodeId, 'disconnected');
      }
      return;
    }
    if (owned.has(nodeId)) {
      const renewed = (await redis.eval(RENEW, 1, key(nodeId), replicaId, leaseTtlMs)) === 1;
      if (!renewed) lose(nodeId, 'lease lost');
      return;
    }
    if ((await redis.set(key(nodeId), replicaId, 'PX', leaseTtlMs, 'NX')) !== 'OK') return;
    owned.add(nodeId);
    logger.info({ nodeId, replicaId }, `now the owner of media node ${nodeId}`);
    options.onAcquired(nodeId);
  }

  async function pass(): Promise<void> {
    const results = await Promise.allSettled(nodeIds.map((nodeId) => checkNode(nodeId)));
    for (const result of results) {
      if (result.status === 'rejected') {
        logger.error({ err: result.reason as unknown }, 'node ownership: a check failed');
      }
    }
  }

  /** One pass over every node. Concurrent calls share one. */
  function runOnce(): Promise<void> {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    runOnce,
    /** Whether this replica owns the node now. */
    owns(nodeId: string): boolean {
      return owned.has(nodeId);
    },
    /** The nodes this replica owns now. */
    ownedNodeIds(): string[] {
      return [...owned];
    },
    /** A node's owner, as Redis has it; undefined when nobody owns it. */
    async ownerOf(nodeId: string): Promise<string | undefined> {
      return (await redis.get(key(nodeId))) ?? undefined;
    },
    start(intervalMs: number = options.intervalMs ?? NODE_OWNER_INTERVAL_MS): void {
      void runOnce();
      timer = setInterval(() => void runOnce(), intervalMs);
      timer.unref();
    },
    /** Stops, and gives up every node this replica owns so another takes them at once. */
    async stop(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
      for (const nodeId of [...owned]) {
        await redis.eval(RELEASE, 1, key(nodeId), replicaId).catch(() => undefined);
        lose(nodeId, 'shutting down');
      }
    },
  };
}

export type NodeOwnership = ReturnType<typeof createNodeOwnership>;

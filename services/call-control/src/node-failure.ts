import { enqueueEvent } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Kysely } from 'kysely';

import type { AffinityManager } from './affinity/manager.js';
import { callEvents } from './events.js';
import type { CallRegistry } from './redis/registry.js';
import type { CallControlDb } from './schema.js';

export interface NodeFailureWatcherOptions {
  readonly registry: CallRegistry;
  readonly affinity: Pick<AffinityManager, 'handOver'>;
  readonly db: Kysely<CallControlDb>;
  readonly logger: Logger;
  /** Names this replica in the claim, so a log line says who handled a death. */
  readonly replicaId: string;
  /** How long one replica's claim on a dead node lasts; a node still dead after it is looked at again. */
  readonly claimTtlMs?: number;
  /**
   * Whether this replica's event socket to a node is connected: a node this
   * process can still talk to is not dead, whatever its heartbeat key says.
   */
  readonly isConnected?: (nodeId: string) => boolean;
  /**
   * No node is declared dead until this replica has been up this long: after
   * every replica was down past the heartbeat's expiry, every node's key has
   * lapsed until the event sockets connect again, and none of them is dead.
   * At least the heartbeat's TTL, with room for the sockets to connect.
   */
  readonly startupGraceMs?: number;
  readonly now?: () => number;
}

/** How often the watcher looks for nodes whose heartbeat has expired. */
export const NODE_FAILURE_INTERVAL_MS = 1_000;

const DEFAULT_CLAIM_TTL_MS = 60_000;

function numberOr(value: string | undefined, fallback: number | null): number | null {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * S4-04 (04 §4): what happens when a media node dies.
 *
 * A node is dead once its heartbeat key (`fsnode:{id}`, refreshed every 3 s
 * while any replica's event socket to it is connected, `HEARTBEAT_TTL_MS`
 * 10 s) has expired. Every second each replica looks for such nodes; exactly
 * one claims each death (`nodelost:{id}`) and handles it:
 *
 * 1. every leg the node carried is announced as `call.lost` (in the outbox,
 *    so each is delivered even if this replica dies next), then removed from
 *    the live registry, so the live views stop showing it. Consumers turn it
 *    into a `node_failure` call record (cdr-service) and end the leg's dialog
 *    at the edge (telephony-config), which sends the other party a BYE;
 * 2. the node's leases (queues, parking lots, conference rooms) are released,
 *    so the next call for each is placed on a live node.
 *
 * A node that comes back simply heartbeats again and takes new calls; its
 * first heartbeat clears the claim, so a node that dies again soon after is
 * handled again at once (found live in S4-05: with the claim left to lapse, a
 * second death within its 60 s went unhandled, and the node's leases with it).
 * Handling is idempotent: a second pass over the same node finds no calls and
 * no leases.
 */
export function createNodeFailureWatcher(options: NodeFailureWatcherOptions) {
  const { registry, affinity, db, logger, replicaId } = options;
  const claimTtlMs = options.claimTtlMs ?? DEFAULT_CLAIM_TTL_MS;
  const now = options.now ?? Date.now;
  const startedAt = now();
  const startupGraceMs = options.startupGraceMs ?? 0;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<string[]> | undefined;

  async function handle(nodeId: string): Promise<void> {
    const detectedAt = now();
    let lost = 0;
    for (const callUuid of await registry.callsForNode(nodeId)) {
      const call = await registry.getCall(callUuid);
      if (call === undefined) {
        // Its hash already expired; only the index entry is left.
        await registry.endCall(callUuid, nodeId, null);
        continue;
      }
      const tenantId =
        call['tenant'] === undefined || call['tenant'] === '' ? null : call['tenant'];
      const startedAt = numberOr(call['startedAt'], detectedAt) ?? detectedAt;
      await enqueueEvent(db, callEvents, {
        type: 'call.lost',
        data: {
          callUuid,
          nodeId,
          direction: call['direction'] === 'outbound' ? 'outbound' : 'inbound',
          startedAt: Math.trunc(startedAt),
          answeredAt: (() => {
            const answered = numberOr(call['answeredAt'], null);
            return answered === null ? null : Math.trunc(answered);
          })(),
          detectedAt,
          from: call['from'] ?? '',
          to: call['to'] ?? '',
          extension: call['ext'] === undefined || call['ext'] === '' ? null : call['ext'],
          sipCallId:
            call['sipCallId'] === undefined || call['sipCallId'] === '' ? null : call['sipCallId'],
        },
        ...(tenantId === null ? {} : { orgContext: { tenantId } }),
      });
      await registry.endCall(callUuid, nodeId, tenantId);
      lost += 1;
    }
    await registry.forgetNodeCalls(nodeId);
    const released = await affinity.handOver(nodeId);
    if (lost > 0 || released > 0) {
      logger.warn(
        { nodeId, lostCalls: lost, releasedLeases: released, replicaId },
        `media node ${nodeId} is gone: ${String(lost)} calls lost, ${String(released)} leases released`,
      );
    }
  }

  async function pass(): Promise<string[]> {
    const handled: string[] = [];
    if (now() - startedAt < startupGraceMs) return handled;
    for (const nodeId of await registry.knownNodeIds()) {
      if (options.isConnected?.(nodeId) === true) continue;
      if (await registry.isNodeAlive(nodeId)) continue;
      if (!(await registry.claimNodeLoss(nodeId, replicaId, claimTtlMs))) continue;
      await handle(nodeId);
      handled.push(nodeId);
    }
    return handled;
  }

  /** One look at every node. Concurrent calls in this process share one pass. */
  function runOnce(): Promise<string[]> {
    running ??= pass().finally(() => {
      running = undefined;
    });
    return running;
  }

  function runLogged(): void {
    runOnce().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'node failure: pass failed; will retry on the next one',
      );
    });
  }

  return {
    runOnce,
    start(intervalMs: number = NODE_FAILURE_INTERVAL_MS): void {
      timer = setInterval(runLogged, intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}

export type NodeFailureWatcher = ReturnType<typeof createNodeFailureWatcher>;

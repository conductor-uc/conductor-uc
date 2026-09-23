import { enqueueEvent } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Kysely } from 'kysely';

import { callEvents } from './events.js';
import { normalizeEslEvent } from './normalize.js';
import type { CallRegistry } from './redis/registry.js';
import type { CallControlDb } from './schema.js';

export interface ChannelHandler {
  /** Feed one raw ESL event (already JSON-parsed) from a given node. */
  handleEvent(nodeId: string, raw: Readonly<Record<string, string>>): Promise<void>;
}

export interface ChannelHandlerOptions {
  readonly db: Kysely<CallControlDb>;
  readonly registry: CallRegistry;
  readonly logger: Logger;
  readonly callSafetyTtlMs: number;
  readonly heartbeatTtlMs: number;
}

/**
 * Turns normalized channel actions into their two effects: an outbox row
 * (the durable trail) and a Redis registry mutation (the live, rebuildable
 * view) — in that order (`schema.ts`'s own doc comment on why the order
 * matters and why they are not one atomic operation).
 */
export function createChannelHandler(options: ChannelHandlerOptions): ChannelHandler {
  const { db, registry, logger, callSafetyTtlMs, heartbeatTtlMs } = options;

  return {
    async handleEvent(nodeId, raw) {
      const action = normalizeEslEvent(nodeId, raw);

      switch (action.kind) {
        case 'heartbeat':
          await registry.heartbeat(action.nodeId, heartbeatTtlMs);
          return;

        case 'created':
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.created',
            data: {
              callUuid: action.call.callUuid,
              nodeId: action.call.nodeId,
              tenantId: action.call.tenantId,
              direction: action.call.direction,
              from: action.call.from,
              to: action.call.to,
            },
            ...(action.call.tenantId === null
              ? {}
              : { orgContext: { tenantId: action.call.tenantId } }),
          });
          await registry.createCall(action.call, callSafetyTtlMs);
          return;

        case 'answered':
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.answered',
            data: { callUuid: action.callUuid, nodeId: action.nodeId },
          });
          await registry.updateCall(action.callUuid, {
            state: 'answered',
            answeredAt: action.answeredAt,
          });
          return;

        case 'bridged':
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.bridged',
            data: { callUuid: action.callUuid, nodeId: action.nodeId, bridgedTo: action.bridgedTo },
          });
          await registry.updateCall(action.callUuid, { bridgedTo: action.bridgedTo });
          return;

        case 'held':
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.held',
            data: { callUuid: action.callUuid, nodeId: action.nodeId },
          });
          await registry.updateCall(action.callUuid, { state: 'held' });
          return;

        case 'hungup':
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.hungup',
            data: {
              callUuid: action.callUuid,
              nodeId: action.nodeId,
              hangupCause: action.hangupCause,
            },
            ...(action.tenantId === null ? {} : { orgContext: { tenantId: action.tenantId } }),
          });
          await registry.endCall(action.callUuid, action.nodeId, action.tenantId);
          return;

        case 'queueAgentStateChanged':
          await enqueueEvent(db, callEvents, {
            type: 'call.queue.agent_status_changed',
            data: {
              nodeId: action.nodeId,
              agentName: action.agentName,
              status: action.status,
            },
          });
          return;

        case 'ignored':
          return;

        default: {
          const exhaustive: never = action;
          logger.warn({ action: exhaustive }, 'unreachable channel action');
        }
      }
    },
  };
}

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

/** The state changes that carry nothing but the call: which event, and what the registry records. */
const SIMPLE_TRANSITIONS = {
  held: { type: 'call.channel.held', fields: { state: 'held' } },
  unheld: { type: 'call.channel.unheld', fields: { state: 'answered' } },
  recordingStarted: { type: 'call.channel.recording_started', fields: { recording: 'on' } },
  recordingStopped: { type: 'call.channel.recording_stopped', fields: { recording: 'off' } },
} as const;

/** The envelope's tenant, when the channel said (S5-08: the realtime hub routes by it). */
function orgContextOf(tenantId: string | null): { orgContext?: { tenantId: string } } {
  return tenantId === null ? {} : { orgContext: { tenantId } };
}

/**
 * Turns normalized channel actions into their two effects: an outbox row
 * (the durable trail) and a Redis registry mutation (the live, rebuildable
 * view) — in that order (`schema.ts`'s own doc comment on why the order
 * matters and why they are not one atomic operation).
 */
export function createChannelHandler(options: ChannelHandlerOptions): ChannelHandler {
  const { db, registry, logger, callSafetyTtlMs, heartbeatTtlMs } = options;

  /**
   * The tenant a channel event belongs to: what the channel itself said, else
   * what the registry already knows (the leg FreeSWITCH creates to ring a
   * phone may say nothing, and a hangup is the last chance to route it).
   * When this event is the first to name the tenant, the call is attached to
   * it and announced first ({@link identify}).
   */
  async function tenantFor(callUuid: string, said: string | null): Promise<string | null> {
    if (said === null) return registry.tenantOf(callUuid);
    await identify(callUuid, said);
    return said;
  }

  /**
   * Attaches a call that had no tenant to `tenantId` (see
   * `CallRegistry.attachTenant`) and, when this did attach it, sends
   * `call.channel.identified` with the call as it stands: the realtime hub
   * routes by tenant, so this is where such a call starts for its live view.
   */
  async function identify(callUuid: string, tenantId: string): Promise<void> {
    const call = await registry.attachTenant(callUuid, tenantId);
    if (call === undefined) return;
    await enqueueEvent(db, callEvents, {
      type: 'call.channel.identified',
      data: {
        callUuid,
        nodeId: call.nodeId,
        tenantId,
        direction: call.direction,
        from: call.from,
        to: call.to,
        state: call.state,
        startedAt: new Date(call.startedAt).toISOString(),
        answeredAt: call.answeredAt === null ? null : new Date(call.answeredAt).toISOString(),
        bridgedTo: call.bridgedTo,
        recording: call.recording,
      },
      orgContext: { tenantId },
    });
  }

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

        case 'answered': {
          const tenantId = await tenantFor(action.callUuid, action.tenantId);
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.answered',
            data: { callUuid: action.callUuid, nodeId: action.nodeId },
            ...orgContextOf(tenantId),
          });
          await registry.updateCall(action.callUuid, {
            state: 'answered',
            answeredAt: action.answeredAt,
          });
          return;
        }

        case 'bridged': {
          const tenantId = await tenantFor(action.callUuid, action.tenantId);
          // The other leg is this call's too. One FreeSWITCH created without
          // the tenant (a queue agent's leg, a flow's transfer) is attached
          // here, before the bridge that names it is announced.
          if (tenantId !== null) await identify(action.bridgedTo, tenantId);
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.bridged',
            data: { callUuid: action.callUuid, nodeId: action.nodeId, bridgedTo: action.bridgedTo },
            ...orgContextOf(tenantId),
          });
          await registry.updateCall(action.callUuid, { bridgedTo: action.bridgedTo });
          return;
        }

        case 'held':
        case 'unheld':
        case 'recordingStarted':
        case 'recordingStopped': {
          const { type, fields } = SIMPLE_TRANSITIONS[action.kind];
          const tenantId = await tenantFor(action.callUuid, action.tenantId);
          await enqueueEvent(db, callEvents, {
            type,
            data: { callUuid: action.callUuid, nodeId: action.nodeId },
            ...orgContextOf(tenantId),
          });
          await registry.updateCall(action.callUuid, fields);
          return;
        }

        case 'hungup': {
          const tenantId = await tenantFor(action.callUuid, action.tenantId);
          await enqueueEvent(db, callEvents, {
            type: 'call.channel.hungup',
            data: {
              callUuid: action.callUuid,
              nodeId: action.nodeId,
              hangupCause: action.hangupCause,
            },
            ...orgContextOf(tenantId),
          });
          await registry.endCall(action.callUuid, action.nodeId, tenantId);
          return;
        }

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

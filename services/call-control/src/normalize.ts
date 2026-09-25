import type { CallRecord } from './redis/registry.js';

/**
 * Maps one raw FreeSWITCH ESL event (as delivered by `event json ...`, still
 * keyed the way FS names them — `Event-Name`, `Unique-ID`,
 * `variable_sip_h_X-Tenant-Id`, etc.) to what this service does with it.
 *
 * Tenant identity comes from `variable_sip_h_X-Tenant-Id`: the same
 * channel variable telephony-config's outbound trust boundary already
 * relies on (`services/telephony-config/src/routes/fs.routes.ts`) — FS
 * exposes every custom SIP header imported onto the channel as a
 * `variable_sip_h_<Name>` event field, and OpenSIPs is what actually sets
 * `X-Tenant-Id` (02 §3) before the call ever reaches FS. A channel with no
 * such header (nothing has set it up for a case that should not exist in a
 * well-formed dialplan) normalizes to `tenantId: null` rather than throwing
 * — this service's job is to reflect what FS reports, not to reject it.
 */
export type ChannelAction =
  | { readonly kind: 'created'; readonly call: CallRecord }
  | {
      readonly kind: 'answered';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
      readonly answeredAt: string;
    }
  | {
      readonly kind: 'bridged';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
      readonly bridgedTo: string;
    }
  | {
      readonly kind: 'held' | 'unheld' | 'recordingStarted' | 'recordingStopped';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
    }
  | {
      readonly kind: 'hungup';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
      readonly hangupCause: string;
    }
  | { readonly kind: 'heartbeat'; readonly nodeId: string }
  | {
      readonly kind: 'queueAgentStateChanged';
      readonly nodeId: string;
      readonly agentName: string;
      readonly status: string;
    }
  | { readonly kind: 'ignored' };

/**
 * `mod_callcenter`'s own ESL event (S2-13; `Event-Subclass: callcenter::
 * info`) — checked before the `Unique-ID` gate below, the same reason
 * `HEARTBEAT` is: an agent-state-change is not tied to any one channel, so
 * it may carry no `Unique-ID` at all, and gating on one first would drop
 * every callcenter event silently. Only `CC-Action: agent-state-change` is
 * handled (`events.ts`'s own doc comment on `call.queue.agent_status_changed`
 * for why queue-member add/del are not) — any other `CC-Action` value, or a
 * malformed one missing `CC-Agent`/`CC-Agent-Status`, normalizes to
 * `ignored` rather than guessed at.
 */
function normalizeCallcenterEvent(
  nodeId: string,
  raw: Readonly<Record<string, string>>,
): ChannelAction {
  if (raw['CC-Action'] !== 'agent-state-change') return { kind: 'ignored' };
  const agentName = raw['CC-Agent'];
  const status = raw['CC-Agent-Status'];
  if (agentName === undefined || agentName === '' || status === undefined || status === '') {
    return { kind: 'ignored' };
  }
  return { kind: 'queueAgentStateChanged', nodeId, agentName, status };
}

export function normalizeEslEvent(
  nodeId: string,
  raw: Readonly<Record<string, string>>,
): ChannelAction {
  const eventName = raw['Event-Name'];

  if (eventName === 'HEARTBEAT') return { kind: 'heartbeat', nodeId };
  if (eventName === 'CUSTOM' && raw['Event-Subclass'] === 'callcenter::info') {
    return normalizeCallcenterEvent(nodeId, raw);
  }

  const callUuid = raw['Unique-ID'];
  if (callUuid === undefined || callUuid === '') return { kind: 'ignored' };

  const tenantId = tenantIdOf(raw);

  switch (eventName) {
    case 'CHANNEL_CREATE': {
      const direction = raw['Call-Direction'] === 'outbound' ? 'outbound' : 'inbound';
      return {
        kind: 'created',
        call: {
          callUuid,
          nodeId,
          tenantId,
          direction,
          state: 'ringing',
          startedAt: eventTimestampMs(raw),
          from: raw['Caller-Caller-ID-Number'] ?? raw['Caller-ANI'] ?? '',
          to: raw['Caller-Destination-Number'] ?? '',
        },
      };
    }
    case 'CHANNEL_ANSWER':
      return { kind: 'answered', callUuid, nodeId, tenantId, answeredAt: eventTimestampMs(raw) };
    case 'CHANNEL_BRIDGE': {
      const bridgedTo = raw['Other-Leg-Unique-ID'];
      if (bridgedTo === undefined || bridgedTo === '') return { kind: 'ignored' };
      return { kind: 'bridged', callUuid, nodeId, tenantId, bridgedTo };
    }
    case 'CHANNEL_HOLD':
      return { kind: 'held', callUuid, nodeId, tenantId };
    case 'CHANNEL_UNHOLD':
      return { kind: 'unheld', callUuid, nodeId, tenantId };
    // `record_session` (the recording dialplan, S5-02) fires these on the
    // channel it records. UNVERIFIED LIVE, like the callcenter events above:
    // both are long-standing FreeSWITCH event names, but no test here has run
    // them against a real node.
    case 'RECORD_START':
      return { kind: 'recordingStarted', callUuid, nodeId, tenantId };
    case 'RECORD_STOP':
      return { kind: 'recordingStopped', callUuid, nodeId, tenantId };
    case 'CHANNEL_HANGUP_COMPLETE':
      return {
        kind: 'hungup',
        callUuid,
        nodeId,
        tenantId,
        hangupCause: raw['Hangup-Cause'] ?? 'UNKNOWN',
      };
    default:
      return { kind: 'ignored' };
  }
}

/**
 * The channel's tenant: the `X-Tenant-Id` header OpenSIPs set (an extension's
 * own call), else `cuc_tenant_id`, which every dialplan branch sets
 * (telephony-config's `tenantIdAction`). A call from a trunk has no header, so
 * its CHANNEL_CREATE (fired before the dialplan runs) has no tenant; its later
 * events (answer, bridge, hangup) carry `cuc_tenant_id`, which is how the live
 * registry learns whose call it is (S5-08).
 */
function tenantIdOf(raw: Readonly<Record<string, string>>): string | null {
  return (
    normalizeTenantId(raw['variable_sip_h_X-Tenant-Id']) ??
    normalizeTenantId(raw['variable_cuc_tenant_id'])
  );
}

function normalizeTenantId(value: string | undefined): string | null {
  return value === undefined || value === '' ? null : value;
}

/** FS reports `Event-Date-Timestamp` in microseconds since epoch; the registry stores milliseconds (04 §3: "Times are unix milliseconds"). */
function eventTimestampMs(raw: Readonly<Record<string, string>>): string {
  const micros = raw['Event-Date-Timestamp'];
  if (micros === undefined) return String(Date.now());
  const parsed = Number(micros);
  return Number.isFinite(parsed) ? String(Math.round(parsed / 1000)) : String(Date.now());
}

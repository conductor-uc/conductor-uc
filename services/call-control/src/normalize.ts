import { parseRecordingControls, type RecordingControls } from '@cuc/api-contracts';

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
      /** S5-15: `cuc_rec_controls` as the channel says it now, when it says it at all. */
      readonly controls?: RecordingControls;
    }
  | {
      readonly kind: 'bridged';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
      readonly bridgedTo: string;
      readonly controls?: RecordingControls;
    }
  | {
      readonly kind:
        | 'held'
        | 'unheld'
        | 'recordingStarted'
        | 'recordingStopped'
        | 'recordingPaused'
        | 'recordingResumed';
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

/**
 * S5-15: `CUSTOM cuc::recording`, which `recording_control.lua` (a feature code) and this
 * service (the console's buttons, by `sendevent`) fire after `uuid_record mask`/`unmask`: those
 * raise no event of their own, unlike starting and stopping (RECORD_START/RECORD_STOP).
 * `Recording-Call-UUID` is the channel that owns the recording, `Recording-Action` is `paused`
 * or `resumed`. Not `Unique-ID`: `sendevent` with a `Unique-ID` naming a live channel queues the
 * event to that channel instead of firing it, so no listener would ever see it (found live). Anything else is ignored. The event names no tenant; the registry knows it.
 */
function normalizeRecordingEvent(
  nodeId: string,
  raw: Readonly<Record<string, string>>,
): ChannelAction {
  const callUuid = raw['Recording-Call-UUID'];
  if (callUuid === undefined || callUuid === '') return { kind: 'ignored' };
  switch (raw['Recording-Action']) {
    case 'paused':
      return { kind: 'recordingPaused', callUuid, nodeId, tenantId: null };
    case 'resumed':
      return { kind: 'recordingResumed', callUuid, nodeId, tenantId: null };
    default:
      return { kind: 'ignored' };
  }
}

/** The CUSTOM subclass of {@link normalizeRecordingEvent}. */
export const RECORDING_EVENT_SUBCLASS = 'cuc::recording';

export function normalizeEslEvent(
  nodeId: string,
  raw: Readonly<Record<string, string>>,
): ChannelAction {
  const eventName = raw['Event-Name'];

  if (eventName === 'HEARTBEAT') return { kind: 'heartbeat', nodeId };
  if (eventName === 'CUSTOM' && raw['Event-Subclass'] === 'callcenter::info') {
    return normalizeCallcenterEvent(nodeId, raw);
  }
  if (eventName === 'CUSTOM' && raw['Event-Subclass'] === RECORDING_EVENT_SUBCLASS) {
    return normalizeRecordingEvent(nodeId, raw);
  }

  const callUuid = raw['Unique-ID'];
  if (callUuid === undefined || callUuid === '') return { kind: 'ignored' };

  const tenantId = tenantIdOf(raw);

  switch (eventName) {
    case 'CHANNEL_CREATE': {
      const direction = raw['Call-Direction'] === 'outbound' ? 'outbound' : 'inbound';
      const from = raw['Caller-Caller-ID-Number'] ?? raw['Caller-ANI'] ?? '';
      const to = raw['Caller-Destination-Number'] ?? '';
      return {
        kind: 'created',
        call: {
          callUuid,
          nodeId,
          tenantId,
          direction,
          state: 'ringing',
          startedAt: eventTimestampMs(raw),
          from,
          to,
          extension: extensionOf(raw, direction, to),
          controls: parseRecordingControls(raw['variable_cuc_rec_controls']),
        },
      };
    }
    case 'CHANNEL_ANSWER':
      return {
        kind: 'answered',
        callUuid,
        nodeId,
        tenantId,
        answeredAt: eventTimestampMs(raw),
        ...controlsOf(raw),
      };
    case 'CHANNEL_BRIDGE': {
      const bridgedTo = raw['Other-Leg-Unique-ID'];
      if (bridgedTo === undefined || bridgedTo === '') return { kind: 'ignored' };
      return { kind: 'bridged', callUuid, nodeId, tenantId, bridgedTo, ...controlsOf(raw) };
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

/** An extension number's shape (2-6 digits, pbx-config-service's `numbering.ts`). */
const EXTENSION_NUMBER = /^[0-9]{2,6}$/;

/**
 * S5-15: the tenant extension a channel is the leg of, when the node can vouch for it, else null.
 * A person's own live calls (the self-service feed and its recording buttons) are the channels
 * whose extension is theirs, so this must not be something a caller can claim:
 *
 * - An inbound channel (a leg that called in) counts only when it came from a registered phone:
 *   OpenSIPs sets `X-Tenant-Id` only on requests from a phone it authenticated (and strips any
 *   the caller sent), and the extension is the SIP From user, as `/fs/dialplan` reads it. A
 *   trunk caller's caller ID is never taken for an extension, however it looks.
 * - An outbound channel (one the node placed) is the number it rang, when that is an extension
 *   number's shape: the dialplan chose it, not the caller.
 */
function extensionOf(
  raw: Readonly<Record<string, string>>,
  direction: 'inbound' | 'outbound',
  to: string,
): string | null {
  const candidate =
    direction === 'outbound'
      ? to
      : normalizeTenantId(raw['variable_sip_h_X-Tenant-Id']) === null
        ? undefined
        : raw['variable_sip_from_user'];
  return candidate !== undefined && EXTENSION_NUMBER.test(candidate) ? candidate : null;
}

/** S5-15: `cuc_rec_controls` when the event carries the variable at all (answer and bridge do once the dialplan has set it). */
function controlsOf(raw: Readonly<Record<string, string>>): { controls?: RecordingControls } {
  const value = raw['variable_cuc_rec_controls'];
  return value === undefined ? {} : { controls: parseRecordingControls(value) };
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

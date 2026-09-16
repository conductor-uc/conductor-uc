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
  | { readonly kind: 'answered'; readonly callUuid: string; readonly nodeId: string; readonly answeredAt: string }
  | { readonly kind: 'bridged'; readonly callUuid: string; readonly nodeId: string; readonly bridgedTo: string }
  | { readonly kind: 'held'; readonly callUuid: string; readonly nodeId: string }
  | {
      readonly kind: 'hungup';
      readonly callUuid: string;
      readonly nodeId: string;
      readonly tenantId: string | null;
      readonly hangupCause: string;
    }
  | { readonly kind: 'heartbeat'; readonly nodeId: string }
  | { readonly kind: 'ignored' };

export function normalizeEslEvent(nodeId: string, raw: Readonly<Record<string, string>>): ChannelAction {
  const eventName = raw['Event-Name'];

  if (eventName === 'HEARTBEAT') return { kind: 'heartbeat', nodeId };

  const callUuid = raw['Unique-ID'];
  if (callUuid === undefined || callUuid === '') return { kind: 'ignored' };

  const tenantId = normalizeTenantId(raw['variable_sip_h_X-Tenant-Id']);

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
      return { kind: 'answered', callUuid, nodeId, answeredAt: eventTimestampMs(raw) };
    case 'CHANNEL_BRIDGE': {
      const bridgedTo = raw['Other-Leg-Unique-ID'];
      if (bridgedTo === undefined || bridgedTo === '') return { kind: 'ignored' };
      return { kind: 'bridged', callUuid, nodeId, bridgedTo };
    }
    case 'CHANNEL_HOLD':
      return { kind: 'held', callUuid, nodeId };
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

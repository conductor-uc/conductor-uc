/**
 * Pure business logic for normalizing a `mod_json_cdr` POST body into CDR v1
 * (S2-18; 06's cdr-service section). No DB here — `repo/cdr.repo.ts` is
 * where this meets actual rows.
 *
 * UNVERIFIED LIVE (docs/decisions.md G-51, same "no live FS process reached
 * while building this task" discipline as G-35/G-36/G-43/G-47/G-48/G-50):
 * `mod_json_cdr`'s own top-level JSON shape — specifically, that every field
 * this module reads lives under a flat `variables` object — is this
 * module's own best-effort reading of `mod_json_cdr`'s publicly documented
 * behavior, not something run against a real FreeSWITCH process. The
 * disposition/hangup-by mappings below are FreeSWITCH's own well-known
 * hangup-cause and `sip_hangup_disposition` vocabulary, not invented, but
 * exhaustiveness against every cause FS can report is not claimed.
 */

const KNOWN_HANGUP_CAUSES_BY_DISPOSITION: Record<string, readonly string[]> = {
  busy: ['USER_BUSY'],
  no_answer: ['NO_ANSWER', 'ALLOTTED_TIMEOUT'],
  cancelled: ['ORIGINATOR_CANCEL'],
};

export const CDR_DISPOSITIONS = [
  'answered',
  'no_answer',
  'busy',
  'failed',
  'cancelled',
  'node_failure',
] as const;
export type CdrDisposition = (typeof CDR_DISPOSITIONS)[number];

export const CDR_DIRECTIONS = ['inbound', 'outbound', 'internal'] as const;
export type CdrDirection = (typeof CDR_DIRECTIONS)[number];

export const CDR_HANGUP_BY = ['caller', 'callee', 'system'] as const;
export type CdrHangupBy = (typeof CDR_HANGUP_BY)[number];

export class InvalidCdrPayloadError extends Error {
  override readonly name = 'InvalidCdrPayloadError';
}

/** What this module extracts from `mod_json_cdr`'s own `variables` object, before touching the DB. */
export interface NormalizedCdr {
  readonly tenantId: string;
  readonly callUuid: string;
  readonly nodeId: string;
  readonly direction: CdrDirection;
  readonly startAt: Date;
  readonly answerAt: Date | null;
  readonly endAt: Date;
  readonly durationSec: number;
  readonly billableSec: number;
  readonly fromNumber: string;
  readonly fromName: string | null;
  readonly toNumber: string;
  readonly dialedNumber: string;
  readonly did: string | null;
  readonly trunkId: string | null;
  readonly disposition: CdrDisposition;
  readonly hangupCause: string;
  readonly hangupBy: CdrHangupBy;
  /** `mod_json_cdr`'s own `callflow` array, if present — stored as-is, not deeply parsed (G-51). */
  readonly legs: unknown;
  /** Best-effort codec/MOS/user-agent, extracted from `variables` (G-51). */
  readonly sip: Record<string, unknown>;
}

function requireVariable(variables: Record<string, string>, name: string): string {
  const value = variables[name];
  if (value === undefined || value === '') {
    throw new InvalidCdrPayloadError(`mod_json_cdr payload is missing variables.${name}.`);
  }
  return value;
}

function parseEpochSeconds(value: string | undefined): Date | null {
  if (value === undefined || value === '' || value === '0') return null;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return new Date(seconds * 1000);
}

function parseIntOr(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * The inverse of telephony-config's own `context-id.ts` `toContextId` —
 * duplicated rather than imported (05 §1.1: services never import each
 * other's source) because `X-Trunk-Id` (`sip_h_X-Trunk-Id`) arrives here
 * hyphen-stripped, the same `permissions.address.context_info` `CHAR(32)`
 * constraint that module's own doc comment explains.
 */
function fromContextId(contextId: string): string {
  return [
    contextId.slice(0, 8),
    contextId.slice(8, 12),
    contextId.slice(12, 16),
    contextId.slice(16, 20),
    contextId.slice(20),
  ].join('-');
}

/**
 * `cuc_call_direction` (set only by the outbound/emergency dialplan
 * builders, `xml.ts`'s own doc comment on why) wins when present;
 * otherwise `X-Call-Direction` (`sip_h_X-Call-Direction`, confirmed live
 * for every internal- and inbound-direction call) maps directly, since its
 * own two values are a strict subset of CDR v1's three.
 */
function resolveDirection(variables: Record<string, string>): CdrDirection {
  const override = variables.cuc_call_direction;
  if (override === 'outbound') return 'outbound';

  const headerDirection = variables['sip_h_X-Call-Direction'];
  if (headerDirection === 'inbound') return 'inbound';
  if (headerDirection === 'internal') return 'internal';

  throw new InvalidCdrPayloadError(
    'mod_json_cdr payload carries neither cuc_call_direction nor sip_h_X-Call-Direction; cannot attribute a call direction.',
  );
}

/**
 * `billsec` (seconds actually billed, i.e. answered) is FreeSWITCH's own
 * clearest, most reliable "was this call answered" signal — more reliable
 * than trusting `hangup_cause` alone, since a cause like `NORMAL_CLEARING`
 * is reported on both an answered call that hung up normally and, less
 * commonly, an unanswered one. `hangup_cause` only decides the *unanswered*
 * bucket.
 */
function resolveDisposition(billableSec: number, hangupCause: string): CdrDisposition {
  if (billableSec > 0) return 'answered';

  for (const [disposition, causes] of Object.entries(KNOWN_HANGUP_CAUSES_BY_DISPOSITION)) {
    if (causes.includes(hangupCause)) return disposition as CdrDisposition;
  }
  return 'failed';
}

/**
 * `sip_hangup_disposition` (FreeSWITCH's own well-known "did this channel
 * send or receive the BYE" variable) — `send_bye` on the A-leg means the
 * caller hung up, `recv_bye` means the far end did. Anything else (a
 * system-initiated teardown, e.g. a toll-fraud `limit` hangup) is `system`.
 */
function resolveHangupBy(variables: Record<string, string>): CdrHangupBy {
  const disposition = variables.sip_hangup_disposition;
  if (disposition === 'send_bye') return 'caller';
  if (disposition === 'recv_bye') return 'callee';
  return 'system';
}

/**
 * Normalizes a `mod_json_cdr` POST body (S2-18). Throws
 * {@link InvalidCdrPayloadError} on anything this platform's own dialplan
 * is expected to always set (`cuc_tenant_id`, `cuc_node_id`, `uuid`,
 * timestamps) — a payload missing those did not come from this platform's
 * own dialplan, so ingesting it as a best-effort partial row would be worse
 * than rejecting it outright.
 */
export function normalizeCdr(raw: unknown): NormalizedCdr {
  if (typeof raw !== 'object' || raw === null || !('variables' in raw)) {
    throw new InvalidCdrPayloadError('mod_json_cdr payload has no top-level variables object.');
  }
  const variablesRaw = raw.variables;
  if (typeof variablesRaw !== 'object' || variablesRaw === null) {
    throw new InvalidCdrPayloadError('mod_json_cdr payload has no top-level variables object.');
  }
  const variables = variablesRaw as Record<string, string>;

  const callUuid = requireVariable(variables, 'uuid');
  const nodeId = requireVariable(variables, 'cuc_node_id');
  const tenantId = requireVariable(variables, 'cuc_tenant_id');
  const direction = resolveDirection(variables);

  const startAt = parseEpochSeconds(variables.start_epoch);
  if (startAt === null) {
    throw new InvalidCdrPayloadError('mod_json_cdr payload is missing variables.start_epoch.');
  }
  const endAt = parseEpochSeconds(variables.end_epoch) ?? startAt;
  const answerAt = parseEpochSeconds(variables.answer_epoch);

  const durationSec = parseIntOr(variables.duration, 0);
  const billableSec = parseIntOr(variables.billsec, 0);
  const hangupCause = variables.hangup_cause ?? 'UNKNOWN';

  const callflow = (raw as { callflow?: unknown }).callflow;

  return {
    tenantId,
    callUuid,
    nodeId,
    direction,
    startAt,
    answerAt,
    endAt,
    durationSec,
    billableSec,
    fromNumber: variables.sip_from_user ?? variables.caller_id_number ?? '',
    fromName: variables.caller_id_name ?? null,
    toNumber: variables.sip_to_user ?? variables.destination_number ?? '',
    dialedNumber: variables.destination_number ?? '',
    did: direction === 'inbound' ? (variables.destination_number ?? null) : null,
    trunkId:
      variables['sip_h_X-Trunk-Id'] === undefined
        ? null
        : fromContextId(variables['sip_h_X-Trunk-Id']),
    disposition: resolveDisposition(billableSec, hangupCause),
    hangupCause,
    hangupBy: resolveHangupBy(variables),
    legs: callflow ?? null,
    sip: {
      codec: variables.rtp_use_codec_name ?? null,
      userAgent: variables.sip_user_agent ?? null,
    },
  };
}

import type { RecordingDirection } from './recording-client.js';

/**
 * S5-13 (G-111): what a feature code needs to know about its call, carried on the channel.
 *
 * When a call's rules allow on-demand recording, `/fs/dialplan` (or a flow's hand-off) puts this
 * on the channel as `cuc_rec_ctx`, and `recording_control.lua` sends it back unchanged with each
 * feature code, so recording-service can decide with the same call context as at setup. It is
 * base64url JSON: no spaces, commas, quotes or braces, so it survives FreeSWITCH's variable
 * expansion and `mod_curl`'s argument parsing. It is not a secret and not signed: only a
 * FreeSWITCH node holding the `fs-node` token can present it, and recording-service still checks
 * the rules and that the recording belongs to the call.
 */
export interface RecordingCallContext {
  readonly tenantId: string;
  readonly direction: RecordingDirection;
  readonly extensionIds: readonly string[];
  readonly queueId?: string | undefined;
  readonly didId?: string | undefined;
}

interface Wire {
  t: string;
  d: RecordingDirection;
  e: string[];
  q?: string;
  i?: string;
}

const DIRECTIONS: readonly string[] = ['inbound', 'outbound', 'internal'];

export function encodeRecordingContext(context: RecordingCallContext): string {
  const wire: Wire = {
    t: context.tenantId,
    d: context.direction,
    e: [...context.extensionIds],
    ...(context.queueId === undefined ? {} : { q: context.queueId }),
    ...(context.didId === undefined ? {} : { i: context.didId }),
  };
  return Buffer.from(JSON.stringify(wire), 'utf8').toString('base64url');
}

/** The context, or undefined when the token is not one this service made. */
export function decodeRecordingContext(token: string): RecordingCallContext | undefined {
  let wire: unknown;
  try {
    wire = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof wire !== 'object' || wire === null) return undefined;
  const { t, d, e, q, i } = wire as Partial<Record<keyof Wire, unknown>>;
  const isId = (value: unknown): value is string =>
    typeof value === 'string' && value !== '' && value.length <= 36;
  if (!isId(t) || typeof d !== 'string' || !DIRECTIONS.includes(d)) return undefined;
  if (!Array.isArray(e) || e.length > 8 || !e.every(isId)) return undefined;
  if (q !== undefined && !isId(q)) return undefined;
  if (i !== undefined && !isId(i)) return undefined;
  return {
    tenantId: t,
    direction: d as RecordingDirection,
    extensionIds: e,
    ...(q === undefined ? {} : { queueId: q }),
    ...(i === undefined ? {} : { didId: i }),
  };
}

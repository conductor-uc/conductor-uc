/**
 * S5-13 (G-111): what a recording action needs to know about its call, carried on the channel.
 *
 * When a call's rules allow on-demand recording, telephony-config's `/fs/dialplan` (or a flow's
 * hand-off) puts this on the channel as `cuc_rec_ctx`. `recording_control.lua` sends it back
 * unchanged with each feature code, and call-control reads it off the channel (`uuid_getvar`)
 * for the console's buttons (S5-15), so recording-service decides with the same call context as
 * at setup. It is base64url JSON: no spaces, commas, quotes or braces, so it survives
 * FreeSWITCH's variable expansion and `mod_curl`'s argument parsing. It is not a secret and not
 * signed: only a FreeSWITCH node (or call-control, reading it from the node) can present it, and
 * recording-service still checks the rules and that the recording belongs to the call.
 *
 * Shared here because two services read it: telephony-config, which writes it and relays the
 * feature codes, and call-control, which acts on a call for the console.
 */

export type RecordingCallDirection = 'inbound' | 'outbound' | 'internal';

export interface RecordingCallContext {
  readonly tenantId: string;
  readonly direction: RecordingCallDirection;
  readonly extensionIds: readonly string[];
  readonly queueId?: string | undefined;
  readonly didId?: string | undefined;
}

interface Wire {
  t: string;
  d: RecordingCallDirection;
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

/** The context, or undefined when the token is not one telephony-config made. */
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
    direction: d as RecordingCallDirection,
    extensionIds: e,
    ...(q === undefined ? {} : { queueId: q }),
    ...(i === undefined ? {} : { didId: i }),
  };
}

/**
 * The spool file's path on a media node. The name is the opaque recording id and nothing else (no
 * tenant, no number). Every path that starts, stops, masks or unmasks a recording must be built
 * here: FreeSWITCH finds a running recording by exactly this path (`uuid_record ... <path>`).
 */
export function recordingSpoolPath(spoolDir: string, recordingId: string): string {
  return `${spoolDir.replace(/\/+$/, '')}/${recordingId}.wav`;
}

/**
 * S5-15: which recording actions a live call allows, as telephony-config decides at call setup
 * and puts on the channel (`cuc_rec_controls`, exported to the bridged leg), so a console shows
 * only buttons that can work. The same rule as the feature codes it arms:
 *
 * - `on_demand`: the deciding rule does not record but allows on demand. Start and stop an
 *   on-demand recording, and pause and resume it while it runs.
 * - `pause`: the deciding rule records and allows on demand. Pause and resume only; a recording
 *   a rule started is never stopped.
 * - `none`: nothing (no variable on the channel means this).
 *
 * A hint for display only: recording-service decides every action again with the call's rules.
 */
export const RECORDING_CONTROLS = ['none', 'on_demand', 'pause'] as const;
export type RecordingControls = (typeof RECORDING_CONTROLS)[number];

/** Reads a `cuc_rec_controls` value; anything else is `none`. */
export function parseRecordingControls(value: string | undefined | null): RecordingControls {
  return value === 'on_demand' || value === 'pause' ? value : 'none';
}

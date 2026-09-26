/**
 * Live calls as the `tenant:{t}:calls` topic shows them, and how call-control's
 * `call.channel.*` events become changes to them.
 *
 * One entry is one channel (a leg) on a media node. The two legs of a bridged
 * call point at each other through `bridgedTo`, so a client can show them as
 * one call. What call-control knows but a subscriber has no use for (the node
 * a channel is on) is left out: the hub sends only what the topic's permission
 * covers.
 */

export interface LiveCall {
  readonly callUuid: string;
  /** The channel's direction on the media node: `inbound` is a leg that called in (a phone or a trunk dialling), `outbound` one the node placed. */
  readonly direction: 'inbound' | 'outbound';
  readonly state: 'ringing' | 'answered' | 'held';
  readonly from: string;
  readonly to: string;
  /** RFC 3339. */
  readonly startedAt: string;
  readonly answeredAt: string | null;
  /** The other leg's `callUuid` once bridged. */
  readonly bridgedTo: string | null;
  /**
   * Whether the channel is being recorded now, and (S5-15) whether that
   * recording is paused, by feature code or by the console's buttons.
   */
  readonly recording: 'on' | 'off' | 'paused';
  /**
   * S5-15: which recording buttons can work on the call, as telephony-config
   * decided at setup: `on_demand` (start and stop, and pause and resume while
   * it runs), `pause` (pause and resume a recording a rule started), or
   * `none`. A hint for display: every action is decided again when asked.
   */
  readonly controls: 'none' | 'on_demand' | 'pause';
  /**
   * S5-15: the tenant extension this leg belongs to, when the media node can
   * vouch for it (a registered phone that called in, or the extension a leg
   * rang), else null. Never taken from a caller ID alone; it is how a person's
   * own calls are found for the `user:{u}:calls` topic.
   */
  readonly extension: string | null;
}

export type LiveCallChanges = Partial<
  Pick<LiveCall, 'state' | 'answeredAt' | 'bridgedTo' | 'recording' | 'controls'>
>;

/** One change on the `calls` topic (`event` in an `{type:"event"}` message). */
export type CallTopicEvent =
  | { readonly type: 'call.started'; readonly call: LiveCall }
  | { readonly type: 'call.updated'; readonly callUuid: string; readonly changes: LiveCallChanges }
  | { readonly type: 'call.ended'; readonly callUuid: string; readonly hangupCause: string };

/** The part of an event envelope (05 §5) the hub reads. */
export interface BusEnvelope {
  readonly type: string;
  readonly occurredAt: string;
  readonly orgContext: { readonly tenantId?: string };
  readonly data: unknown;
}

/**
 * The change a `call.channel.*` event makes, and whose it is. Undefined for an
 * event with no tenant (a call from a trunk before its tenant is known; see
 * call-control's `normalize.ts`), one this topic does not show, or one that
 * does not have the shape call-control's contract promises: the hub never
 * guesses.
 */
export function callEventFromEnvelope(
  envelope: BusEnvelope,
): { readonly tenantId: string; readonly event: CallTopicEvent } | undefined {
  const tenantId = envelope.orgContext.tenantId;
  if (tenantId === undefined) return undefined;
  const data = envelope.data as Record<string, unknown> | null;
  if (typeof data !== 'object' || data === null) return undefined;
  const callUuid = stringField(data, 'callUuid');
  if (callUuid === undefined || callUuid === '') return undefined;

  const updated = (changes: LiveCallChanges) => ({
    tenantId,
    event: { type: 'call.updated', callUuid, changes } as const,
  });
  // S5-15: answer and bridge may say what the recording buttons can do now.
  const controls = controlsOf(data['controls']);
  const withControls = controls === undefined ? {} : { controls };

  switch (envelope.type) {
    case 'call.channel.created': {
      const from = stringField(data, 'from');
      const to = stringField(data, 'to');
      const direction = data['direction'];
      if (from === undefined || to === undefined) return undefined;
      if (direction !== 'inbound' && direction !== 'outbound') return undefined;
      return {
        tenantId,
        event: {
          type: 'call.started',
          call: {
            callUuid,
            direction,
            state: 'ringing',
            from,
            to,
            startedAt: envelope.occurredAt,
            answeredAt: null,
            bridgedTo: null,
            recording: 'off',
            controls: controls ?? 'none',
            extension: extensionOf(data['extension']),
          },
        },
      };
    }
    // A call whose tenant became known after it was created (a trunk call, a
    // leg created for a bridge): this is where it starts for the tenant, with
    // its state so far.
    case 'call.channel.identified': {
      const iso = (value: unknown) =>
        typeof value === 'string' && !Number.isNaN(Date.parse(value)) ? Date.parse(value) : value;
      const call = liveCallFromSnapshot({
        ...data,
        startedAt: iso(data['startedAt']),
        answeredAt: iso(data['answeredAt']),
      });
      return call === undefined ? undefined : { tenantId, event: { type: 'call.started', call } };
    }
    case 'call.channel.answered':
      return updated({ state: 'answered', answeredAt: envelope.occurredAt, ...withControls });
    case 'call.channel.bridged': {
      const bridgedTo = stringField(data, 'bridgedTo');
      return bridgedTo === undefined ? undefined : updated({ bridgedTo, ...withControls });
    }
    case 'call.channel.held':
      return updated({ state: 'held' });
    case 'call.channel.unheld':
      return updated({ state: 'answered' });
    case 'call.channel.recording_started':
      return updated({ recording: 'on' });
    case 'call.channel.recording_stopped':
      return updated({ recording: 'off' });
    // S5-15: `uuid_record mask`/`unmask`, by feature code or by the buttons.
    case 'call.channel.recording_paused':
      return updated({ recording: 'paused' });
    case 'call.channel.recording_resumed':
      return updated({ recording: 'on' });
    case 'call.channel.hungup':
      return {
        tenantId,
        event: {
          type: 'call.ended',
          callUuid,
          hangupCause: stringField(data, 'hangupCause') ?? 'UNKNOWN',
        },
      };
    default:
      return undefined;
  }
}

/**
 * One entry of call-control's `GET /internal/v1/tenants/:t/calls`, as the topic
 * shows it. Undefined for an entry that is not the shape promised.
 */
export function liveCallFromSnapshot(entry: unknown): LiveCall | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const record = entry as Record<string, unknown>;
  const callUuid = stringField(record, 'callUuid');
  const from = stringField(record, 'from');
  const to = stringField(record, 'to');
  const { direction, state, startedAt, answeredAt, bridgedTo, recording, controls, extension } =
    record;
  if (callUuid === undefined || from === undefined || to === undefined) return undefined;
  if (direction !== 'inbound' && direction !== 'outbound') return undefined;
  if (state !== 'ringing' && state !== 'answered' && state !== 'held') return undefined;
  if (typeof startedAt !== 'number') return undefined;
  return {
    callUuid,
    direction,
    state,
    from,
    to,
    startedAt: new Date(startedAt).toISOString(),
    answeredAt: typeof answeredAt === 'number' ? new Date(answeredAt).toISOString() : null,
    bridgedTo: typeof bridgedTo === 'string' && bridgedTo !== '' ? bridgedTo : null,
    recording: recording === 'on' || recording === 'paused' ? recording : 'off',
    controls: controlsOf(controls) ?? 'none',
    extension: extensionOf(extension),
  };
}

function controlsOf(value: unknown): LiveCall['controls'] | undefined {
  return value === 'none' || value === 'on_demand' || value === 'pause' ? value : undefined;
}

function extensionOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function stringField(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === 'string' ? value : undefined;
}

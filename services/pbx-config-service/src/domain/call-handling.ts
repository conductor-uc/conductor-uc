/**
 * Pure business logic for per-extension call handling (parity 1a). No DB
 * here; `repo/call-handling.repo.ts` supplies the tenant lookups the checks
 * need.
 *
 * What is modelled follows the hosted-PBX "answering rules" / call
 * forwarding basics: do not disturb, forward always, forward when busy,
 * forward on no answer (after `noAnswerSeconds`), forward when unreachable
 * (the extension is not registered), and simultaneous ring to up to
 * {@link MAX_SIMULTANEOUS_RING} additional destinations.
 */

export const MAX_SIMULTANEOUS_RING = 5;
export const MIN_NO_ANSWER_SECONDS = 5;
export const MAX_NO_ANSWER_SECONDS = 120;
export const DEFAULT_NO_ANSWER_SECONDS = 20;

export const DND_ACTIONS = ['voicemail', 'busy'] as const;
export type DndAction = (typeof DND_ACTIONS)[number];

/** E.164: a leading `+`, a non-zero country-code digit, 7 to 15 digits in all. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

export class InvalidCallHandlingError extends Error {
  override readonly name = 'InvalidCallHandlingError';
}

/**
 * Where a call is sent. `voicemail` names the extension whose mailbox takes
 * the call; left out it means the extension being configured. It is not
 * allowed in a simultaneous-ring list (a mailbox cannot ring).
 */
export type Destination =
  | { readonly type: 'extension'; readonly extensionId: string }
  | { readonly type: 'voicemail'; readonly extensionId?: string }
  | { readonly type: 'external'; readonly e164: string };

export interface CallHandling {
  readonly dnd: boolean;
  readonly dndAction: DndAction;
  readonly forwardAlways: Destination | null;
  readonly forwardBusy: Destination | null;
  readonly forwardNoAnswer: Destination | null;
  readonly noAnswerSeconds: number;
  readonly forwardUnreachable: Destination | null;
  readonly simultaneousRing: readonly Destination[];
}

/** What an extension with nothing configured has. */
export const DEFAULT_CALL_HANDLING: CallHandling = {
  dnd: false,
  dndAction: 'voicemail',
  forwardAlways: null,
  forwardBusy: null,
  forwardNoAnswer: null,
  noAnswerSeconds: DEFAULT_NO_ANSWER_SECONDS,
  forwardUnreachable: null,
  simultaneousRing: [],
};

export function isE164(value: string): boolean {
  return E164_PATTERN.test(value);
}

/** The extension ids a destination refers to, for the "does it exist in this tenant" check. */
export function destinationExtensionId(destination: Destination): string | undefined {
  return destination.type === 'external' ? undefined : destination.extensionId;
}

function normalizeDestination(
  raw: Destination,
  field: string,
  ownExtensionId: string,
  allowVoicemail: boolean,
): Destination {
  switch (raw.type) {
    case 'extension': {
      if (raw.extensionId === '') {
        throw new InvalidCallHandlingError(`${field}: extensionId is required.`);
      }
      if (raw.extensionId === ownExtensionId) {
        throw new InvalidCallHandlingError(
          `${field}: an extension cannot forward to itself (a forwarding loop).`,
        );
      }
      return { type: 'extension', extensionId: raw.extensionId };
    }
    case 'voicemail': {
      if (!allowVoicemail) {
        throw new InvalidCallHandlingError(`${field}: voicemail cannot be a ring destination.`);
      }
      // Own mailbox is the common case; store it as "no extensionId" so it
      // stays right if this were ever copied between extensions.
      if (raw.extensionId === undefined || raw.extensionId === ownExtensionId) {
        return { type: 'voicemail' };
      }
      return { type: 'voicemail', extensionId: raw.extensionId };
    }
    case 'external': {
      if (!isE164(raw.e164)) {
        throw new InvalidCallHandlingError(
          `${field}: '${raw.e164}' is not an E.164 number (a leading +, then 7 to 15 digits).`,
        );
      }
      return { type: 'external', e164: raw.e164 };
    }
    default:
      throw new InvalidCallHandlingError(`${field}: unknown destination type.`);
  }
}

/** Input to {@link validateCallHandling}; anything left out takes its "off" default. */
export type CallHandlingInput = Partial<{
  readonly [K in keyof CallHandling]: CallHandling[K] | undefined;
}>;

/**
 * Validates and normalizes a full call-handling document for the extension
 * `ownExtensionId`. Throws {@link InvalidCallHandlingError} with a message
 * naming the offending field. Whether a destination extension exists in the
 * tenant is the repo's check, not this one's.
 */
export function validateCallHandling(
  input: CallHandlingInput,
  ownExtensionId: string,
): CallHandling {
  const dndAction = input.dndAction ?? DEFAULT_CALL_HANDLING.dndAction;
  if (!DND_ACTIONS.includes(dndAction)) {
    throw new InvalidCallHandlingError(`dndAction must be one of ${DND_ACTIONS.join(', ')}.`);
  }

  const noAnswerSeconds = input.noAnswerSeconds ?? DEFAULT_NO_ANSWER_SECONDS;
  if (
    !Number.isInteger(noAnswerSeconds) ||
    noAnswerSeconds < MIN_NO_ANSWER_SECONDS ||
    noAnswerSeconds > MAX_NO_ANSWER_SECONDS
  ) {
    throw new InvalidCallHandlingError(
      `noAnswerSeconds must be a whole number of ${String(MIN_NO_ANSWER_SECONDS)}-${String(MAX_NO_ANSWER_SECONDS)} seconds.`,
    );
  }

  const one = (raw: Destination | null | undefined, field: string): Destination | null =>
    raw === null || raw === undefined
      ? null
      : normalizeDestination(raw, field, ownExtensionId, true);

  const ring = input.simultaneousRing ?? [];
  if (ring.length > MAX_SIMULTANEOUS_RING) {
    throw new InvalidCallHandlingError(
      `simultaneousRing takes at most ${String(MAX_SIMULTANEOUS_RING)} destinations.`,
    );
  }
  const simultaneousRing = ring.map((d, i) =>
    normalizeDestination(d, `simultaneousRing[${String(i)}]`, ownExtensionId, false),
  );
  const seen = new Set<string>();
  for (const d of simultaneousRing) {
    const key = d.type === 'external' ? d.e164 : d.type === 'extension' ? d.extensionId : '';
    if (seen.has(key)) {
      throw new InvalidCallHandlingError('simultaneousRing lists the same destination twice.');
    }
    seen.add(key);
  }

  return {
    dnd: input.dnd ?? false,
    dndAction,
    forwardAlways: one(input.forwardAlways, 'forwardAlways'),
    forwardBusy: one(input.forwardBusy, 'forwardBusy'),
    forwardNoAnswer: one(input.forwardNoAnswer, 'forwardNoAnswer'),
    noAnswerSeconds,
    forwardUnreachable: one(input.forwardUnreachable, 'forwardUnreachable'),
    simultaneousRing,
  };
}

/** Every destination in a document, for the tenant-membership check. */
export function allDestinations(handling: CallHandling): Destination[] {
  return [
    handling.forwardAlways,
    handling.forwardBusy,
    handling.forwardNoAnswer,
    handling.forwardUnreachable,
    ...handling.simultaneousRing,
  ].filter((d): d is Destination => d !== null);
}

/**
 * Whether making `ownExtensionId` forward-always to `startExtensionId` closes
 * a cycle: follows the forward-always edges already stored (`edges` maps an
 * extension id to the extension its forward-always targets) and reports true
 * if the walk comes back to `ownExtensionId`. The walk is bounded, so a
 * cycle that does not include `ownExtensionId` cannot spin it.
 */
export function closesForwardAlwaysLoop(
  ownExtensionId: string,
  startExtensionId: string,
  edges: ReadonlyMap<string, string>,
): boolean {
  let current: string | undefined = startExtensionId;
  for (let hops = 0; current !== undefined && hops <= edges.size; hops += 1) {
    if (current === ownExtensionId) return true;
    current = edges.get(current);
  }
  return false;
}

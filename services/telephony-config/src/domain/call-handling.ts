/**
 * The call-handling document telephony-config mirrors from pbx-config-service
 * (parity 1a) — the same shape as its `domain/call-handling.ts`, which owns
 * the validation; this side only reads it, so it is types plus a defensive
 * parse (`parseCallHandling`) rather than a second copy of the rules.
 */

export type CallHandlingDestination =
  | { readonly type: 'extension'; readonly extensionId: string }
  /** `extensionId` left out means the extension being called. */
  | { readonly type: 'voicemail'; readonly extensionId?: string }
  | { readonly type: 'external'; readonly e164: string };

export interface CallHandlingConfig {
  readonly dnd: boolean;
  readonly dndAction: 'voicemail' | 'busy';
  readonly forwardAlways: CallHandlingDestination | null;
  readonly forwardBusy: CallHandlingDestination | null;
  readonly forwardNoAnswer: CallHandlingDestination | null;
  readonly noAnswerSeconds: number;
  readonly forwardUnreachable: CallHandlingDestination | null;
  readonly simultaneousRing: readonly CallHandlingDestination[];
}

/** Most simultaneous-ring destinations honoured on a call, whatever a stored row says. */
export const MAX_SIMULTANEOUS_RING = 5;

function isDestination(value: unknown): value is CallHandlingDestination {
  if (typeof value !== 'object' || value === null) return false;
  const d = value as Record<string, unknown>;
  switch (d.type) {
    case 'extension':
      return typeof d.extensionId === 'string' && d.extensionId !== '';
    case 'voicemail':
      return d.extensionId === undefined || typeof d.extensionId === 'string';
    case 'external':
      return typeof d.e164 === 'string' && /^\+[1-9]\d{6,14}$/.test(d.e164);
    default:
      return false;
  }
}

/**
 * Reads a stored or fetched document, dropping anything malformed rather than
 * trusting it: a call must never fail, or dial something odd, because of a bad
 * row. An external destination that is not E.164 is dropped here too, so a
 * corrupted mirror cannot put an arbitrary string into a dial string.
 */
export function parseCallHandling(raw: unknown): CallHandlingConfig {
  const value = (typeof raw === 'string' ? (JSON.parse(raw) as unknown) : raw) as Record<
    string,
    unknown
  > | null;
  const one = (v: unknown): CallHandlingDestination | null => (isDestination(v) ? v : null);
  const seconds = value?.noAnswerSeconds;
  return {
    dnd: value?.dnd === true,
    dndAction: value?.dndAction === 'busy' ? 'busy' : 'voicemail',
    forwardAlways: one(value?.forwardAlways),
    forwardBusy: one(value?.forwardBusy),
    forwardNoAnswer: one(value?.forwardNoAnswer),
    noAnswerSeconds:
      typeof seconds === 'number' && Number.isInteger(seconds) && seconds >= 5 && seconds <= 120
        ? seconds
        : 20,
    forwardUnreachable: one(value?.forwardUnreachable),
    simultaneousRing: (Array.isArray(value?.simultaneousRing) ? value.simultaneousRing : [])
      .filter(isDestination)
      .filter((d) => d.type !== 'voicemail')
      .slice(0, MAX_SIMULTANEOUS_RING),
  };
}

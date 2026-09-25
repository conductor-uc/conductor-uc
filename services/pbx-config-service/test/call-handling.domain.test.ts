import { describe, expect, it } from 'vitest';

import {
  closesForwardAlwaysLoop,
  DEFAULT_CALL_HANDLING,
  InvalidCallHandlingError,
  isE164,
  validateCallHandling,
} from '../src/domain/call-handling.js';

const SELF = 'ext-self';

describe('call handling validation', () => {
  it('an empty document is the all-off default', () => {
    expect(validateCallHandling({}, SELF)).toEqual(DEFAULT_CALL_HANDLING);
  });

  it('accepts every destination kind for a forward', () => {
    const result = validateCallHandling(
      {
        forwardAlways: { type: 'extension', extensionId: 'ext-b' },
        forwardBusy: { type: 'voicemail' },
        forwardNoAnswer: { type: 'external', e164: '+14155552671' },
        noAnswerSeconds: 30,
        forwardUnreachable: { type: 'voicemail', extensionId: 'ext-b' },
      },
      SELF,
    );
    expect(result.forwardAlways).toEqual({ type: 'extension', extensionId: 'ext-b' });
    expect(result.forwardNoAnswer).toEqual({ type: 'external', e164: '+14155552671' });
    expect(result.forwardUnreachable).toEqual({ type: 'voicemail', extensionId: 'ext-b' });
    expect(result.noAnswerSeconds).toBe(30);
  });

  it('stores voicemail naming the extension itself as its own voicemail', () => {
    const result = validateCallHandling(
      { forwardBusy: { type: 'voicemail', extensionId: SELF } },
      SELF,
    );
    expect(result.forwardBusy).toEqual({ type: 'voicemail' });
  });

  it.each(['14155552671', '+0155552671', '+1415', '+1415555267112345678', '+1 415 555 2671', ''])(
    'rejects %j as an external number',
    (e164) => {
      expect(isE164(e164)).toBe(false);
      expect(() =>
        validateCallHandling({ forwardAlways: { type: 'external', e164 } }, SELF),
      ).toThrow(InvalidCallHandlingError);
    },
  );

  it('rejects forwarding to itself, in any forward slot and in the ring list', () => {
    const self = { type: 'extension', extensionId: SELF } as const;
    for (const field of [
      'forwardAlways',
      'forwardBusy',
      'forwardNoAnswer',
      'forwardUnreachable',
    ] as const) {
      expect(() => validateCallHandling({ [field]: self }, SELF)).toThrow(/itself/);
    }
    expect(() => validateCallHandling({ simultaneousRing: [self] }, SELF)).toThrow(/itself/);
  });

  it('allows at most 5 simultaneous-ring destinations, with no repeats and no voicemail', () => {
    const six = Array.from({ length: 6 }, (_, i) => ({
      type: 'external' as const,
      e164: `+1415555260${String(i)}`,
    }));
    expect(() => validateCallHandling({ simultaneousRing: six }, SELF)).toThrow(/at most 5/);
    expect(
      validateCallHandling({ simultaneousRing: six.slice(0, 5) }, SELF).simultaneousRing,
    ).toHaveLength(5);
    expect(() => validateCallHandling({ simultaneousRing: [six[0]!, six[0]!] }, SELF)).toThrow(
      /twice/,
    );
    expect(() => validateCallHandling({ simultaneousRing: [{ type: 'voicemail' }] }, SELF)).toThrow(
      /cannot be a ring destination/,
    );
  });

  it.each([4, 121, 20.5, Number.NaN])('rejects noAnswerSeconds %s', (noAnswerSeconds) => {
    expect(() => validateCallHandling({ noAnswerSeconds }, SELF)).toThrow(/noAnswerSeconds/);
  });

  it('rejects an unknown dndAction', () => {
    expect(() => validateCallHandling({ dndAction: 'reject' as never }, SELF)).toThrow(/dndAction/);
  });
});

describe('closesForwardAlwaysLoop', () => {
  it('detects a direct and a transitive loop, and ignores unrelated chains', () => {
    // b -> c -> a; now a wants to forward to b.
    const edges = new Map([
      ['b', 'c'],
      ['c', 'a'],
    ]);
    expect(closesForwardAlwaysLoop('a', 'b', edges)).toBe(true);
    expect(closesForwardAlwaysLoop('a', 'x', edges)).toBe(false);
    expect(closesForwardAlwaysLoop('a', 'c', new Map([['c', 'd']]))).toBe(false);
  });

  it('terminates on a cycle that does not include the extension', () => {
    const edges = new Map([
      ['b', 'c'],
      ['c', 'b'],
    ]);
    expect(closesForwardAlwaysLoop('a', 'b', edges)).toBe(false);
  });
});

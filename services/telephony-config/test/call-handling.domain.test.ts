import { describe, expect, it } from 'vitest';

import { parseCallHandling } from '../src/domain/call-handling.js';

describe('parseCallHandling', () => {
  it('reads a stored document, as an object or as JSON text', () => {
    const doc = {
      dnd: true,
      dndAction: 'busy',
      forwardAlways: { type: 'extension', extensionId: 'e2' },
      forwardBusy: { type: 'voicemail' },
      forwardNoAnswer: { type: 'external', e164: '+14155552671' },
      noAnswerSeconds: 45,
      forwardUnreachable: null,
      simultaneousRing: [{ type: 'external', e164: '+14155552672' }],
    };
    expect(parseCallHandling(doc)).toEqual(doc);
    expect(parseCallHandling(JSON.stringify(doc))).toEqual(doc);
  });

  it('turns garbage into the all-off default instead of throwing', () => {
    expect(parseCallHandling({})).toEqual({
      dnd: false,
      dndAction: 'voicemail',
      forwardAlways: null,
      forwardBusy: null,
      forwardNoAnswer: null,
      noAnswerSeconds: 20,
      forwardUnreachable: null,
      simultaneousRing: [],
    });
    expect(parseCallHandling(null).dnd).toBe(false);
  });

  it('drops a destination that is malformed, so nothing odd can reach a dial string', () => {
    const parsed = parseCallHandling({
      forwardAlways: { type: 'external', e164: '+1415,sip_h_X=1' },
      forwardBusy: { type: 'external', e164: '14155552671' },
      forwardNoAnswer: { type: 'shell', cmd: 'x' },
      simultaneousRing: [
        { type: 'external', e164: 'bad' },
        { type: 'voicemail' },
        { type: 'extension', extensionId: '' },
        { type: 'extension', extensionId: 'ok' },
      ],
    });
    expect(parsed.forwardAlways).toBeNull();
    expect(parsed.forwardBusy).toBeNull();
    expect(parsed.forwardNoAnswer).toBeNull();
    expect(parsed.simultaneousRing).toEqual([{ type: 'extension', extensionId: 'ok' }]);
  });

  it('caps simultaneous ring at 5 and bounds the no-answer seconds', () => {
    const many = Array.from({ length: 9 }, (_, i) => ({
      type: 'extension',
      extensionId: `e${String(i)}`,
    }));
    expect(parseCallHandling({ simultaneousRing: many }).simultaneousRing).toHaveLength(5);
    expect(parseCallHandling({ noAnswerSeconds: 1 }).noAnswerSeconds).toBe(20);
    expect(parseCallHandling({ noAnswerSeconds: 9999 }).noAnswerSeconds).toBe(20);
  });
});

import { describe, expect, it } from 'vitest';

import { resolveOutboundCallerId } from '../src/domain/caller-id.js';

describe('resolveOutboundCallerId', () => {
  it("prefers the extension's own override", () => {
    expect(
      resolveOutboundCallerId(
        { name: 'Front Desk', number: '+15551234567' },
        { name: 'DID name', number: '+15557654321' },
        { name: 'Trunk name', number: '+15559999999' },
      ),
    ).toEqual({ name: 'Front Desk', number: '+15551234567' });
  });

  it('falls back to a bound DID when the extension has no override', () => {
    expect(
      resolveOutboundCallerId(
        null,
        { name: 'DID name', number: '+15557654321' },
        {
          name: 'Trunk name',
          number: '+15559999999',
        },
      ),
    ).toEqual({ name: 'DID name', number: '+15557654321' });
  });

  it("falls back to the trunk's own policy when neither extension nor DID has one", () => {
    expect(
      resolveOutboundCallerId(null, null, { name: 'Trunk name', number: '+15559999999' }),
    ).toEqual({ name: 'Trunk name', number: '+15559999999' });
  });

  it('returns null when nothing at any tier is set', () => {
    expect(resolveOutboundCallerId(null, null, null)).toBeNull();
  });

  it('treats a caller id with only a name set (no number) as set', () => {
    expect(resolveOutboundCallerId({ name: 'Front Desk', number: null }, null, null)).toEqual({
      name: 'Front Desk',
      number: null,
    });
  });

  it('skips a tier whose object exists but has neither name nor number', () => {
    expect(
      resolveOutboundCallerId({ name: null, number: null }, null, {
        name: 'Trunk name',
        number: null,
      }),
    ).toEqual({ name: 'Trunk name', number: null });
  });
});

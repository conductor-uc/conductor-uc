import { describe, expect, it } from 'vitest';

import { isOutboundCallAllowed, parseFraudLimits } from '../src/domain/fraud-limits.js';

describe('parseFraudLimits', () => {
  it('defaults to unlimited channels/CPS and international off, for an empty bag', () => {
    expect(parseFraudLimits({})).toEqual({
      maxConcurrentChannels: null,
      maxCallsPerSecond: null,
      internationalAllowed: false,
      countryAllowList: [],
    });
  });

  it('parses valid values', () => {
    expect(
      parseFraudLimits({
        maxConcurrentChannels: 5,
        maxCallsPerSecond: 2,
        internationalAllowed: true,
        countryAllowList: ['gb', 'DE'],
      }),
    ).toEqual({
      maxConcurrentChannels: 5,
      maxCallsPerSecond: 2,
      internationalAllowed: true,
      countryAllowList: ['GB', 'DE'],
    });
  });

  it('falls back to safe defaults for malformed values, rather than throwing', () => {
    expect(
      parseFraudLimits({
        maxConcurrentChannels: -1,
        maxCallsPerSecond: 'unlimited',
        internationalAllowed: 'yes',
        countryAllowList: 'GB',
      }),
    ).toEqual({
      maxConcurrentChannels: null,
      maxCallsPerSecond: null,
      internationalAllowed: false,
      countryAllowList: [],
    });
  });

  it('ignores unrelated keys in the same bag', () => {
    expect(parseFraudLimits({ someOtherFeatureFlag: true })).toEqual({
      maxConcurrentChannels: null,
      maxCallsPerSecond: null,
      internationalAllowed: false,
      countryAllowList: [],
    });
  });
});

describe('isOutboundCallAllowed', () => {
  const defaults = parseFraudLimits({});

  it('always allows a domestic call', () => {
    expect(isOutboundCallAllowed(defaults, 'US', 'US')).toBe(true);
  });

  it('blocks international by default', () => {
    expect(isOutboundCallAllowed(defaults, 'US', 'GB')).toBe(false);
  });

  it('allows international when internationalAllowed is set', () => {
    const limits = parseFraudLimits({ internationalAllowed: true });
    expect(isOutboundCallAllowed(limits, 'US', 'GB')).toBe(true);
  });

  it('allows a destination on the country allow-list even when international is off', () => {
    const limits = parseFraudLimits({ countryAllowList: ['GB'] });
    expect(isOutboundCallAllowed(limits, 'US', 'GB')).toBe(true);
    expect(isOutboundCallAllowed(limits, 'US', 'DE')).toBe(false);
  });

  it('treats an undeterminable destination country as international (fails closed)', () => {
    expect(isOutboundCallAllowed(defaults, 'US', undefined)).toBe(false);
  });
});

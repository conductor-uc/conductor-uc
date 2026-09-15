import { describe, expect, it } from 'vitest';

import {
  InvalidCidrError,
  InvalidTrunkConfigError,
  validateCallerIdPolicy,
  validateCidr,
  validateCodecs,
  validateCredentialForAuthMode,
  validateMaxChannels,
} from '../src/domain/trunk.js';

describe('validateCredentialForAuthMode', () => {
  it('requires a username and secret for register', () => {
    expect(() =>
      validateCredentialForAuthMode({ authMode: 'register', hasUsername: false, hasSecret: false }),
    ).toThrow(InvalidTrunkConfigError);
  });

  it('requires a username and secret for both', () => {
    expect(() =>
      validateCredentialForAuthMode({ authMode: 'both', hasUsername: true, hasSecret: false }),
    ).toThrow(InvalidTrunkConfigError);
  });

  it('accepts register with both present', () => {
    expect(() =>
      validateCredentialForAuthMode({ authMode: 'register', hasUsername: true, hasSecret: true }),
    ).not.toThrow();
  });

  it('rejects a credential set on an ip-mode trunk', () => {
    expect(() =>
      validateCredentialForAuthMode({ authMode: 'ip', hasUsername: true, hasSecret: true }),
    ).toThrow(InvalidTrunkConfigError);
  });

  it('accepts ip mode with no credential', () => {
    expect(() =>
      validateCredentialForAuthMode({ authMode: 'ip', hasUsername: false, hasSecret: false }),
    ).not.toThrow();
  });
});

describe('validateCodecs', () => {
  it('rejects an empty list', () => {
    expect(() => validateCodecs([])).toThrow(InvalidTrunkConfigError);
  });

  it('normalizes case and de-duplicates, preserving order', () => {
    expect(validateCodecs(['pcmu', 'PCMA', 'pcmu'])).toEqual(['PCMU', 'PCMA']);
  });

  it('rejects a blank codec name', () => {
    expect(() => validateCodecs(['PCMU', '  '])).toThrow(InvalidTrunkConfigError);
  });
});

describe('validateMaxChannels', () => {
  it('allows null (no limit)', () => {
    expect(validateMaxChannels(null)).toBeNull();
    expect(validateMaxChannels(undefined)).toBeNull();
  });

  it('rejects zero and negative values', () => {
    expect(() => validateMaxChannels(0)).toThrow(InvalidTrunkConfigError);
    expect(() => validateMaxChannels(-1)).toThrow(InvalidTrunkConfigError);
  });

  it('rejects a non-integer', () => {
    expect(() => validateMaxChannels(1.5)).toThrow(InvalidTrunkConfigError);
  });

  it('accepts a positive integer', () => {
    expect(validateMaxChannels(30)).toBe(30);
  });
});

describe('validateCidr', () => {
  it('accepts an IPv4 CIDR', () => {
    expect(validateCidr('203.0.113.0/24')).toBe('203.0.113.0/24');
  });

  it('accepts an IPv6 CIDR', () => {
    expect(validateCidr('2001:db8::/32')).toBe('2001:db8::/32');
  });

  it('rejects a bare IP with no prefix', () => {
    expect(() => validateCidr('203.0.113.5')).toThrow(InvalidCidrError);
  });

  it('rejects an out-of-range IPv4 octet', () => {
    expect(() => validateCidr('999.0.113.0/24')).toThrow(InvalidCidrError);
  });

  it('rejects garbage', () => {
    expect(() => validateCidr('not-an-ip')).toThrow(InvalidCidrError);
  });
});

describe('validateCallerIdPolicy', () => {
  it('allows null', () => {
    expect(validateCallerIdPolicy(null)).toBeNull();
    expect(validateCallerIdPolicy(undefined)).toBeNull();
  });

  it('requires at least a name or a number', () => {
    expect(() => validateCallerIdPolicy({ name: null, number: null })).toThrow(
      InvalidTrunkConfigError,
    );
  });

  it('accepts a number-only policy', () => {
    expect(validateCallerIdPolicy({ name: null, number: '+15551234567' })).toEqual({
      name: null,
      number: '+15551234567',
    });
  });
});

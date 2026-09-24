import { describe, expect, it } from 'vitest';

import {
  InvalidPublicAddressError,
  recordTypeFor,
  validatePublicAddress,
} from '../src/domain/dns.js';

describe('recordTypeFor', () => {
  it('is A for IPv4, AAAA for IPv6 and CNAME for a hostname', () => {
    expect(recordTypeFor('203.0.113.10')).toBe('A');
    expect(recordTypeFor('2001:db8::10')).toBe('AAAA');
    expect(recordTypeFor('edge.example.com')).toBe('CNAME');
  });
});

describe('validatePublicAddress', () => {
  it('trims, lower-cases and drops a trailing dot', () => {
    expect(validatePublicAddress(' 203.0.113.10 ')).toBe('203.0.113.10');
    expect(validatePublicAddress('Edge.Example.COM.')).toBe('edge.example.com');
    expect(validatePublicAddress('2001:db8::10')).toBe('2001:db8::10');
  });

  it('reads empty as clearing it', () => {
    expect(validatePublicAddress('  ')).toBeNull();
    expect(validatePublicAddress(null)).toBeNull();
    expect(validatePublicAddress(undefined)).toBeNull();
  });

  it.each([
    'https://edge.example.com',
    'edge.example.com:5060',
    'edge.example.com/x',
    'localhost',
    'a b.com',
    '-x.example.com',
    '999.1.1.1',
  ])('refuses %j', (value) => {
    expect(() => validatePublicAddress(value)).toThrow(InvalidPublicAddressError);
  });
});

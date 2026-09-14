import { describe, expect, it } from 'vitest';

import {
  InvalidFqdnError,
  generateVerificationToken,
  tenantDomainFor,
  validateFqdn,
  verificationRecordMatches,
  verificationRecordName,
} from '../src/domain/domain.js';

describe('validateFqdn', () => {
  it('accepts a normal domain', () => {
    expect(validateFqdn('voice.reseller-brand.com')).toBe('voice.reseller-brand.com');
    expect(validateFqdn('example.com')).toBe('example.com');
  });

  it('accepts a domain with a numeric label', () => {
    expect(validateFqdn('voice2.example.com')).toBe('voice2.example.com');
  });

  it('rejects a bare label with no dot', () => {
    expect(() => validateFqdn('localhost')).toThrow(InvalidFqdnError);
  });

  it('rejects uppercase', () => {
    expect(() => validateFqdn('Voice.Example.com')).toThrow(InvalidFqdnError);
  });

  it('rejects a leading or trailing hyphen in a label', () => {
    expect(() => validateFqdn('-voice.example.com')).toThrow(InvalidFqdnError);
    expect(() => validateFqdn('voice-.example.com')).toThrow(InvalidFqdnError);
  });

  it('rejects an empty label (a double dot)', () => {
    expect(() => validateFqdn('voice..example.com')).toThrow(InvalidFqdnError);
  });

  it('rejects a leading or trailing dot', () => {
    expect(() => validateFqdn('.voice.example.com')).toThrow(InvalidFqdnError);
    expect(() => validateFqdn('voice.example.com.')).toThrow(InvalidFqdnError);
  });

  it('rejects characters outside a DNS label', () => {
    expect(() => validateFqdn('voice_example.com')).toThrow(InvalidFqdnError);
    expect(() => validateFqdn('voice example.com')).toThrow(InvalidFqdnError);
  });

  it('rejects longer than 253 characters', () => {
    const label = 'a'.repeat(50); // within the 63-char per-label limit
    const fqdn = `${Array.from({ length: 5 }, () => label).join('.')}.com`; // 258 chars total
    expect(fqdn.length).toBeGreaterThan(253);
    expect(() => validateFqdn(fqdn)).toThrow(InvalidFqdnError);
  });
});

describe('tenantDomainFor', () => {
  it('prefixes the tenant slug onto the base', () => {
    expect(tenantDomainFor('acme', 'voice.reseller-brand.com')).toBe(
      'acme.voice.reseller-brand.com',
    );
  });

  it('falls back to the platform base domain the same way', () => {
    expect(tenantDomainFor('acme', 'pbx.example.internal')).toBe('acme.pbx.example.internal');
  });
});

describe('generateVerificationToken', () => {
  it('returns a nonempty, url-safe-ish string that differs each call', () => {
    const a = generateVerificationToken();
    const b = generateVerificationToken();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThan(20);
    expect(a).toMatch(/^[0-9a-f]+$/);
  });
});

describe('verificationRecordName', () => {
  it('is a neutral, generic label — never the codebase or product name', () => {
    const name = verificationRecordName('voice.reseller-brand.com');
    expect(name).toBe('_domain-verification.voice.reseller-brand.com');
    expect(name.toLowerCase()).not.toMatch(/conductor|cuc/);
  });
});

describe('verificationRecordMatches', () => {
  it('matches when a TXT record equals the token', () => {
    expect(verificationRecordMatches([['abc123']], 'abc123')).toBe(true);
  });

  it('matches a token split across multiple TXT strings (DNS 255-byte chunking)', () => {
    expect(verificationRecordMatches([['abc', '123']], 'abc123')).toBe(true);
  });

  it('matches when the expected record is one of several TXT records at that name', () => {
    expect(verificationRecordMatches([['unrelated'], ['abc123']], 'abc123')).toBe(true);
  });

  it('does not match a wrong or absent token', () => {
    expect(verificationRecordMatches([['wrong']], 'abc123')).toBe(false);
    expect(verificationRecordMatches([], 'abc123')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';

import { InvalidEmailError, normalizeEmail } from '../src/domain/email.js';

describe('normalizeEmail', () => {
  it('lowercases the address', () => {
    expect(normalizeEmail('User@Example.com')).toBe('user@example.com');
  });

  it('trims surrounding whitespace', () => {
    expect(normalizeEmail('  user@example.com  ')).toBe('user@example.com');
  });

  it('rejects a value with no @', () => {
    expect(() => normalizeEmail('not-an-email')).toThrow(InvalidEmailError);
  });

  it('rejects a value with no domain', () => {
    expect(() => normalizeEmail('user@')).toThrow(InvalidEmailError);
  });

  it('rejects a value with no TLD', () => {
    expect(() => normalizeEmail('user@example')).toThrow(InvalidEmailError);
  });

  it('rejects whitespace inside the address', () => {
    expect(() => normalizeEmail('user name@example.com')).toThrow(InvalidEmailError);
  });

  it('rejects an address over 255 characters', () => {
    expect(() => normalizeEmail(`${'a'.repeat(250)}@example.com`)).toThrow(InvalidEmailError);
  });

  it('makes A@x.com and a@x.com the same login, which is the whole point', () => {
    expect(normalizeEmail('A@X.COM')).toBe(normalizeEmail('a@x.com'));
  });
});

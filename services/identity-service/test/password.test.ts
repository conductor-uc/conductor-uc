import { describe, expect, it } from 'vitest';

import {
  WeakPasswordError,
  assertPasswordStrength,
  hashPassword,
  verifyPassword,
} from '../src/domain/password.js';

describe('assertPasswordStrength', () => {
  it('accepts a password at the minimum length', () => {
    expect(() => assertPasswordStrength('a'.repeat(12))).not.toThrow();
  });

  it('rejects a password below the minimum length', () => {
    expect(() => assertPasswordStrength('a'.repeat(11))).toThrow(WeakPasswordError);
  });

  it('rejects a password over the maximum length', () => {
    expect(() => assertPasswordStrength('a'.repeat(257))).toThrow(WeakPasswordError);
  });
});

describe('hashPassword / verifyPassword', () => {
  it('round-trips: the hash verifies against the original password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(hash, 'correct horse battery staple')).toBe(true);
  });

  it('rejects the wrong password', async () => {
    const hash = await hashPassword('correct horse battery staple');

    expect(await verifyPassword(hash, 'wrong password entirely')).toBe(false);
  });

  it('produces an argon2id hash', async () => {
    expect(await hashPassword('correct horse battery staple')).toMatch(/^\$argon2id\$/);
  });

  it('never stores the plaintext in the hash', async () => {
    const password = 'correct horse battery staple';
    expect(await hashPassword(password)).not.toContain(password);
  });

  it('produces a different hash for the same password each time (a fresh salt)', async () => {
    const password = 'correct horse battery staple';
    expect(await hashPassword(password)).not.toBe(await hashPassword(password));
  });
});

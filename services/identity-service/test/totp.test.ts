import { TOTP, Secret } from 'otpauth';
import { describe, expect, it } from 'vitest';

import { generateTotpSecret, matchTotpStep, verifyTotpCode } from '../src/domain/totp.js';

describe('generateTotpSecret', () => {
  it('returns a base32 secret and a matching otpauth URI', () => {
    const secret = generateTotpSecret('Acme Resale', 'user@example.com');

    expect(secret.base32).toMatch(/^[A-Z2-7]+$/);
    expect(secret.otpauthUri).toContain('otpauth://totp/');
    expect(secret.otpauthUri).toContain(encodeURIComponent('user@example.com'));
  });

  it('uses the org’s own name as the issuer, never a fixed product name (02 §5.2)', () => {
    const secret = generateTotpSecret('Acme Resale', 'user@example.com');

    expect(secret.otpauthUri).toContain('Acme');
    expect(secret.otpauthUri.toLowerCase()).not.toContain('conductor');
  });

  it('generates a fresh secret every time', () => {
    expect(generateTotpSecret('Org', 'u@x.com').base32).not.toBe(
      generateTotpSecret('Org', 'u@x.com').base32,
    );
  });
});

describe('verifyTotpCode', () => {
  it('accepts the current code for the secret', () => {
    const secret = generateTotpSecret('Org', 'u@x.com');
    const code = new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret.base32),
    }).generate();

    expect(verifyTotpCode(secret.base32, code)).toBe(true);
  });

  it('rejects a wrong code', () => {
    const secret = generateTotpSecret('Org', 'u@x.com');

    expect(verifyTotpCode(secret.base32, '000000')).toBe(false);
  });

  it('rejects a code for the wrong secret', () => {
    const secretA = generateTotpSecret('Org', 'a@x.com');
    const secretB = generateTotpSecret('Org', 'b@x.com');
    const codeForA = new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secretA.base32),
    }).generate();

    expect(verifyTotpCode(secretB.base32, codeForA)).toBe(false);
  });

  it('rejects malformed input rather than throwing', () => {
    const secret = generateTotpSecret('Org', 'u@x.com');

    expect(verifyTotpCode(secret.base32, 'abcdef')).toBe(false);
    expect(verifyTotpCode(secret.base32, '12345')).toBe(false);
    expect(verifyTotpCode(secret.base32, '')).toBe(false);
  });
});

describe('matchTotpStep', () => {
  const secret = generateTotpSecret('Org', 'u@x.com').base32;
  const at = (timestamp: number) =>
    new TOTP({
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      secret: Secret.fromBase32(secret),
    }).generate({ timestamp });
  const now = 1_800_000_015_000; // 15 s into step 60_000_000

  it('names the time step a code belongs to, within one step of drift', () => {
    expect(matchTotpStep(secret, at(now), now)).toBe(60_000_000);
    expect(matchTotpStep(secret, at(now - 30_000), now)).toBe(59_999_999);
    expect(matchTotpStep(secret, at(now + 30_000), now)).toBe(60_000_001);
  });

  it('is null for a code outside the window, or not six digits', () => {
    expect(matchTotpStep(secret, at(now - 90_000), now)).toBeNull();
    expect(matchTotpStep(secret, 'abcdef', now)).toBeNull();
    expect(matchTotpStep(secret, '12345', now)).toBeNull();
  });
});

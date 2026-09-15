import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { computeSipDigest, generateSipPassword } from '../src/domain/sip-credentials.js';

describe('generateSipPassword', () => {
  it('generates a non-empty, sufficiently long password', () => {
    const password = generateSipPassword();
    expect(password.length).toBeGreaterThanOrEqual(20);
  });

  it('generates a different password every call', () => {
    const passwords = new Set(Array.from({ length: 20 }, () => generateSipPassword()));
    expect(passwords.size).toBe(20);
  });
});

describe('computeSipDigest', () => {
  it('computes HA1 as MD5(username:realm:password)', () => {
    const digest = computeSipDigest('101', 'tenant-a.platform.test', 'hunter2');

    const expected = createHash('md5')
      .update('101:tenant-a.platform.test:hunter2', 'utf8')
      .digest('hex');
    expect(digest.ha1).toBe(expected);
  });

  it('computes HA1B as MD5(username@realm:realm:password)', () => {
    const digest = computeSipDigest('101', 'tenant-a.platform.test', 'hunter2');

    const expected = createHash('md5')
      .update('101@tenant-a.platform.test:tenant-a.platform.test:hunter2', 'utf8')
      .digest('hex');
    expect(digest.ha1b).toBe(expected);
  });

  it('is a pure function of its inputs', () => {
    const a = computeSipDigest('101', 'tenant-a.platform.test', 'hunter2');
    const b = computeSipDigest('101', 'tenant-a.platform.test', 'hunter2');
    expect(a).toEqual(b);
  });

  it('recomputes to a different digest when the realm changes', () => {
    const before = computeSipDigest('101', 'tenant-a.platform.test', 'hunter2');
    const after = computeSipDigest('101', 'tenant-a.new-domain.test', 'hunter2');

    expect(after.ha1).not.toBe(before.ha1);
    expect(after.ha1b).not.toBe(before.ha1b);
  });
});

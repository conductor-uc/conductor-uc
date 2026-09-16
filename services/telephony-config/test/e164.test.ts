import { describe, expect, it } from 'vitest';

import { normalizeToE164 } from '../src/domain/e164.js';

describe('normalizeToE164', () => {
  // +1 415 555 2671 is libphonenumber's own documented example US number —
  // deliberately not a real 555-01XX directory-assistance number, which the
  // library correctly (and unhelpfully, for a test fixture) flags invalid.
  it('normalizes a national-format US number using the tenant country', () => {
    expect(normalizeToE164('4155552671', 'US')).toBe('+14155552671');
  });

  it('normalizes a US number already dialed with a leading 1', () => {
    expect(normalizeToE164('14155552671', 'US')).toBe('+14155552671');
  });

  it('passes an already-E.164 number through unchanged', () => {
    expect(normalizeToE164('+14155552671', 'US')).toBe('+14155552671');
  });

  it('normalizes using a non-US tenant country', () => {
    expect(normalizeToE164('20 7946 0958', 'GB')).toBe('+442079460958');
  });

  it('returns undefined for a number that is too short to be valid', () => {
    expect(normalizeToE164('123', 'US')).toBeUndefined();
  });

  it('returns undefined for a blank input', () => {
    expect(normalizeToE164('   ', 'US')).toBeUndefined();
  });

  it('returns undefined for non-digit garbage', () => {
    expect(normalizeToE164('not-a-number', 'US')).toBeUndefined();
  });
});

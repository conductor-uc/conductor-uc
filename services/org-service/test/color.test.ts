import { describe, expect, it } from 'vitest';

import {
  InvalidColorError,
  InsufficientContrastError,
  WCAG_AA_RATIO,
  assertAccessiblePair,
  contrastRatio,
  validateHexColor,
} from '../src/domain/color.js';

describe('validateHexColor', () => {
  it('accepts a 6-digit hex color', () => {
    expect(validateHexColor('#1a2b3c')).toBe('#1a2b3c');
    expect(validateHexColor('#FFFFFF')).toBe('#FFFFFF');
  });

  it('rejects a 3-digit shorthand', () => {
    expect(() => validateHexColor('#fff')).toThrow(InvalidColorError);
  });

  it('rejects an alpha channel', () => {
    expect(() => validateHexColor('#ffffffff')).toThrow(InvalidColorError);
  });

  it('rejects a missing #', () => {
    expect(() => validateHexColor('1a2b3c')).toThrow(InvalidColorError);
  });

  it('rejects a non-hex value', () => {
    expect(() => validateHexColor('#zzzzzz')).toThrow(InvalidColorError);
    expect(() => validateHexColor('red')).toThrow(InvalidColorError);
  });
});

describe('contrastRatio', () => {
  it('is 21:1 for black on white — the maximum possible', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 1);
  });

  it('is 1:1 for identical colors — the minimum possible', () => {
    expect(contrastRatio('#336699', '#336699')).toBeCloseTo(1, 5);
  });

  it('is symmetric', () => {
    expect(contrastRatio('#112233', '#ddeeff')).toBeCloseTo(
      contrastRatio('#ddeeff', '#112233'),
      10,
    );
  });

  it('matches a known WCAG reference pair (#767676 on white is exactly the 4.5:1 boundary)', () => {
    expect(contrastRatio('#767676', '#ffffff')).toBeCloseTo(4.5, 1);
  });
});

describe('assertAccessiblePair', () => {
  it('accepts a pair at or above WCAG AA (4.5:1)', () => {
    expect(() => assertAccessiblePair('#000000', '#ffffff')).not.toThrow();
  });

  it('rejects a pair below WCAG AA, with the ratio in the message', () => {
    // Two similar mid-tones: well under 4.5:1.
    expect(() => assertAccessiblePair('#886644', '#997755')).toThrow(InsufficientContrastError);
    expect(() => assertAccessiblePair('#886644', '#997755')).toThrow(
      new RegExp(String(WCAG_AA_RATIO)),
    );
  });
});

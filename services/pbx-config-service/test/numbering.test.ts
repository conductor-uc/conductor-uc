import { describe, expect, it } from 'vitest';

import {
  assertNumberAvailable,
  ExtensionNumberTakenError,
  InvalidExtensionNumberError,
  validateExtensionNumber,
} from '../src/domain/numbering.js';

describe('validateExtensionNumber', () => {
  it('accepts 2-6 digit numbers', () => {
    for (const number of ['10', '101', '1000', '999999']) {
      expect(validateExtensionNumber(number)).toBe(number);
    }
  });

  it('rejects a number that is too short', () => {
    expect(() => validateExtensionNumber('1')).toThrow(InvalidExtensionNumberError);
  });

  it('rejects a number that is too long', () => {
    expect(() => validateExtensionNumber('1234567')).toThrow(InvalidExtensionNumberError);
  });

  it('rejects non-digit characters', () => {
    for (const number of ['10a', '1.0', '+101', '10 1', '']) {
      expect(() => validateExtensionNumber(number)).toThrow(InvalidExtensionNumberError);
    }
  });
});

describe('assertNumberAvailable', () => {
  it('does not throw when the number is not taken', () => {
    expect(() => assertNumberAvailable('101', false)).not.toThrow();
  });

  it('throws ExtensionNumberTakenError when the number is taken', () => {
    expect(() => assertNumberAvailable('101', true)).toThrow(ExtensionNumberTakenError);
  });
});

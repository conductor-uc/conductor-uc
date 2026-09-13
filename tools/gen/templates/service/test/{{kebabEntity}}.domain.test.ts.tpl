import { describe, expect, it } from 'vitest';

import { Invalid{{Entity}}NameError, normalize{{Entity}}Name } from '../src/domain/{{kebabEntity}}.js';

describe('normalize{{Entity}}Name', () => {
  it('trims surrounding whitespace', () => {
    expect(normalize{{Entity}}Name('  Front Desk  ')).toBe('Front Desk');
  });

  it('accepts letters, numbers, and punctuation like apostrophes and periods', () => {
    const input = "O'Brien's Desk 2.0, Ltd";
    expect(normalize{{Entity}}Name(input)).toBe(input);
  });

  it('rejects an empty name', () => {
    expect(() => normalize{{Entity}}Name('   ')).toThrow(Invalid{{Entity}}NameError);
  });

  it('rejects a name over 128 characters', () => {
    expect(() => normalize{{Entity}}Name('x'.repeat(129))).toThrow(Invalid{{Entity}}NameError);
  });

  it('rejects control characters', () => {
    const withNull = `name${String.fromCharCode(0)}withnull`;
    expect(() => normalize{{Entity}}Name(withNull)).toThrow(Invalid{{Entity}}NameError);
  });
});

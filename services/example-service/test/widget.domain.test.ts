import { describe, expect, it } from 'vitest';

import { InvalidWidgetNameError, normalizeWidgetName } from '../src/domain/widget.js';

describe('normalizeWidgetName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeWidgetName('  Front Desk  ')).toBe('Front Desk');
  });

  it('accepts letters, numbers, and punctuation like apostrophes and periods', () => {
    const input = "O'Brien's Desk 2.0, Ltd";
    expect(normalizeWidgetName(input)).toBe(input);
  });

  it('rejects an empty name', () => {
    expect(() => normalizeWidgetName('   ')).toThrow(InvalidWidgetNameError);
  });

  it('rejects a name over 128 characters', () => {
    expect(() => normalizeWidgetName('x'.repeat(129))).toThrow(InvalidWidgetNameError);
  });

  it('rejects control characters', () => {
    const withNull = `name${String.fromCharCode(0)}withnull`;
    expect(() => normalizeWidgetName(withNull)).toThrow(InvalidWidgetNameError);
  });
});

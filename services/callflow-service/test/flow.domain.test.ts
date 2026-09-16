import { describe, expect, it } from 'vitest';

import { InvalidFlowNameError, normalizeFlowName } from '../src/domain/flow.js';

describe('normalizeFlowName', () => {
  it('trims surrounding whitespace', () => {
    expect(normalizeFlowName('  Front Desk  ')).toBe('Front Desk');
  });

  it('accepts letters, numbers, and punctuation like apostrophes and periods', () => {
    const input = "O'Brien's Desk 2.0, Ltd";
    expect(normalizeFlowName(input)).toBe(input);
  });

  it('rejects an empty name', () => {
    expect(() => normalizeFlowName('   ')).toThrow(InvalidFlowNameError);
  });

  it('rejects a name over 128 characters', () => {
    expect(() => normalizeFlowName('x'.repeat(129))).toThrow(InvalidFlowNameError);
  });

  it('rejects control characters', () => {
    const withNull = `name${String.fromCharCode(0)}withnull`;
    expect(() => normalizeFlowName(withNull)).toThrow(InvalidFlowNameError);
  });
});

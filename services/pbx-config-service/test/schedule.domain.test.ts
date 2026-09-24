import { describe, expect, it } from 'vitest';

import {
  InvalidScheduleError,
  validateHolidays,
  validateLabel,
  validateRules,
  validateTimezone,
} from '../src/domain/schedule.js';

describe('validateLabel', () => {
  it('trims, and refuses empty or too long', () => {
    expect(validateLabel('  Office hours ')).toBe('Office hours');
    expect(() => validateLabel('   ')).toThrow(InvalidScheduleError);
    expect(() => validateLabel('x'.repeat(256))).toThrow(InvalidScheduleError);
  });
});

describe('validateTimezone', () => {
  it('accepts IANA names and refuses anything else', () => {
    expect(validateTimezone('America/Chicago')).toBe('America/Chicago');
    expect(validateTimezone('UTC')).toBe('UTC');
    expect(() => validateTimezone('Mars/Olympus')).toThrow(InvalidScheduleError);
    expect(() => validateTimezone('')).toThrow(InvalidScheduleError);
  });
});

describe('validateRules', () => {
  const window = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

  it('accepts weekly windows and sorts the days', () => {
    expect(validateRules([{ ...window, days: [5, 1, 3] }])).toEqual([
      { days: [1, 3, 5], start: '09:00', end: '17:00' },
    ]);
    expect(validateRules([])).toEqual([]);
  });

  it.each([
    ['no days', { ...window, days: [] }],
    ['a day twice', { ...window, days: [1, 1] }],
    ['a day out of range', { ...window, days: [7] }],
    ['a fractional day', { ...window, days: [1.5] }],
    ['a bad start', { ...window, start: '9:00' }],
    ['a bad end', { ...window, end: '24:00' }],
    ['an end at the start', { ...window, end: '09:00' }],
    ['an end before the start', { ...window, start: '17:00', end: '09:00' }],
  ])('refuses %s', (_name, rule) => {
    expect(() => validateRules([rule])).toThrow(InvalidScheduleError);
  });

  it('names the window that is wrong', () => {
    expect(() => validateRules([window, { ...window, days: [] }])).toThrow(/Window 2/);
  });

  it('limits how many windows there can be', () => {
    expect(() => validateRules(Array.from({ length: 51 }, () => window))).toThrow(
      InvalidScheduleError,
    );
  });
});

describe('validateHolidays', () => {
  it('accepts dates, trims labels, drops blank ones, and sorts by date', () => {
    expect(
      validateHolidays([
        { date: '2026-12-25', label: ' Christmas ' },
        { date: '2026-01-01', label: '  ' },
      ]),
    ).toEqual([{ date: '2026-01-01' }, { date: '2026-12-25', label: 'Christmas' }]);
  });

  it.each(['2026-13-01', '2026-02-30', '26-01-01', 'tomorrow', '2026-1-1'])(
    'refuses %s',
    (date) => {
      expect(() => validateHolidays([{ date }])).toThrow(InvalidScheduleError);
    },
  );

  it('accepts a real leap day and refuses a fake one', () => {
    expect(validateHolidays([{ date: '2028-02-29' }])).toHaveLength(1);
    expect(() => validateHolidays([{ date: '2027-02-29' }])).toThrow(InvalidScheduleError);
  });

  it('refuses a date listed twice', () => {
    expect(() => validateHolidays([{ date: '2026-07-04' }, { date: '2026-07-04' }])).toThrow(
      /more than once/,
    );
  });
});

import { describe, expect, it } from 'vitest';

import { isScheduleOpen } from '../src/domain/schedule.js';

const office = {
  timezone: 'America/Chicago',
  rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
  holidays: [{ date: '2026-07-03' }],
};
// 2026-07-01 is a Wednesday; Chicago is UTC-5 in July (daylight time).
const at = (iso: string) => new Date(iso);

describe('isScheduleOpen', () => {
  it("is open inside a window, in the schedule's own time zone", () => {
    expect(isScheduleOpen(office, at('2026-07-01T15:00:00Z'))).toBe(true); // 10:00 local
  });

  it('is closed outside the window, whatever the UTC clock says', () => {
    expect(isScheduleOpen(office, at('2026-07-01T12:00:00Z'))).toBe(false); // 07:00 local
    expect(isScheduleOpen(office, at('2026-07-01T23:00:00Z'))).toBe(false); // 18:00 local
  });

  it('includes the start and excludes the end', () => {
    expect(isScheduleOpen(office, at('2026-07-01T14:00:00Z'))).toBe(true); // 09:00 local
    expect(isScheduleOpen(office, at('2026-07-01T21:59:00Z'))).toBe(true); // 16:59 local
    expect(isScheduleOpen(office, at('2026-07-01T22:00:00Z'))).toBe(false); // 17:00 local
  });

  it('is closed on days with no window', () => {
    expect(isScheduleOpen(office, at('2026-07-04T15:00:00Z'))).toBe(false); // Saturday
  });

  it('is closed on a holiday, by the local date', () => {
    expect(isScheduleOpen(office, at('2026-07-03T15:00:00Z'))).toBe(false);
    // 02:00 UTC on the 4th is still the 3rd in Chicago.
    const allDay = { ...office, rules: [{ days: [5], start: '00:00', end: '23:59' }] };
    expect(isScheduleOpen(allDay, at('2026-07-04T02:00:00Z'))).toBe(false);
  });

  it('uses the weekday in the schedule zone, not in UTC', () => {
    // 03:00 UTC Thursday is 22:00 Wednesday in Chicago.
    const evening = {
      ...office,
      holidays: [],
      rules: [{ days: [3], start: '20:00', end: '23:00' }],
    };
    expect(isScheduleOpen(evening, at('2026-07-02T03:00:00Z'))).toBe(true);
  });

  it('follows daylight time changes', () => {
    const nine = {
      timezone: 'America/Chicago',
      holidays: [],
      rules: [{ days: [1], start: '09:00', end: '10:00' }],
    };
    // Monday 2026-03-09, after the spring change: 09:30 local is 14:30 UTC.
    expect(isScheduleOpen(nine, at('2026-03-09T14:30:00Z'))).toBe(true);
    // Monday 2026-03-02, before it: 09:30 local is 15:30 UTC.
    expect(isScheduleOpen(nine, at('2026-03-02T15:30:00Z'))).toBe(true);
    expect(isScheduleOpen(nine, at('2026-03-02T14:30:00Z'))).toBe(false);
  });

  it('is never open with no windows', () => {
    expect(isScheduleOpen({ ...office, rules: [] }, at('2026-07-01T15:00:00Z'))).toBe(false);
  });
});

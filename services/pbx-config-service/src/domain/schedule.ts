/**
 * Pure business logic for schedules (S3-08; 05 §3.3). No DB here.
 *
 * A schedule is open hours: weekly windows (`rules`) evaluated in the
 * schedule's own IANA time zone, minus the dates listed as `holidays`.
 */

const MAX_LABEL_LENGTH = 255;
const MAX_RULES = 50;
const MAX_HOLIDAYS = 400;
const MAX_HOLIDAY_LABEL_LENGTH = 100;
const TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export class InvalidScheduleError extends Error {
  override readonly name = 'InvalidScheduleError';
}

/** Days are numbered 0 (Sunday) to 6 (Saturday), as JavaScript's `getDay` does. */
export interface ScheduleRule {
  readonly days: readonly number[];
  /** `HH:MM`, 24-hour, inclusive. */
  readonly start: string;
  /** `HH:MM`, 24-hour, exclusive, and after `start` (a window does not cross midnight). */
  readonly end: string;
}

export interface ScheduleHoliday {
  /** `YYYY-MM-DD`, in the schedule's time zone. */
  readonly date: string;
  readonly label?: string;
}

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidScheduleError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

export function validateTimezone(timezone: string): string {
  const trimmed = timezone.trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: trimmed });
  } catch {
    throw new InvalidScheduleError(`'${timezone}' is not a known IANA time zone.`);
  }
  return trimmed;
}

export function validateRules(input: readonly ScheduleRule[]): ScheduleRule[] {
  if (input.length > MAX_RULES) {
    throw new InvalidScheduleError(`A schedule can have at most ${String(MAX_RULES)} windows.`);
  }
  return input.map((rule, i) => {
    const where = `Window ${String(i + 1)}`;
    if (rule.days.length === 0) throw new InvalidScheduleError(`${where} needs at least one day.`);
    const days = [...new Set(rule.days)].sort((a, b) => a - b);
    if (days.length !== rule.days.length) {
      throw new InvalidScheduleError(`${where} lists a day more than once.`);
    }
    for (const day of days) {
      if (!Number.isInteger(day) || day < 0 || day > 6) {
        throw new InvalidScheduleError(`${where}: days are numbers 0 (Sunday) to 6 (Saturday).`);
      }
    }
    if (!TIME_PATTERN.test(rule.start) || !TIME_PATTERN.test(rule.end)) {
      throw new InvalidScheduleError(`${where}: times are HH:MM, 24-hour.`);
    }
    if (rule.end <= rule.start) {
      throw new InvalidScheduleError(`${where}: the end must be after the start.`);
    }
    return { days, start: rule.start, end: rule.end };
  });
}

export function validateHolidays(input: readonly ScheduleHoliday[]): ScheduleHoliday[] {
  if (input.length > MAX_HOLIDAYS) {
    throw new InvalidScheduleError(`A schedule can have at most ${String(MAX_HOLIDAYS)} holidays.`);
  }
  const seen = new Set<string>();
  const result = input.map((holiday) => {
    if (!DATE_PATTERN.test(holiday.date) || !isRealDate(holiday.date)) {
      throw new InvalidScheduleError(`'${holiday.date}' is not a date (YYYY-MM-DD).`);
    }
    if (seen.has(holiday.date)) {
      throw new InvalidScheduleError(`${holiday.date} is listed as a holiday more than once.`);
    }
    seen.add(holiday.date);
    const label = holiday.label?.trim();
    if (label !== undefined && label.length > MAX_HOLIDAY_LABEL_LENGTH) {
      throw new InvalidScheduleError(
        `A holiday's label can be at most ${String(MAX_HOLIDAY_LABEL_LENGTH)} characters.`,
      );
    }
    return label === undefined || label.length === 0
      ? { date: holiday.date }
      : { date: holiday.date, label };
  });
  return result.sort((a, b) => a.date.localeCompare(b.date));
}

function isRealDate(value: string): boolean {
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().startsWith(value);
}

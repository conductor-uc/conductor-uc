/** Retention (S5-05). Pure. */

export const MAX_RETENTION_DAYS = 3650;

export class InvalidRetentionError extends Error {
  override readonly name = 'InvalidRetentionError';
}

/** 0 keeps recordings until someone deletes them; otherwise whole days, at most ten years. */
export function validateRetentionDays(days: number): number {
  if (!Number.isInteger(days) || days < 0 || days > MAX_RETENTION_DAYS) {
    throw new InvalidRetentionError(
      `Retention must be a whole number of days from 0 (keep until deleted) to ${String(MAX_RETENTION_DAYS)}.`,
    );
  }
  return days;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** When a recording that started at `startedAt` expires, or null when retention is off. */
export function retentionDateFor(startedAt: Date, retentionDays: number): Date | null {
  if (retentionDays === 0) return null;
  return new Date(startedAt.getTime() + retentionDays * DAY_MS);
}

/**
 * The S3 lifecycle backstop is set one day after the database's retention, so the sweep
 * (which also marks the row and emits the event) normally runs first and the bucket rule
 * only catches what the sweep missed. Null when retention is off.
 */
export function lifecycleExpirationDays(retentionDays: number): number | null {
  return retentionDays === 0 ? null : retentionDays + 1;
}

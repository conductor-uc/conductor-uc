/**
 * Pure business logic for a tenant's emergency route (S2-06; 05 §3.4:
 * "`emergency_routes` | `tenant_id`, `trunk_id`, `numbers`"; G-1). No DB
 * here — `repo/emergency-route.repo.ts` is where this meets actual rows.
 */

export class InvalidEmergencyRouteError extends Error {
  override readonly name = 'InvalidEmergencyRouteError';
}

// A direct-dial emergency number: digits only, no leading '+' (G-1's own
// "direct dial without a prefix" — these are dialed exactly as-is, never
// E.164-normalized the way `outbound-route.ts`'s own pattern is).
const NUMBER = /^\d{2,6}$/;

/** At least one number, no duplicates. */
export function validateNumbers(numbers: readonly string[]): string[] {
  if (numbers.length === 0) {
    throw new InvalidEmergencyRouteError('At least one emergency number is required.');
  }
  const seen = new Set<string>();
  for (const number of numbers) {
    const trimmed = number.trim();
    if (!NUMBER.test(trimmed)) {
      throw new InvalidEmergencyRouteError(
        `'${number}' is not a valid emergency number: digits only, no country code or prefix.`,
      );
    }
    if (seen.has(trimmed)) {
      throw new InvalidEmergencyRouteError(`'${trimmed}' is listed more than once.`);
    }
    seen.add(trimmed);
  }
  return [...seen];
}

/** At most this many addresses are emailed on an emergency call. */
export const MAX_NOTIFY_EMAILS = 10;

// Deliberately loose: something@something.something, no spaces. The address is only ever a mail
// recipient; a typo shows as mail that never arrives, which the console's own form helps avoid.
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * S2-06 (G-1): who is emailed when someone in the tenant dials an emergency number (the on-site
 * notification). Lowercased, duplicates refused; none is allowed.
 */
export function validateNotifyEmails(emails: readonly string[]): string[] {
  if (emails.length > MAX_NOTIFY_EMAILS) {
    throw new InvalidEmergencyRouteError(
      `At most ${String(MAX_NOTIFY_EMAILS)} notification addresses are allowed.`,
    );
  }
  const seen = new Set<string>();
  for (const email of emails) {
    const normalized = email.trim().toLowerCase();
    if (normalized.length > 254 || !EMAIL.test(normalized)) {
      throw new InvalidEmergencyRouteError(`'${email}' is not a valid email address.`);
    }
    if (seen.has(normalized)) {
      throw new InvalidEmergencyRouteError(`'${normalized}' is listed more than once.`);
    }
    seen.add(normalized);
  }
  return [...seen];
}

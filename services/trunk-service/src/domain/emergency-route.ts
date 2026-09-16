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

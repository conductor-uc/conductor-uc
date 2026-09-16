/**
 * E.164 normalization for outbound-dialed numbers (S2-04's own line:
 * "E.164 normalization by tenant country"). Real phone-number parsing
 * (national significant number lengths, area-code rules, and so on) is not
 * something to hand-rolled — `libphonenumber-js` is the same library
 * underlying Google's own reference implementation, trimmed for browser/
 * server use, with no native dependencies.
 */
import { parsePhoneNumberFromString, type CountryCode } from 'libphonenumber-js';

/**
 * Normalizes a dialed number to E.164 using `tenantCountry` (an ISO 3166-1
 * alpha-2 code, org-service's own `orgs.country`) as the default region for
 * a number with no leading `+`. Returns `undefined` when the input cannot be
 * parsed into a valid number at all — `/fs/dialplan`'s outbound branch
 * treats that the same as "no matching extension, no matching route": an
 * honest miss, not a guess.
 */
export function normalizeToE164(dialed: string, tenantCountry: string): string | undefined {
  const trimmed = dialed.trim();
  if (trimmed === '') return undefined;

  const parsed = parsePhoneNumberFromString(trimmed, tenantCountry as CountryCode);
  if (parsed === undefined || !parsed.isValid()) return undefined;
  return parsed.number;
}

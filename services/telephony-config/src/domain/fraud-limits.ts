/**
 * A tenant's toll-fraud controls (S2-05; 07 §6: "Per-tenant `max_channels`
 * and outbound calls-per-second limits ... International calling off by
 * default. Country and prefix allow-lists per tenant."). Stored in
 * `orgs.limits` (org-service) as an untyped bag — this module is what gives
 * the toll-fraud subset of that bag a shape and safe defaults, since
 * org-service itself has no reason to know what a "concurrent channel" is.
 */
export interface FraudLimits {
  /** `null` means unlimited — same convention `trunks.max_channels` already uses. */
  readonly maxConcurrentChannels: number | null;
  readonly maxCallsPerSecond: number | null;
  /** Off by default (07 §6) — a tenant must opt in explicitly. */
  readonly internationalAllowed: boolean;
  /** ISO 3166-1 alpha-2 codes. A destination in this list is always allowed, regardless of `internationalAllowed`. */
  readonly countryAllowList: readonly string[];
}

function parsePositiveIntOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function parseCountryAllowList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.length === 2)
    .map((entry) => entry.toUpperCase());
}

/**
 * Defensive parsing, not validation: a malformed or missing field silently
 * falls back to its safe default rather than throwing — `orgs.limits` is a
 * generic bag org-service never validates against this shape (this module's
 * own doc comment), so a garbage value here is either a different feature's
 * own key or a client mistake, neither of which should make outbound
 * dialing itself fail closed in a confusing way. Failing closed on the
 * *values this module does understand* (unlimited unless a valid positive
 * integer is set, international off unless explicitly `true`) is the actual
 * fraud-control safety net.
 */
export function parseFraudLimits(raw: Record<string, unknown>): FraudLimits {
  return {
    maxConcurrentChannels: parsePositiveIntOrNull(raw.maxConcurrentChannels),
    maxCallsPerSecond: parsePositiveIntOrNull(raw.maxCallsPerSecond),
    internationalAllowed: raw.internationalAllowed === true,
    countryAllowList: parseCountryAllowList(raw.countryAllowList),
  };
}

/**
 * Whether an outbound call to `destinationCountry` is allowed under
 * `limits` for a tenant based in `tenantCountry`. A destination whose
 * country cannot be determined (`e164.ts`'s `destinationCountry`, e.g. a
 * shared calling code with no single owning region) is treated as
 * international — the same fail-closed reasoning as an unset
 * `internationalAllowed`, not a guess in the caller's favor.
 */
export function isOutboundCallAllowed(
  limits: FraudLimits,
  tenantCountry: string,
  destinationCountry: string | undefined,
): boolean {
  if (destinationCountry === tenantCountry) return true;
  if (limits.internationalAllowed) return true;
  return destinationCountry !== undefined && limits.countryAllowList.includes(destinationCountry);
}

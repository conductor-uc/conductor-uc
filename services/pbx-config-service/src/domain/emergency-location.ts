/**
 * A dispatchable civic address (S2-06; G-1/issue #96: US and Canada in
 * scope for v1 — RAY BAUM'S Act's own term is "dispatchable location," not
 * just a mailing address, hence the format checks below rather than a bare
 * non-empty string).
 */
export class InvalidEmergencyLocationError extends Error {
  override readonly name = 'InvalidEmergencyLocationError';
}

export const EMERGENCY_LOCATION_COUNTRIES = ['US', 'CA'] as const;
export type EmergencyLocationCountry = (typeof EMERGENCY_LOCATION_COUNTRIES)[number];

const US_ZIP = /^\d{5}(-\d{4})?$/;
// A1A 1A1, optionally without the space/hyphen (Canada Post's own tolerance).
const CA_POSTAL_CODE = /^[A-Za-z]\d[A-Za-z][ -]?\d[A-Za-z]\d$/;

function requireNonEmpty(value: string, field: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed === '') throw new InvalidEmergencyLocationError(`${field} is required.`);
  if (trimmed.length > maxLength) {
    throw new InvalidEmergencyLocationError(
      `${field} must be ${String(maxLength)} characters or fewer.`,
    );
  }
  return trimmed;
}

export function validateLabel(label: string): string {
  return requireNonEmpty(label, 'label', 255);
}

export function validateAddressLine1(value: string): string {
  return requireNonEmpty(value, 'addressLine1', 255);
}

export function validateAddressLine2(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === '') return null;
  if (trimmed.length > 255) {
    throw new InvalidEmergencyLocationError('addressLine2 must be 255 characters or fewer.');
  }
  return trimmed;
}

export function validateCity(value: string): string {
  return requireNonEmpty(value, 'city', 255);
}

export function validateState(value: string): string {
  return requireNonEmpty(value, 'state', 64);
}

export function validateCountry(value: string): EmergencyLocationCountry {
  const upper = value.trim().toUpperCase();
  if (!EMERGENCY_LOCATION_COUNTRIES.includes(upper as EmergencyLocationCountry)) {
    throw new InvalidEmergencyLocationError(
      `country must be one of: ${EMERGENCY_LOCATION_COUNTRIES.join(', ')}.`,
    );
  }
  return upper as EmergencyLocationCountry;
}

/** Format depends on `country` — validated together since a US ZIP is not a valid Canadian postal code and vice versa. */
export function validatePostalCode(country: EmergencyLocationCountry, postalCode: string): string {
  const trimmed = postalCode.trim();
  const pattern = country === 'US' ? US_ZIP : CA_POSTAL_CODE;
  if (!pattern.test(trimmed)) {
    throw new InvalidEmergencyLocationError(
      `postalCode is not a valid ${country === 'US' ? 'US ZIP code' : 'Canadian postal code'}.`,
    );
  }
  return country === 'US' ? trimmed : trimmed.toUpperCase();
}

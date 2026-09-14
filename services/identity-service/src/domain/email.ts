/**
 * Pure business logic for email addresses (09 §1). Not a full RFC 5322
 * parser — just enough to reject obvious garbage before it reaches a unique
 * index, with a normalization rule the repository can rely on.
 */

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export class InvalidEmailError extends Error {
  override readonly name = 'InvalidEmailError';
}

/**
 * Validates and lowercases an email address.
 *
 * Lowercasing here, once, is what makes "email unique per org" (05 §3.2)
 * actually hold: without it, `A@x.com` and `a@x.com` would pass the unique
 * index as different values while being the same login to any real mail
 * system.
 */
export function normalizeEmail(input: string): string {
  const trimmed = input.trim();
  if (!EMAIL_PATTERN.test(trimmed) || trimmed.length > 255) {
    throw new InvalidEmailError(`'${input}' is not a valid email address.`);
  }
  return trimmed.toLowerCase();
}

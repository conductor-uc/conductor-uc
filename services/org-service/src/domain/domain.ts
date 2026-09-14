import { randomBytes } from 'node:crypto';

/**
 * Pure business logic for domains (02 §3). No DB, no DNS here — `repo/domain.repo.ts`
 * and `repo/org.repo.ts` are where these rules meet actual rows and actual lookups.
 */

// A DNS label per label, dot-separated, lowercase, no leading/trailing dot,
// 253 chars overall (RFC 1035). Reseller-supplied base domains are somebody
// else's DNS name, so this is intentionally looser than `validateSlug`'s
// platform-owned-label rule in `org.ts`.
const LABEL = '[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?';
const FQDN_PATTERN = new RegExp(`^${LABEL}(\\.${LABEL})+$`);

export class InvalidFqdnError extends Error {
  override readonly name = 'InvalidFqdnError';
}

/** Validates a fully-qualified domain name: lowercase, dot-separated DNS labels, at least two. */
export function validateFqdn(fqdn: string): string {
  if (fqdn.length > 253 || !FQDN_PATTERN.test(fqdn)) {
    throw new InvalidFqdnError(
      `'${fqdn}' is not a valid domain name: lowercase DNS labels separated by dots.`,
    );
  }
  return fqdn;
}

/** A tenant's primary SIP domain: `{tenant-slug}.{base}` (02 §3). */
export function tenantDomainFor(tenantSlug: string, base: string): string {
  return `${tenantSlug}.${base}`;
}

/** A random, hard-to-guess verification token for a base-domain TXT challenge. */
export function generateVerificationToken(): string {
  return randomBytes(20).toString('hex');
}

/**
 * The TXT record name and expected content a reseller must publish to prove
 * ownership of a base domain.
 *
 * `_domain-verification` is a generic, neutral label — it names what the
 * record is for, not who is asking (rule 1: nothing network-visible, and a
 * DNS record a reseller publishes is exactly that, names or references the
 * codebase or the operator).
 */
export function verificationRecordName(fqdn: string): string {
  return `_domain-verification.${fqdn}`;
}

/** True when `txtRecords` (as returned by a DNS TXT lookup) contains `token` in full. */
export function verificationRecordMatches(
  txtRecords: readonly (readonly string[])[],
  token: string,
): boolean {
  return txtRecords.some((record) => record.join('') === token);
}

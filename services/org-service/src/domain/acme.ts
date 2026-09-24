import type { AcmeDirectory } from '../schema.js';

/**
 * The two Let's Encrypt directories an operator can choose between in the
 * console. The staging one is for trying the whole flow against real domains
 * without spending the production rate limits; its certificates are signed by a
 * CA no phone or browser trusts.
 */
export const ACME_DIRECTORY_URLS: Record<AcmeDirectory, string> = {
  production: 'https://acme-v02.api.letsencrypt.org/directory',
  staging: 'https://acme-staging-v02.api.letsencrypt.org/directory',
};

/** Where Let's Encrypt publishes its subscriber agreement, if its directory cannot be asked. */
export const FALLBACK_TERMS_URL = 'https://letsencrypt.org/repository/';

export class InvalidContactEmailError extends Error {
  override readonly name = 'InvalidContactEmailError';
}

/**
 * The address the ACME account is registered to, or null to clear it. Let's
 * Encrypt sends expiry warnings here, so it should be a monitored mailbox.
 * Deliberately plain: one address, no display name, no list.
 */
export function validateContactEmail(value: string | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const email = value.trim().toLowerCase();
  if (email === '') return null;
  if (email.length > 254 || !/^[^\s@,;<>()"]+@[^\s@,;<>()"]+\.[^\s@,;<>()"]+$/.test(email)) {
    throw new InvalidContactEmailError('Enter one email address, such as certs@example.com.');
  }
  return email;
}

/** Whether the platform is set up to request certificates: an address, and the terms agreed for the chosen directory. */
export function acmeReady(settings: {
  contactEmail: string | null;
  directory: AcmeDirectory;
  termsAgreedDirectory: AcmeDirectory | null;
}): boolean {
  return settings.contactEmail !== null && settings.termsAgreedDirectory === settings.directory;
}

import { X509Certificate, createPrivateKey } from 'node:crypto';

/**
 * Pure logic for the certificates the platform keeps (G-105). No DB, no ACME.
 */

/** The SIP proxy hostname for a base domain: `sip.<base>`. Phones connect here, whatever their login domain. */
export function sipProxyHostname(base: string): string {
  return `sip.${base.trim().toLowerCase()}`;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/** Renew this long before expiry. Let's Encrypt certificates last 90 days, so a failed renewal has weeks of retries. */
export const RENEW_BEFORE_MS = 30 * DAY_MS;

/** Whether a held certificate should be renewed now. */
export function renewalDue(notAfter: Date | null, now: Date): boolean {
  return notAfter === null || notAfter.getTime() - now.getTime() <= RENEW_BEFORE_MS;
}

/**
 * How long to wait after the [attempts]th failure (1 for the first) before
 * trying again: a minute, then five, thirty, two hours, six, and a day from
 * then on. Failures are usually DNS that has not propagated yet, which mends in
 * minutes, or a real fault that will not, and a fast retry loop against a public
 * CA earns a rate limit.
 */
export function retryDelayMs(attempts: number): number {
  const steps = [60_000, 5 * 60_000, 30 * 60_000, 2 * 60 * 60_000, 6 * 60 * 60_000, DAY_MS];
  return steps[Math.min(Math.max(attempts, 1), steps.length) - 1] ?? DAY_MS;
}

export class InvalidCertificateError extends Error {
  override readonly name = 'InvalidCertificateError';
}

export interface CertificateFacts {
  readonly notBefore: Date;
  readonly notAfter: Date;
}

/**
 * Checks that [certificatePem] is a certificate for [fqdn], is still valid, and
 * goes with [privateKeyPem], and reports its validity window. A wrong pair
 * stored by mistake would be served to every phone, so this refuses it.
 */
export function inspectCertificate(
  certificatePem: string,
  privateKeyPem: string,
  fqdn: string,
  now: Date = new Date(),
): CertificateFacts {
  let leaf: X509Certificate;
  try {
    leaf = new X509Certificate(certificatePem);
  } catch {
    throw new InvalidCertificateError('The certificate is not valid PEM.');
  }
  if (leaf.checkHost(fqdn) === undefined) {
    throw new InvalidCertificateError(`The certificate does not cover ${fqdn}.`);
  }
  let key;
  try {
    key = createPrivateKey(privateKeyPem);
  } catch {
    throw new InvalidCertificateError('The private key is not valid PEM.');
  }
  if (!leaf.checkPrivateKey(key)) {
    throw new InvalidCertificateError('The private key does not belong to the certificate.');
  }
  const notBefore = new Date(leaf.validFrom);
  const notAfter = new Date(leaf.validTo);
  if (notAfter.getTime() <= now.getTime()) {
    throw new InvalidCertificateError('The certificate has already expired.');
  }
  return { notBefore, notAfter };
}

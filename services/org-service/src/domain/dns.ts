import { isIP } from 'node:net';

/**
 * Pure logic for the DNS records a reseller publishes (G-105). No DB.
 */

export type DnsRecordType = 'A' | 'AAAA' | 'CNAME';

export class InvalidPublicAddressError extends Error {
  override readonly name = 'InvalidPublicAddressError';
}

const HOSTNAME =
  /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/;

/** What kind of record points a name at [address]: an IPv4 address is an A record, IPv6 an AAAA, a hostname a CNAME. */
export function recordTypeFor(address: string): DnsRecordType {
  const family = isIP(address);
  if (family === 4) return 'A';
  if (family === 6) return 'AAAA';
  return 'CNAME';
}

/**
 * The public address as saved: trimmed, lower-cased, an IP address or a hostname.
 * Empty clears it. A URL, a port or a path would end up in a DNS record, so they
 * are refused rather than cleaned.
 */
export function validatePublicAddress(input: string | null | undefined): string | null {
  const value = (input ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (value === '') return null;
  if (isIP(value) !== 0) return value;
  // A final label of digits only is a malformed IP address (999.1.1.1), never a hostname.
  if (HOSTNAME.test(value) && !/^\d+$/.test(value.slice(value.lastIndexOf('.') + 1))) return value;
  throw new InvalidPublicAddressError(
    'Enter an IP address or a hostname, such as 203.0.113.10 or edge.example.com, without http:// or a port.',
  );
}

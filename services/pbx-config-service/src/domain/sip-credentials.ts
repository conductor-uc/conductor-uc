import { createHash, randomBytes } from 'node:crypto';

/**
 * Pure business logic for SIP digest credentials (06, 07 §3.2's `secret`
 * data class). No DB, no encryption here — `repo/extension.repo.ts` is where
 * this meets actual rows and `@cuc/crypto`.
 *
 * By convention here the SIP username equals the extension number: the
 * simplest mapping, and the one most SIP endpoints assume when a tenant
 * provisions a device by hand. `sip_credentials.username` is still its own
 * column (05 §3.3), not derived at read time, because OpenSIPs' `auth_db`
 * looks a subscriber up by `(username, realm)` and that lookup must not
 * change shape just because an extension's dialable number does — a number
 * change and a SIP-credential change are handled as two separate concerns.
 */

const PASSWORD_BYTES = 18;

/** A random SIP password. Not derived from anything — pure entropy. */
export function generateSipPassword(): string {
  return randomBytes(PASSWORD_BYTES).toString('base64url');
}

export interface SipDigest {
  readonly ha1: string;
  readonly ha1b: string;
}

/**
 * RFC 2617 digest hashes, in the two shapes OpenSIPs' `auth_db` supports
 * (`calculate_ha1` off): `ha1` for a bare username in the Authorization
 * header, `ha1b` for one that includes the domain (`user@realm`) — which UA
 * sends which is not something this service controls, so both are always
 * computed and stored (02 §3: this is exactly what has to be recomputed
 * whenever `realm` changes).
 */
export function computeSipDigest(username: string, realm: string, password: string): SipDigest {
  return {
    ha1: md5(`${username}:${realm}:${password}`),
    ha1b: md5(`${username}@${realm}:${realm}:${password}`),
  };
}

function md5(value: string): string {
  return createHash('md5').update(value, 'utf8').digest('hex');
}

/**
 * Pure business logic for trunk configuration (06, 07 §3.2's `config`/`secret`
 * data classes). No DB, no encryption here — `repo/trunk.repo.ts` is where
 * this meets actual rows and `@cuc/crypto`.
 */

export const AUTH_MODES = ['register', 'ip', 'both'] as const;
export type AuthMode = (typeof AUTH_MODES)[number];

export const TRANSPORTS = ['udp', 'tcp', 'tls'] as const;
export type Transport = (typeof TRANSPORTS)[number];

export class InvalidTrunkConfigError extends Error {
  override readonly name = 'InvalidTrunkConfigError';
}

export class InvalidCidrError extends Error {
  override readonly name = 'InvalidCidrError';
}

export interface CallerIdPolicy {
  readonly name: string | null;
  readonly number: string | null;
}

export interface TrunkCredentialPresence {
  readonly authMode: AuthMode;
  readonly hasUsername: boolean;
  readonly hasSecret: boolean;
}

/**
 * `register`/`both` need a register username and secret to authenticate to
 * the carrier (03's routing pseudocode: `uac_auth` with trunk creds); `ip`
 * never registers, so a stray credential would be dead data nothing reads —
 * disallowed rather than silently ignored, so a caller finds out immediately
 * if it set the wrong auth mode.
 *
 * Takes presence booleans, not the actual username/secret: a repo update
 * that leaves an already-encrypted secret untouched has no plaintext to pass
 * here, only the fact that one exists.
 */
export function validateCredentialForAuthMode(input: TrunkCredentialPresence): void {
  const needsCredential = input.authMode === 'register' || input.authMode === 'both';

  if (needsCredential && (!input.hasUsername || !input.hasSecret)) {
    throw new InvalidTrunkConfigError(
      `auth_mode '${input.authMode}' requires both a username and a secret.`,
    );
  }
  if (!needsCredential && (input.hasUsername || input.hasSecret)) {
    throw new InvalidTrunkConfigError(
      `auth_mode 'ip' does not register to a carrier — no username or secret should be set.`,
    );
  }
}

/** De-duplicated, upper-cased codec names, in the order given (preference order matters — 06). */
export function validateCodecs(codecs: readonly string[]): string[] {
  if (codecs.length === 0) {
    throw new InvalidTrunkConfigError('At least one codec is required.');
  }
  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const codec of codecs) {
    const trimmed = codec.trim().toUpperCase();
    if (trimmed === '') throw new InvalidTrunkConfigError('A codec name cannot be blank.');
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      normalized.push(trimmed);
    }
  }
  return normalized;
}

export function validateMaxChannels(maxChannels: number | null | undefined): number | null {
  if (maxChannels === undefined || maxChannels === null) return null;
  if (!Number.isInteger(maxChannels) || maxChannels < 1) {
    throw new InvalidTrunkConfigError(
      'max_channels must be a positive integer, or null for no limit.',
    );
  }
  return maxChannels;
}

const IPV4_CIDR = /^(\d{1,3}\.){3}\d{1,3}\/(\d|[12]\d|3[0-2])$/;
const IPV6_CIDR = /^[0-9a-fA-F:]+\/(\d|[1-9]\d|1[01]\d|12[0-8])$/;

/** Accepts IPv4 or IPv6 CIDR notation — the shape `trunk_ips.cidr` is matched against (03: inbound trunk identification). */
export function validateCidr(cidr: string): string {
  const trimmed = cidr.trim();
  const isIpv4 =
    IPV4_CIDR.test(trimmed) &&
    trimmed
      .split('/')[0]!
      .split('.')
      .every((octet) => Number(octet) <= 255);
  if (!isIpv4 && !IPV6_CIDR.test(trimmed)) {
    throw new InvalidCidrError(`'${cidr}' is not a valid IPv4 or IPv6 CIDR.`);
  }
  return trimmed;
}

export function validateCallerIdPolicy(
  policy: CallerIdPolicy | null | undefined,
): CallerIdPolicy | null {
  if (policy === undefined || policy === null) return null;
  if (
    (policy.name === null || policy.name === '') &&
    (policy.number === null || policy.number === '')
  ) {
    throw new InvalidTrunkConfigError('A caller-ID policy needs at least a name or a number.');
  }
  return {
    name: policy.name === undefined ? null : policy.name,
    number: policy.number === undefined ? null : policy.number,
  };
}

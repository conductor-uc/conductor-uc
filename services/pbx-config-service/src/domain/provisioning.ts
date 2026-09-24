import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Pure logic for auto provisioning desk phones (no DB, no HTTP).
 *
 * A phone is pointed at a provisioning URL. It asks for a file named after its
 * own MAC address, and gets back the account settings for one extension. The
 * phone proves who it is with HTTP Basic credentials: the device id as the
 * username and a random provisioning password. Those credentials are never put
 * in the URL path, because request logs record paths and not headers.
 */

export class InvalidMacError extends Error {
  override readonly name = 'InvalidMacError';
}

/** `00:15:65:AA:BB:CC`, `00-15-65-aa-bb-cc` and `001565aabbcc` all become `001565aabbcc`. */
export function normalizeMac(input: string): string {
  const stripped = input
    .trim()
    .replace(/[:.\-\s]/g, '')
    .toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(stripped)) {
    throw new InvalidMacError('A MAC address is 12 hexadecimal digits, such as 00:15:65:aa:bb:cc.');
  }
  return stripped;
}

const TOKEN_BYTES = 32;

/** A random provisioning password: 256 bits, URL- and header-safe. */
export function generateProvisioningToken(): string {
  return randomBytes(TOKEN_BYTES).toString('base64url');
}

export function hashProvisioningToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Whether [presented] is the token whose hash is [storedHash], compared in constant time. */
export function tokenMatches(storedHash: string | null, presented: string): boolean {
  if (storedHash === null) return false;
  const a = Buffer.from(storedHash, 'utf8');
  const b = Buffer.from(hashProvisioningToken(presented), 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

/** Reads an `Authorization: Basic ...` header into its username and password. */
export function parseBasicAuth(
  header: string | undefined,
): { username: string; password: string } | undefined {
  if (header === undefined) return undefined;
  const match = /^Basic\s+(\S+)\s*$/i.exec(header);
  const encoded = match?.[1];
  if (encoded === undefined) return undefined;
  const decoded = Buffer.from(encoded, 'base64').toString('utf8');
  const colon = decoded.indexOf(':');
  if (colon <= 0) return undefined;
  return { username: decoded.slice(0, colon), password: decoded.slice(colon + 1) };
}

export type YealinkFile =
  { readonly kind: 'mac'; readonly mac: string } | { readonly kind: 'common' };

/**
 * What a Yealink phone asks for: its own `<mac>.cfg`, and a model-wide
 * `y0000000000NN.cfg` it tries first. Anything else is not ours to answer.
 */
export function parseYealinkFile(file: string): YealinkFile | undefined {
  const lower = file.toLowerCase();
  const mac = /^([0-9a-f]{12})\.cfg$/.exec(lower);
  if (mac?.[1] !== undefined) return { kind: 'mac', mac: mac[1] };
  if (/^y0000000000\d{2}\.cfg$/.test(lower)) return { kind: 'common' };
  return undefined;
}

export type SipTransportName = 'udp' | 'tcp' | 'tls';

/** Yealink's `transport_type`: 0 UDP, 1 TCP, 2 TLS. */
const TRANSPORT_TYPE: Record<SipTransportName, number> = { udp: 0, tcp: 1, tls: 2 };

export interface YealinkAccount {
  /** The extension's dialable number, shown as the line label. */
  readonly number: string;
  readonly displayName: string;
  /** The SIP user name, also used to authenticate. */
  readonly username: string;
  readonly password: string;
  readonly server: string;
  readonly port: number;
  readonly transport: SipTransportName;
}

/** The first line of every Yealink configuration file. */
const HEADER = '#!version:1.0.0.1';

/** A value on one line: control characters and line breaks would end it early or add a setting. */
function oneLine(value: string): string {
  // eslint-disable-next-line no-control-regex
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
}

/** The settings for a phone's first account. Line 1 only. */
export function renderYealinkConfig(account: YealinkAccount): string {
  const lines = [
    HEADER,
    'account.1.enable = 1',
    `account.1.label = ${oneLine(account.number)}`,
    `account.1.display_name = ${oneLine(account.displayName)}`,
    `account.1.auth_name = ${oneLine(account.username)}`,
    `account.1.user_name = ${oneLine(account.username)}`,
    `account.1.password = ${oneLine(account.password)}`,
    `account.1.sip_server.1.address = ${oneLine(account.server)}`,
    `account.1.sip_server.1.port = ${String(account.port)}`,
    `account.1.sip_server.1.transport_type = ${String(TRANSPORT_TYPE[account.transport])}`,
    'account.1.sip_server.1.expires = 3600',
    // Fetch again daily, so a password reset or a moved extension reaches the
    // phone without someone rebooting it. Yealink's default is boot only.
    'static.auto_provision.repeat.enable = 1',
    'static.auto_provision.repeat.minutes = 1440',
  ];
  return `${lines.join('\n')}\n`;
}

/** The model-wide file: valid, and changes nothing. */
export function renderYealinkCommonConfig(): string {
  return `${HEADER}\n`;
}

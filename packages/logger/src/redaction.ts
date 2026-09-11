/** What a fully masked value is replaced with. */
export const REDACTED = '[redacted]';

/**
 * Leaf property names whose value is always a secret (07 §5, 09 §4).
 *
 * Both camelCase and snake_case spellings are listed because values reach the
 * logger from HTTP bodies, DB rows, and SIP/FreeSWITCH payloads, which do not
 * agree on a convention.
 */
export const SECRET_KEYS: readonly string[] = [
  'password',
  'passwd',
  'newPassword',
  'new_password',
  'currentPassword',
  'current_password',
  'secret',
  'clientSecret',
  'client_secret',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'apiKey',
  'api_key',
  'apiSecret',
  'api_secret',
  'authorization',
  'cookie',
  'sipPassword',
  'sip_password',
  'sipSecret',
  'sip_secret',
  'ha1',
  'ha1b',
  'privateKey',
  'private_key',
  'mfaSecret',
  'mfa_secret',
  'totpSecret',
  'totp_secret',
  'pin',
  'conferencePin',
  'conference_pin',
  'credential',
  'credentials',
  'dataKey',
  'data_key',
  'kek',
  'signature',
];

/**
 * Leaf property names holding URLs that may carry a signature in the query
 * string (S3 presigned media, 09 §4). The path survives; the query does not.
 */
export const SIGNED_URL_KEYS: readonly string[] = [
  'mediaUrl',
  'media_url',
  'recordingUrl',
  'recording_url',
  'voicemailUrl',
  'voicemail_url',
  'greetingUrl',
  'greeting_url',
  'downloadUrl',
  'download_url',
  'signedUrl',
  'signed_url',
  'presignedUrl',
  'presigned_url',
];

/**
 * Headers stripped from serialized requests and responses.
 *
 * These are matched on the whole header bag rather than through
 * {@link SECRET_KEYS}, because header names are lowercased and hyphenated.
 */
export const SECRET_HEADERS: readonly string[] = [
  'authorization',
  'cookie',
  'set-cookie',
  'proxy-authorization',
  'x-api-key',
  'x-internal-token',
  'x-internal-signature',
];

/**
 * pino matches a redact path literally, and `*` spans exactly one level, so
 * each key is registered at the top level and two levels deep. That covers the
 * shapes we actually log (`{ user: { password } }`, `{ req: { body: { token } } }`)
 * without the cost of a recursive walk on every log call.
 */
function pathsForKey(key: string): string[] {
  const leaf = key.includes('-') ? `["${key}"]` : key;
  const nested = key.includes('-') ? `["${key}"]` : `.${key}`;
  return [leaf, `*${nested}`, `*.*${nested}`];
}

/** Every redact path the default logger installs. */
export function defaultRedactPaths(): string[] {
  const paths = new Set<string>();

  for (const key of [...SECRET_KEYS, ...SIGNED_URL_KEYS]) {
    for (const path of pathsForKey(key)) paths.add(path);
  }
  for (const header of SECRET_HEADERS) {
    paths.add(`req.headers["${header}"]`);
    paths.add(`res.headers["${header}"]`);
    paths.add(`headers["${header}"]`);
  }
  return [...paths];
}

const SIGNED_URL_KEY_SET = new Set<string>(SIGNED_URL_KEYS);

/**
 * Masks secrets outright, and reduces a signed media URL to its origin and
 * path so a log line still identifies the object without handing over a
 * working download link.
 */
export function censor(value: unknown, path: readonly string[]): unknown {
  const leaf = path[path.length - 1];

  if (leaf !== undefined && SIGNED_URL_KEY_SET.has(leaf) && typeof value === 'string') {
    return stripQuery(value);
  }
  return REDACTED;
}

function stripQuery(value: string): string {
  try {
    const url = new URL(value);
    return `${url.origin}${url.pathname}${url.search === '' ? '' : '?[redacted]'}`;
  } catch {
    // Not an absolute URL: fall back to masking rather than leaking a token
    // that happens to be stored under a *Url key.
    return REDACTED;
  }
}

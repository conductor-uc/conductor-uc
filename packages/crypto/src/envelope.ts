import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { DecryptionFailedError, MalformedCiphertextError } from './errors.js';
import type { KekProvider, WrappedKey } from './kek.js';

const DATA_ALGORITHM = 'aes-256-gcm';
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Format marker and version.
 *
 * Neutral on purpose: this string is stored in every `*_enc` column and could
 * surface in an export, and no codebase or operator name may appear on a
 * surface that leaves the platform (02 §5.2).
 */
const FORMAT = 'enc1';
const SEPARATOR = '.';

/**
 * Encrypts one value under a fresh data key, wrapping that key with the KEK
 * (07 §5).
 *
 * A data key per record means a compromised record's key is worth exactly one
 * record, and rotating the KEK rewraps keys without touching the ciphertext.
 *
 * `associatedData` binds the ciphertext to where it lives — pass something like
 * `${tenantId}:sip_credentials.secret_enc:${rowId}`. Decryption then fails if
 * the value is moved to another row or another tenant, which plain AES-GCM
 * would happily allow.
 */
export async function encrypt(
  kek: KekProvider,
  plaintext: Buffer | string,
  associatedData?: string,
): Promise<string> {
  const dataKey = randomBytes(DATA_KEY_BYTES);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(DATA_ALGORITHM, dataKey, iv);

  if (associatedData !== undefined) cipher.setAAD(Buffer.from(associatedData, 'utf8'));

  const input = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext, 'utf8');
  const sealed = Buffer.concat([cipher.update(input), cipher.final()]);
  const body = Buffer.concat([iv, cipher.getAuthTag(), sealed]);

  const wrappedKey = await kek.wrap(dataKey);
  // The data key is not needed again; drop it from memory promptly rather than
  // leaving it for the collector.
  dataKey.fill(0);

  return [
    FORMAT,
    encodeVersion(wrappedKey.keyVersion),
    toBase64Url(wrappedKey.wrapped),
    toBase64Url(body),
  ].join(SEPARATOR);
}

/** Decrypts a value produced by {@link encrypt}. */
export async function decrypt(
  kek: KekProvider,
  ciphertext: string,
  associatedData?: string,
): Promise<Buffer> {
  const parsed = parse(ciphertext);
  const dataKey = await kek.unwrap({
    wrapped: parsed.wrapped,
    keyVersion: parsed.keyVersion,
  });

  try {
    if (dataKey.length !== DATA_KEY_BYTES) throw new DecryptionFailedError();

    const iv = parsed.body.subarray(0, IV_BYTES);
    const tag = parsed.body.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const sealed = parsed.body.subarray(IV_BYTES + TAG_BYTES);

    const decipher = createDecipheriv(DATA_ALGORITHM, dataKey, iv);
    if (associatedData !== undefined) decipher.setAAD(Buffer.from(associatedData, 'utf8'));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(sealed), decipher.final()]);
    } catch {
      throw new DecryptionFailedError();
    }
  } finally {
    dataKey.fill(0);
  }
}

/** Decrypts to a UTF-8 string, for the many secrets that are text. */
export async function decryptString(
  kek: KekProvider,
  ciphertext: string,
  associatedData?: string,
): Promise<string> {
  return (await decrypt(kek, ciphertext, associatedData)).toString('utf8');
}

/** Which KEK version a stored value is under, without decrypting it. */
export function keyVersionOf(ciphertext: string): string {
  return parse(ciphertext).keyVersion;
}

/** True when the value would need rewrapping to reach the current KEK version. */
export function needsRotation(kek: KekProvider, ciphertext: string): boolean {
  return keyVersionOf(ciphertext) !== kek.currentVersion();
}

/**
 * Rewraps the data key under the current KEK version.
 *
 * The payload is neither decrypted nor re-encrypted: only the wrapped key
 * changes. Rotating a KEK across a large table therefore costs one KMS call per
 * row rather than a full read-modify-write of the data, and the ciphertext keeps
 * its original bytes so a mid-rotation crash leaves every row readable.
 *
 * Returns the value unchanged when it is already current.
 */
export async function rotate(kek: KekProvider, ciphertext: string): Promise<string> {
  const parsed = parse(ciphertext);
  if (parsed.keyVersion === kek.currentVersion()) return ciphertext;

  const dataKey = await kek.unwrap({ wrapped: parsed.wrapped, keyVersion: parsed.keyVersion });
  try {
    const rewrapped = await kek.wrap(dataKey);
    return [
      FORMAT,
      encodeVersion(rewrapped.keyVersion),
      toBase64Url(rewrapped.wrapped),
      toBase64Url(parsed.body),
    ].join(SEPARATOR);
  } finally {
    dataKey.fill(0);
  }
}

/** True when `value` looks like this package's format. */
export function isCiphertext(value: string): boolean {
  try {
    parse(value);
    return true;
  } catch {
    return false;
  }
}

interface ParsedCiphertext extends WrappedKey {
  readonly body: Buffer;
}

function parse(ciphertext: string): ParsedCiphertext {
  const parts = ciphertext.split(SEPARATOR);
  if (parts.length !== 4) {
    throw new MalformedCiphertextError(`expected 4 parts, found ${String(parts.length)}`);
  }

  const [format, version, wrapped, body] = parts as [string, string, string, string];
  if (format !== FORMAT) {
    throw new MalformedCiphertextError(`unknown format '${format}', expected '${FORMAT}'`);
  }

  const keyVersion = decodeVersion(version);
  if (keyVersion === '') throw new MalformedCiphertextError('the key version is empty');

  const wrappedBytes = fromBase64Url(wrapped, 'the wrapped key');
  const bodyBytes = fromBase64Url(body, 'the ciphertext body');

  if (bodyBytes.length < IV_BYTES + TAG_BYTES) {
    throw new MalformedCiphertextError('the ciphertext body is too short to hold an IV and tag');
  }

  return { keyVersion, wrapped: wrappedBytes, body: bodyBytes };
}

/**
 * Key versions are base64url-encoded rather than embedded raw, so a version
 * containing a `.` cannot split the ciphertext into the wrong fields.
 */
function encodeVersion(version: string): string {
  return toBase64Url(Buffer.from(version, 'utf8'));
}

function decodeVersion(encoded: string): string {
  return fromBase64Url(encoded, 'the key version').toString('utf8');
}

function toBase64Url(value: Buffer): string {
  return value.toString('base64url');
}

function fromBase64Url(value: string, what: string): Buffer {
  if (value === '' || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new MalformedCiphertextError(`${what} is not base64url`);
  }
  return Buffer.from(value, 'base64url');
}

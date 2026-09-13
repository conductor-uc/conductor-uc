/** Base for everything this package throws, so callers can catch one type. */
export class CryptoError extends Error {}

/** The ciphertext is not in this package's format, or has been truncated. */
export class MalformedCiphertextError extends CryptoError {
  override readonly name = 'MalformedCiphertextError';

  constructor(reason: string) {
    super(`Malformed ciphertext: ${reason}.`);
  }
}

/**
 * Authentication failed.
 *
 * The message is deliberately vague about which part failed. A caller cannot
 * act differently on "wrong key" than on "tampered payload", and distinguishing
 * them out loud tells an attacker which half of the envelope to keep working on.
 */
export class DecryptionFailedError extends CryptoError {
  override readonly name = 'DecryptionFailedError';

  constructor() {
    super(
      'Could not decrypt: the key version, the associated data, or the ciphertext ' +
        'itself does not match.',
    );
  }
}

/** The ciphertext names a key version this provider does not hold. */
export class UnknownKeyVersionError extends CryptoError {
  override readonly name = 'UnknownKeyVersionError';
  readonly keyVersion: string;

  constructor(keyVersion: string, known: readonly string[]) {
    super(
      `No key for version '${keyVersion}'. This provider holds: ${known.join(', ') || '(none)'}. ` +
        'A retired key must stay available until every record encrypted under it has been rotated.',
    );
    this.keyVersion = keyVersion;
  }
}

/** The key material is the wrong size or shape. */
export class InvalidKeyError extends CryptoError {
  override readonly name = 'InvalidKeyError';

  constructor(reason: string) {
    super(`Invalid key: ${reason}.`);
  }
}

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

import { DecryptionFailedError, InvalidKeyError, UnknownKeyVersionError } from './errors.js';

/** Key-encryption keys are AES-256. */
export const KEK_BYTES = 32;

const WRAP_ALGORITHM = 'aes-256-gcm';
const WRAP_IV_BYTES = 12;
const WRAP_TAG_BYTES = 16;

/** A data key wrapped by a KEK, tagged with the version that wrapped it. */
export interface WrappedKey {
  /** Opaque bytes: the KEK's own ciphertext over the data key. */
  readonly wrapped: Buffer;
  /** Which KEK version wrapped it, so rotation can find what needs rewrapping. */
  readonly keyVersion: string;
}

/**
 * Wraps and unwraps data keys (07 §5).
 *
 * The KEK itself never leaves the provider: a Vault Transit or cloud-KMS
 * implementation wraps remotely and never has the key material locally at all,
 * which is the whole point of the indirection.
 */
export interface KekProvider {
  /** The version new records are wrapped under. */
  currentVersion(): string;
  /** Every version this provider can still unwrap, newest first. */
  versions(): readonly string[];
  wrap(dataKey: Buffer): Promise<WrappedKey>;
  unwrap(key: WrappedKey): Promise<Buffer>;
}

export interface FileKekProviderOptions {
  /** Version to key material. Retired versions stay here until nothing uses them. */
  readonly keys: Readonly<Record<string, Buffer>>;
  /** The version used for new records. Must be present in `keys`. */
  readonly currentVersion: string;
}

/**
 * A KEK provider backed by key material held in the process.
 *
 * **Local development only** (07 §5). A real deployment uses a KMS, so the key
 * lives somewhere the application cannot read, an operator can rotate it without
 * a deploy, and its use is logged outside the service. This implementation has
 * none of those properties.
 */
export class FileKekProvider implements KekProvider {
  readonly #keys: Map<string, Buffer>;
  readonly #current: string;

  constructor(options: FileKekProviderOptions) {
    const entries = Object.entries(options.keys);
    if (entries.length === 0) throw new InvalidKeyError('at least one key is required');

    for (const [version, key] of entries) {
      if (version === '') throw new InvalidKeyError('a key version cannot be empty');
      if (key.length !== KEK_BYTES) {
        throw new InvalidKeyError(
          `key '${version}' is ${String(key.length)} bytes; AES-256 needs ${String(KEK_BYTES)}`,
        );
      }
    }
    if (!Object.hasOwn(options.keys, options.currentVersion)) {
      throw new InvalidKeyError(
        `currentVersion '${options.currentVersion}' is not among the supplied keys ` +
          `(${entries.map(([version]) => version).join(', ')})`,
      );
    }

    this.#keys = new Map(entries);
    this.#current = options.currentVersion;
  }

  currentVersion(): string {
    return this.#current;
  }

  versions(): readonly string[] {
    return [...this.#keys.keys()];
  }

  wrap(dataKey: Buffer): Promise<WrappedKey> {
    return settle(() => this.#wrapSync(dataKey));
  }

  unwrap(wrappedKey: WrappedKey): Promise<Buffer> {
    return settle(() => this.#unwrapSync(wrappedKey));
  }

  #wrapSync(dataKey: Buffer): WrappedKey {
    const key = this.#keyFor(this.#current);
    const iv = randomBytes(WRAP_IV_BYTES);
    const cipher = createCipheriv(WRAP_ALGORITHM, key, iv);

    // The version is authenticated, so a wrapped key cannot be relabelled as
    // having come from a different KEK.
    cipher.setAAD(Buffer.from(this.#current, 'utf8'));

    const sealed = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return {
      wrapped: Buffer.concat([iv, cipher.getAuthTag(), sealed]),
      keyVersion: this.#current,
    };
  }

  #unwrapSync(wrappedKey: WrappedKey): Buffer {
    const key = this.#keyFor(wrappedKey.keyVersion);
    const { wrapped } = wrappedKey;

    if (wrapped.length <= WRAP_IV_BYTES + WRAP_TAG_BYTES) {
      throw new DecryptionFailedError();
    }

    const iv = wrapped.subarray(0, WRAP_IV_BYTES);
    const tag = wrapped.subarray(WRAP_IV_BYTES, WRAP_IV_BYTES + WRAP_TAG_BYTES);
    const sealed = wrapped.subarray(WRAP_IV_BYTES + WRAP_TAG_BYTES);

    const decipher = createDecipheriv(WRAP_ALGORITHM, key, iv);
    decipher.setAAD(Buffer.from(wrappedKey.keyVersion, 'utf8'));
    decipher.setAuthTag(tag);

    try {
      return Buffer.concat([decipher.update(sealed), decipher.final()]);
    } catch {
      throw new DecryptionFailedError();
    }
  }

  #keyFor(version: string): Buffer {
    const key = this.#keys.get(version);
    if (key === undefined) throw new UnknownKeyVersionError(version, this.versions());
    return key;
  }
}

/**
 * Vault Transit, where the KEK never reaches this process.
 *
 * Not implemented: choosing between Vault and a cloud KMS is a deployment
 * decision that has not been made, and a half-built client that silently falls
 * back to local keys would be worse than an honest gap. It throws rather than
 * pretending, and `@cuc/crypto`'s interface is what keeps the swap small.
 */
export class VaultTransitKekProvider implements KekProvider {
  constructor(_options: {
    readonly address: string;
    readonly keyName: string;
    readonly token: string;
  }) {
    throw new Error(
      'VaultTransitKekProvider is not implemented yet. Local development uses ' +
        'FileKekProvider; the production KMS is chosen before the first real tenant ' +
        '(07 §5). Implement wrap/unwrap against Transit here — the rest of the ' +
        'package needs no changes.',
    );
  }

  currentVersion(): string {
    throw new Error('not implemented');
  }

  versions(): readonly string[] {
    throw new Error('not implemented');
  }

  wrap(_dataKey: Buffer): Promise<WrappedKey> {
    throw new Error('not implemented');
  }

  unwrap(_key: WrappedKey): Promise<Buffer> {
    throw new Error('not implemented');
  }
}

/**
 * Runs a synchronous computation as a promise.
 *
 * The `KekProvider` interface is asynchronous because a real KMS is a network
 * call. A provider that computes locally must still *reject* rather than throw
 * synchronously, or a caller using `.catch()` would miss the failure entirely.
 */
function settle<T>(compute: () => T): Promise<T> {
  try {
    return Promise.resolve(compute());
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
}

/** Constant-time comparison, for callers checking a decrypted secret. */
export function secretEquals(a: Buffer | string, b: Buffer | string): boolean {
  const left = Buffer.isBuffer(a) ? a : Buffer.from(a, 'utf8');
  const right = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

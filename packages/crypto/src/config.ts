import { Env, Type } from '@cuc/config';

import { FileKekProvider, KEK_BYTES } from './kek.js';
import { InvalidKeyError } from './errors.js';

/**
 * Configuration for the development KEK provider.
 *
 * `CRYPTO_KEKS` is `version:base64key` pairs, oldest kept for as long as any
 * record is still wrapped under it:
 *
 * ```
 * CRYPTO_KEKS=1:Ci4u…=,2:9kPq…=
 * CRYPTO_KEK_CURRENT=2
 * ```
 */
export const cryptoEnvSchema = Type.Object({
  CRYPTO_KEKS: Env.secret({
    description:
      'Comma-separated version:base64-key pairs. Development only; production uses a KMS.',
  }),
  CRYPTO_KEK_CURRENT: Env.string({
    description: 'The version new records are wrapped under.',
  }),
});

/** Builds a {@link FileKekProvider} from the environment values. */
export function fileKekFromConfig(config: {
  readonly CRYPTO_KEKS: string;
  readonly CRYPTO_KEK_CURRENT: string;
}): FileKekProvider {
  const keys: Record<string, Buffer> = {};

  for (const entry of config.CRYPTO_KEKS.split(',')) {
    const trimmed = entry.trim();
    if (trimmed === '') continue;

    const separator = trimmed.indexOf(':');
    if (separator === -1) {
      throw new InvalidKeyError(`'${redact(trimmed)}' is not in version:base64key form`);
    }

    const version = trimmed.slice(0, separator).trim();
    const material = Buffer.from(trimmed.slice(separator + 1).trim(), 'base64');

    if (material.length !== KEK_BYTES) {
      // The value is never echoed: CRYPTO_KEKS holds key material.
      throw new InvalidKeyError(
        `key '${version}' decodes to ${String(material.length)} bytes; AES-256 needs ${String(KEK_BYTES)}`,
      );
    }
    keys[version] = material;
  }

  return new FileKekProvider({ keys, currentVersion: config.CRYPTO_KEK_CURRENT });
}

/** Never let key material reach an error message. */
function redact(entry: string): string {
  const separator = entry.indexOf(':');
  return separator === -1 ? '[redacted]' : `${entry.slice(0, separator)}:[redacted]`;
}

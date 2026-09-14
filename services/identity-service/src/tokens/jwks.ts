import { exportJWK } from 'jose';

import type { VerificationKey } from '../repo/signing-key.repo.js';

export interface JwksDocument {
  readonly keys: readonly Record<string, unknown>[];
}

/**
 * Builds the JWKS document from every key still valid for verification
 * (07 §2). Public keys only — nothing here ever touches a private key.
 */
export async function buildJwks(keys: readonly VerificationKey[]): Promise<JwksDocument> {
  return {
    keys: await Promise.all(
      keys.map(async (key) => ({
        ...(await exportJWK(key.publicKey)),
        kid: key.id,
        use: 'sig',
        alg: 'EdDSA',
      })),
    ),
  };
}

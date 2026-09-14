import type { Database, Kysely } from '@cuc/db';
import { decryptString, encrypt, type KekProvider } from '@cuc/crypto';
import {
  calculateJwkThumbprint,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  importJWK,
  importPKCS8,
  type CryptoKey,
} from 'jose';

import type { IdentityServiceDb, SigningKeyAlgorithm } from '../schema.js';

const ALGORITHM: SigningKeyAlgorithm = 'EdDSA';
const CURVE = 'Ed25519';

export interface SigningKey {
  readonly id: string;
  readonly publicKey: CryptoKey;
  readonly privateKey: CryptoKey;
  readonly retiredAt: Date | null;
}

/** Only the public half — what `forVerification` returns to the JWKS route. */
export interface VerificationKey {
  readonly id: string;
  readonly publicKey: CryptoKey;
}

export class NoSigningKeyError extends Error {
  override readonly name = 'NoSigningKeyError';

  constructor() {
    super('No current signing key. Call ensureCurrentKey() at startup before issuing tokens.');
  }
}

/**
 * Data access for EdDSA signing keys (07 §2).
 *
 * The private key is envelope-encrypted at rest (07 §5) and only ever
 * decrypted to sign — it never leaves this module as raw key material for
 * anything but that.
 */
export function createSigningKeyRepo(db: Database<IdentityServiceDb>, kek: KekProvider) {
  const keys = db.kysely;

  function associatedData(keyId: string): string {
    return `signing_keys.private_key_enc:${keyId}`;
  }

  async function toSigningKey(row: {
    id: string;
    public_key: Buffer;
    private_key_enc: string;
    retired_at: Date | null;
  }): Promise<SigningKey> {
    const publicKey = await importJWK(
      { kty: 'OKP', crv: CURVE, x: row.public_key.toString('base64url') },
      ALGORITHM,
    );
    const pkcs8 = await decryptString(kek, row.private_key_enc, associatedData(row.id));
    const privateKey = await importPKCS8(pkcs8, ALGORITHM);
    return { id: row.id, publicKey, privateKey, retiredAt: row.retired_at };
  }

  /**
   * `executor` is whatever connection the caller is already inside — `keys`
   * for a standalone bootstrap, or the open `trx` from `rotate()`, so the
   * retire-then-insert pair in `rotate()` is one atomic write and not two.
   */
  async function generateAndStore(executor: Kysely<IdentityServiceDb>): Promise<SigningKey> {
    const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, {
      crv: CURVE,
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    const id = await calculateJwkThumbprint(jwk);
    const publicBytes = Buffer.from(jwk.x!, 'base64url');
    const pkcs8 = await exportPKCS8(privateKey);
    const now = new Date();

    const privateKeyEnc = await encrypt(kek, pkcs8, associatedData(id));

    await executor
      .insertInto('signing_keys')
      .values({
        id,
        algorithm: ALGORITHM,
        public_key: publicBytes,
        private_key_enc: privateKeyEnc,
        created_at: now,
        retired_at: null,
      })
      .execute();

    return { id, publicKey, privateKey, retiredAt: null };
  }

  return {
    /**
     * Idempotent: generates the first key if none exists, otherwise returns
     * the current one. Call this once at startup, before serving any request
     * that signs or verifies a token.
     */
    async ensureCurrentKey(): Promise<SigningKey> {
      const row = await keys
        .selectFrom('signing_keys')
        .selectAll()
        .where('retired_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();

      if (row !== undefined) return toSigningKey(row);
      return generateAndStore(keys);
    },

    async current(): Promise<SigningKey> {
      const row = await keys
        .selectFrom('signing_keys')
        .selectAll()
        .where('retired_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (row === undefined) throw new NoSigningKeyError();
      return toSigningKey(row);
    },

    /**
     * Every key still valid for verification: the current one, plus any
     * retired within the overlap window (07 §2). A token signed moments
     * before a rotation must still verify after it.
     */
    async forVerification(overlapDays: number): Promise<VerificationKey[]> {
      const cutoff = new Date(Date.now() - overlapDays * 24 * 60 * 60 * 1000);
      const rows = await keys
        .selectFrom('signing_keys')
        .select(['id', 'public_key'])
        .where((eb) => eb.or([eb('retired_at', 'is', null), eb('retired_at', '>', cutoff)]))
        .execute();

      return Promise.all(
        rows.map(async (row) => ({
          id: row.id,
          publicKey: await importJWK(
            { kty: 'OKP', crv: CURVE, x: row.public_key.toString('base64url') },
            ALGORITHM,
          ),
        })),
      );
    },

    /**
     * Generates a new key and retires whichever key was current. The retired
     * key keeps verifying — see `forVerification` — it just stops signing.
     */
    async rotate(): Promise<SigningKey> {
      return db.kysely.transaction().execute(async (trx) => {
        await trx
          .updateTable('signing_keys')
          .set({ retired_at: new Date() })
          .where('retired_at', 'is', null)
          .execute();
        // Same transaction as the retirement above: a crash between the two
        // must not leave zero current keys.
        return generateAndStore(trx);
      });
    },
  };
}

export type SigningKeyRepo = ReturnType<typeof createSigningKeyRepo>;

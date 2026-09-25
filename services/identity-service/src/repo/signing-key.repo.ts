import type { Database, Kysely, Transaction } from '@cuc/db';
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
const DAY_MS = 24 * 60 * 60 * 1000;

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

/** What one rotation did. */
export interface RotationResult {
  /** The key that was current until now; null only on a database that had none. */
  readonly previousKeyId: string | null;
  /** When the previous key was created, for the log line. */
  readonly previousCreatedAt: Date | null;
  readonly current: SigningKey;
  /** Retired keys removed from the JWKS at once (`revokePrevious`); 0 otherwise. */
  readonly revoked: number;
}

export interface RotateOptions {
  /**
   * Also revoke every retired key, the one this rotation retires included, so
   * none of them is published for verification any more. For a suspected
   * leak: every access token signed before this moment stops verifying.
   */
  readonly revokePrevious?: boolean;
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

  /**
   * The decoded current key, by id. `current()` still reads which key is
   * current from the database on every call (one query on a table of a
   * handful of rows), so a rotation made by another copy of the service is
   * picked up by the very next token this copy signs; only the KEK unwrap and
   * key import are skipped while the id is unchanged.
   */
  let decoded: SigningKey | undefined;

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

  /**
   * Locks the current key's row for the rest of `trx`. A second rotation
   * attempt — another copy of the service, or the operator command — waits
   * here until this one commits, and then no longer finds this row current
   * (its `retired_at` is set), so it cannot retire or age-check the same key
   * twice.
   */
  function lockCurrent(trx: Transaction<IdentityServiceDb>) {
    return trx
      .selectFrom('signing_keys')
      .select(['id', 'created_at'])
      .where('retired_at', 'is', null)
      .orderBy('created_at', 'desc')
      .forUpdate()
      .executeTakeFirst();
  }

  /** Retires whatever is current, adds a new key, and optionally revokes the retired ones. */
  async function replaceCurrent(
    trx: Transaction<IdentityServiceDb>,
    previous: { id: string; created_at: Date } | undefined,
    options: RotateOptions,
  ): Promise<RotationResult> {
    const now = new Date();
    // Every row still marked current, not just `previous`: a stray second one
    // (there should never be one) would otherwise stay current forever.
    await trx
      .updateTable('signing_keys')
      .set({ retired_at: now })
      .where('retired_at', 'is', null)
      .execute();
    // Same transaction as the retirement above: a crash between the two
    // must not leave zero current keys.
    const current = await generateAndStore(trx);

    let revoked = 0;
    if (options.revokePrevious === true) {
      const result = await trx
        .updateTable('signing_keys')
        .set({ revoked_at: now })
        .where('retired_at', 'is not', null)
        .where('revoked_at', 'is', null)
        .executeTakeFirst();
      revoked = Number(result.numUpdatedRows);
    }

    return {
      previousKeyId: previous?.id ?? null,
      previousCreatedAt: previous?.created_at ?? null,
      current,
      revoked,
    };
  }

  /**
   * Generates a new key and retires whichever key was current. The retired
   * key keeps verifying — see `forVerification` — it just stops signing,
   * unless `revokePrevious` removes it (and every older one) at once.
   */
  async function rotateNow(options: RotateOptions = {}): Promise<RotationResult> {
    return db.kysely.transaction().execute(async (trx) => {
      const previous = await lockCurrent(trx);
      return replaceCurrent(trx, previous, options);
    });
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

    /**
     * The key to sign with now. Read from the database on every call, so
     * every copy of the service switches to a new key as soon as any copy (or
     * the operator command) rotates; see `decoded` for what is cached.
     */
    async current(): Promise<SigningKey> {
      const row = await keys
        .selectFrom('signing_keys')
        .selectAll()
        .where('retired_at', 'is', null)
        .orderBy('created_at', 'desc')
        .executeTakeFirst();
      if (row === undefined) throw new NoSigningKeyError();
      if (decoded?.id === row.id) return decoded;
      decoded = await toSigningKey(row);
      return decoded;
    },

    /**
     * Every key still valid for verification: the current one, plus any
     * retired within the overlap window (07 §2) and not revoked. A token
     * signed moments before a rotation must still verify after it.
     */
    async forVerification(overlapDays: number): Promise<VerificationKey[]> {
      const cutoff = new Date(Date.now() - overlapDays * DAY_MS);
      const rows = await keys
        .selectFrom('signing_keys')
        .select(['id', 'public_key'])
        .where((eb) => eb.or([eb('retired_at', 'is', null), eb('retired_at', '>', cutoff)]))
        .where('revoked_at', 'is', null)
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

    rotateNow,

    /** {@link rotateNow}, returning only the new key. */
    async rotate(options: RotateOptions = {}): Promise<SigningKey> {
      return (await rotateNow(options)).current;
    },

    /**
     * Rotates only when the current key is at least `maxAgeDays` old (G-116),
     * for the automatic timer. The age is checked inside the rotation's own
     * transaction, on the locked row, so any number of copies of the service
     * checking at the same moment rotate once between them: the others wait
     * for the lock, then find the new key, which is young.
     *
     * Returns null when nothing was due, or when there is no current key at
     * all (`ensureCurrentKey` creates the first one, not this).
     */
    async rotateIfOlderThan(maxAgeDays: number, now = new Date()): Promise<RotationResult | null> {
      return db.kysely.transaction().execute(async (trx) => {
        const previous = await lockCurrent(trx);
        if (previous === undefined) return null;
        if (now.getTime() - previous.created_at.getTime() < maxAgeDays * DAY_MS) return null;
        return replaceCurrent(trx, previous, {});
      });
    },
  };
}

export type SigningKeyRepo = ReturnType<typeof createSigningKeyRepo>;

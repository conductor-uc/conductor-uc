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
const MINUTE_MS = 60 * 1000;

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

/** A key published ahead of use: in the JWKS, not yet signing. */
export interface NextKey {
  readonly id: string;
  /** When it was created, and so first published. */
  readonly publishedAt: Date;
}

/** What one immediate rotation (`rotateNow`) did. */
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

/**
 * What one step of a two-phase rotation did (G-116, publish-ahead):
 *
 * - `staged`: a next key was created and published; the current key still signs.
 * - `waiting`: a next key is published but has not been for long enough yet.
 * - `promoted`: the next key became current; the previous one is retired and
 *   stays published for the overlap window.
 * - `none`: nothing was due.
 */
export type RotationStep =
  | { readonly action: 'none' }
  | { readonly action: 'staged'; readonly currentKeyId: string; readonly next: NextKey }
  | { readonly action: 'waiting'; readonly next: NextKey }
  | {
      readonly action: 'promoted';
      readonly previousKeyId: string;
      readonly previousCreatedAt: Date;
      readonly currentKeyId: string;
    };

export interface AdvanceOptions {
  /**
   * When to stage a next key, if none exists: once the current key is this
   * many days old (the timer, `SIGNING_KEY_ROTATION_DAYS`), `'now'` (the
   * operator command), or `'never'` (automatic rotation off; staged keys are
   * still promoted).
   */
  readonly stage: number | 'now' | 'never';
  /** A next key must have been published this long before it is promoted. */
  readonly publishAheadMinutes: number;
  /** Injected so tests drive time. */
  readonly now?: Date;
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
 * A key is, in order: *next* (published in the JWKS, `activated_at` null),
 * *current* (signing, `activated_at` set), *retired* (`retired_at` set; still
 * published for the overlap window), and optionally *revoked* (gone from the
 * JWKS at once). Publishing a key before it signs anything means a verifier
 * that caches the JWKS (api-gateway, for `JWKS_CACHE_MAX_AGE_MS`) already
 * holds it when the first token it signed arrives.
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
   * for a standalone bootstrap, or the open transaction of a rotation, so the
   * retire-then-insert pair is one atomic write and not two. `activatedAt`
   * null creates a *next* key: published from `createdAt`, not signing.
   */
  async function generateAndStore(
    executor: Kysely<IdentityServiceDb>,
    createdAt: Date,
    activatedAt: Date | null,
  ): Promise<SigningKey> {
    const { publicKey, privateKey } = await generateKeyPair(ALGORITHM, {
      crv: CURVE,
      extractable: true,
    });
    const jwk = await exportJWK(publicKey);
    const id = await calculateJwkThumbprint(jwk);
    const publicBytes = Buffer.from(jwk.x!, 'base64url');
    const pkcs8 = await exportPKCS8(privateKey);

    const privateKeyEnc = await encrypt(kek, pkcs8, associatedData(id));

    await executor
      .insertInto('signing_keys')
      .values({
        id,
        algorithm: ALGORITHM,
        public_key: publicBytes,
        private_key_enc: privateKeyEnc,
        created_at: createdAt,
        activated_at: activatedAt,
        retired_at: null,
      })
      .execute();

    return { id, publicKey, privateKey, retiredAt: null };
  }

  /**
   * The id of the key signing now, read without a lock, before a rotation
   * step's transaction starts; {@link lockCurrent} then locks exactly that row.
   */
  async function currentKeyId(): Promise<string | undefined> {
    const row = await keys
      .selectFrom('signing_keys')
      .select('id')
      .where('retired_at', 'is', null)
      .where('activated_at', 'is not', null)
      .orderBy('activated_at', 'desc')
      .executeTakeFirst();
    return row?.id;
  }

  /**
   * Locks the current key's row, by primary key, for the rest of `trx`, and
   * returns it only if it is still the current key. Every rotation step
   * (staging, promotion, an immediate rotation) starts here, so they are
   * serialised across every copy of the service: a second attempt waits until
   * the first commits, then finds either that its key is no longer current
   * (the first one promoted) or, through a new locking read, the next key the
   * first one staged. So each step happens once, however many copies try.
   *
   * A primary-key lookup locks the one row and no gaps. A waiting copy holds
   * no other lock, so the holder's insert of a new key cannot deadlock with
   * it, which a range scan `FOR UPDATE` here would (both taking gap locks).
   */
  async function lockCurrent(trx: Transaction<IdentityServiceDb>, id: string) {
    const row = await trx
      .selectFrom('signing_keys')
      .select(['id', 'created_at', 'activated_at', 'retired_at'])
      .where('id', '=', id)
      .forUpdate()
      .executeTakeFirst();
    if (row === undefined || row.retired_at !== null || row.activated_at === null) return undefined;
    return row;
  }

  /** The next key, if one is staged. Locking, so it sees another copy's committed staging. */
  function lockNext(trx: Transaction<IdentityServiceDb>) {
    return trx
      .selectFrom('signing_keys')
      .select(['id', 'created_at'])
      .where('retired_at', 'is', null)
      .where('activated_at', 'is', null)
      .orderBy('created_at', 'asc')
      .forUpdate()
      .executeTakeFirst();
  }

  /** Retires every signing key; the next key, if any, is left for the caller. */
  async function retireActive(trx: Transaction<IdentityServiceDb>, now: Date): Promise<void> {
    await trx
      .updateTable('signing_keys')
      .set({ retired_at: now })
      .where('retired_at', 'is', null)
      .where('activated_at', 'is not', null)
      .execute();
  }

  /**
   * Generates a key that signs from now, retiring whatever was current and any
   * staged next key (which never signed anything). The retired keys keep
   * verifying — see `forVerification` — unless `revokePrevious` removes them
   * and every older one at once.
   *
   * A verifier that cached the JWKS before this moment does not know the new
   * key yet: api-gateway refetches on an unknown key id, but at most once per
   * `JWKS_COOLDOWN_MS`, so a request can be refused in that window. Routine
   * rotation uses {@link advance} instead, which publishes the key first.
   */
  async function rotateNow(options: RotateOptions = {}): Promise<RotationResult> {
    // Another copy may promote between reading the current id and locking it;
    // then the lock finds that key retired, and this reads the new one.
    for (let attempt = 1; ; attempt += 1) {
      const result = await rotateNowOnce(options);
      if (result !== undefined) return result;
      if (attempt >= 5) throw new Error('The current signing key kept changing; try again.');
    }
  }

  async function rotateNowOnce(options: RotateOptions): Promise<RotationResult | undefined> {
    const id = await currentKeyId();
    return db.kysely.transaction().execute(async (trx) => {
      const previous = id === undefined ? undefined : await lockCurrent(trx, id);
      if (id !== undefined && previous === undefined) return undefined;
      await lockNext(trx);
      const now = new Date();
      // Every live row, the next key included: a stray second current row
      // (there should never be one) would otherwise stay current forever.
      await trx
        .updateTable('signing_keys')
        .set({ retired_at: now })
        .where('retired_at', 'is', null)
        .execute();
      // Same transaction as the retirement above: a crash between the two
      // must not leave zero current keys.
      const current = await generateAndStore(trx, now, now);

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
        .where('activated_at', 'is not', null)
        .orderBy('activated_at', 'desc')
        .executeTakeFirst();

      if (row !== undefined) return toSigningKey(row);
      const now = new Date();
      return generateAndStore(keys, now, now);
    },

    /**
     * The key to sign with now. Read from the database on every call, so
     * every copy of the service switches the moment any copy (or the operator
     * command) promotes a key; a staged next key is never returned here.
     */
    async current(): Promise<SigningKey> {
      const row = await keys
        .selectFrom('signing_keys')
        .selectAll()
        .where('retired_at', 'is', null)
        .where('activated_at', 'is not', null)
        .orderBy('activated_at', 'desc')
        .executeTakeFirst();
      if (row === undefined) throw new NoSigningKeyError();
      if (decoded?.id === row.id) return decoded;
      decoded = await toSigningKey(row);
      return decoded;
    },

    /** The staged next key, if there is one. */
    async next(): Promise<NextKey | undefined> {
      const row = await keys
        .selectFrom('signing_keys')
        .select(['id', 'created_at'])
        .where('retired_at', 'is', null)
        .where('activated_at', 'is', null)
        .orderBy('created_at', 'asc')
        .executeTakeFirst();
      return row === undefined ? undefined : { id: row.id, publishedAt: row.created_at };
    },

    /**
     * Every key valid for verification: the current one, a staged next key
     * (published ahead so verifiers have it before it signs), and any retired
     * within the overlap window (07 §2) and not revoked. A token signed moments
     * before a rotation must still verify after it.
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

    /**
     * One step of a publish-ahead rotation (G-116), for the automatic timer and
     * the operator command:
     *
     * - A next key published at least `publishAheadMinutes` ago is promoted:
     *   it becomes current, and the current key is retired.
     * - A next key published more recently is left alone (`waiting`).
     * - With no next key, one is staged if `stage` says so.
     *
     * One step per call: a key staged here is promoted by a later call. The
     * checks run on locked rows inside one transaction, so any number of
     * copies calling at once stage, or promote, exactly once between them.
     */
    async advance(options: AdvanceOptions): Promise<RotationStep> {
      const now = options.now ?? new Date();
      const id = await currentKeyId();
      // No current key: `ensureCurrentKey` creates the first one, not this.
      if (id === undefined) return { action: 'none' };
      return db.kysely.transaction().execute(async (trx): Promise<RotationStep> => {
        const current = await lockCurrent(trx, id);
        // Another copy promoted a key since `id` was read: this step is done.
        if (current === undefined) return { action: 'none' };

        const next = await lockNext(trx);
        if (next !== undefined) {
          const published = { id: next.id, publishedAt: next.created_at };
          if (now.getTime() - next.created_at.getTime() < options.publishAheadMinutes * MINUTE_MS) {
            return { action: 'waiting', next: published };
          }
          await retireActive(trx, now);
          await trx
            .updateTable('signing_keys')
            .set({ activated_at: now })
            .where('id', '=', next.id)
            .execute();
          return {
            action: 'promoted',
            previousKeyId: current.id,
            previousCreatedAt: current.created_at,
            currentKeyId: next.id,
          };
        }

        const { stage } = options;
        if (stage === 'never') return { action: 'none' };
        // Age counts from when the key started signing, not from when it was published.
        const signingSince = current.activated_at ?? current.created_at;
        if (stage !== 'now' && now.getTime() - signingSince.getTime() < stage * DAY_MS) {
          return { action: 'none' };
        }
        const staged = await generateAndStore(trx, now, null);
        return {
          action: 'staged',
          currentKeyId: current.id,
          next: { id: staged.id, publishedAt: now },
        };
      });
    },

    rotateNow,

    /** {@link rotateNow}, returning only the new key. */
    async rotate(options: RotateOptions = {}): Promise<SigningKey> {
      return (await rotateNow(options)).current;
    },
  };
}

export type SigningKeyRepo = ReturnType<typeof createSigningKeyRepo>;

import type { Database } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { decryptString, encrypt, type KekProvider } from '@cuc/crypto';

import type { OrgServiceDb } from '../schema.js';

export interface AcmeAccount {
  readonly directoryUrl: string;
  readonly keyPem: string;
  /** Null until the first certificate has been issued under it. */
  readonly accountUrl: string | null;
}

const associatedData = (directoryUrl: string): string =>
  `acme_accounts.account_key_enc:${directoryUrl}`;

/**
 * The ACME account key per directory, envelope-encrypted like every other key
 * here. One account per directory: registering a new one for every certificate
 * would run into the CA's rate limits and lose the address expiry notices go to.
 */
export function createAcmeAccountRepo(db: Database<OrgServiceDb>, kek: KekProvider) {
  const kysely = db.kysely;

  async function get(directoryUrl: string): Promise<AcmeAccount | undefined> {
    const row = await kysely
      .selectFrom('acme_accounts')
      .selectAll()
      .where('directory_url', '=', directoryUrl)
      .executeTakeFirst();
    if (row === undefined) return undefined;
    return {
      directoryUrl,
      keyPem: await decryptString(kek, row.account_key_enc, associatedData(directoryUrl)),
      accountUrl: row.account_url,
    };
  }

  return {
    get,

    /**
     * Keeps a new account key for [directoryUrl] and returns the account: the one
     * just stored, or, when another instance stored one first, that one, so two
     * workers starting together end up sharing a single account.
     */
    async create(
      directoryUrl: string,
      keyPem: string,
      now: Date = new Date(),
    ): Promise<AcmeAccount> {
      try {
        await kysely
          .insertInto('acme_accounts')
          .values({
            directory_url: directoryUrl,
            account_key_enc: await encrypt(kek, keyPem, associatedData(directoryUrl)),
            account_url: null,
            created_at: now,
          })
          .execute();
      } catch (error) {
        if (!isDuplicateKeyError(error)) throw error;
      }
      const stored = await get(directoryUrl);
      if (stored === undefined) throw new Error('The ACME account could not be stored.');
      return stored;
    },

    async setAccountUrl(directoryUrl: string, accountUrl: string): Promise<void> {
      await kysely
        .updateTable('acme_accounts')
        .set({ account_url: accountUrl })
        .where('directory_url', '=', directoryUrl)
        .execute();
    },
  };
}

export type AcmeAccountRepo = ReturnType<typeof createAcmeAccountRepo>;

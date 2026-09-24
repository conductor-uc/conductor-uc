import type { Database } from '@cuc/db';

import { validatePublicAddress } from '../domain/dns.js';
import type { OrgServiceDb } from '../schema.js';

const ROW_ID = 1;

/** Where the platform is reached from the internet: one row, edited in the console. */
export function createPlatformNetworkRepo(db: Database<OrgServiceDb>) {
  const kysely = db.kysely;
  return {
    async publicAddress(): Promise<string | null> {
      const row = await kysely
        .selectFrom('platform_network')
        .select('public_address')
        .where('id', '=', ROW_ID)
        .executeTakeFirst();
      return row?.public_address ?? null;
    },

    /** Saves the address (null clears it). Throws `InvalidPublicAddressError` for anything else. */
    async savePublicAddress(input: string | null, now: Date = new Date()): Promise<string | null> {
      const address = validatePublicAddress(input);
      await kysely
        .insertInto('platform_network')
        .values({ id: ROW_ID, public_address: address, updated_at: now })
        .onDuplicateKeyUpdate({ public_address: address, updated_at: now })
        .execute();
      return address;
    },
  };
}

export type PlatformNetworkRepo = ReturnType<typeof createPlatformNetworkRepo>;

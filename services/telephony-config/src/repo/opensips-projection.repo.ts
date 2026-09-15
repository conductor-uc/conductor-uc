import type { Database } from '@cuc/db';
import type { Kysely } from 'kysely';

import type { OpenSipsDb } from '../opensips-schema.js';

/**
 * Writes to the `opensips` schema's `domain` and `subscriber` tables
 * (S1-12). Not `scoped(ctx)`: neither table has a `tenant_id` column — they
 * are OpenSIPs' own global tables, not a tenant-owned row shape — so this
 * goes through `Database.kysely` directly, the escape hatch `@cuc/db`
 * documents for exactly this case ("migrations, schema introspection, and
 * non-tenant tables"). 05 §1.1: telephony-config is the *only* writer to
 * this schema, so treating both tables as fully owned (an upsert here, an
 * unconditional delete there) is safe — nothing else ever writes a
 * conflicting row.
 */
export function createOpenSipsProjectionRepo(db: Database<OpenSipsDb>) {
  const k: Kysely<OpenSipsDb> = db.kysely;

  return {
    async upsertDomain(fqdn: string): Promise<void> {
      await k
        .insertInto('domain')
        .values({ domain: fqdn, attrs: null, accept_subdomain: 0, last_modified: new Date() })
        .onDuplicateKeyUpdate({ last_modified: new Date() })
        .execute();
    },

    async deleteDomain(fqdn: string): Promise<void> {
      await k.deleteFrom('domain').where('domain', '=', fqdn).execute();
    },

    /** Every domain currently projected — what reconciliation diffs against. */
    listDomains(): Promise<string[]> {
      return k
        .selectFrom('domain')
        .select('domain')
        .execute()
        .then((rows) => rows.map((r) => r.domain));
    },

    /**
     * `auth_db`'s `password_column` is `ha1` (`opensips.cfg.template`) —
     * `ha1_sha256`/`ha1_sha512t256` are left empty because nothing in this
     * deployment computes or checks them (MD5 digest only). `password` stays
     * empty too: this service never has the plaintext (05 §1.1 — only
     * pbx-config-service's `:reveal` ever decrypts it, S1-09).
     */
    async upsertSubscriber(username: string, domain: string, ha1: string): Promise<void> {
      await k
        .insertInto('subscriber')
        .values({
          username,
          domain,
          password: '',
          ha1,
          ha1_sha256: '',
          ha1_sha512t256: '',
        })
        .onDuplicateKeyUpdate({ ha1 })
        .execute();
    },

    async deleteSubscriber(username: string, domain: string): Promise<void> {
      await k
        .deleteFrom('subscriber')
        .where('username', '=', username)
        .where('domain', '=', domain)
        .execute();
    },

    /** Every (username, domain) currently projected. */
    listSubscribers(): Promise<{ username: string; domain: string }[]> {
      return k.selectFrom('subscriber').select(['username', 'domain']).execute();
    },
  };
}

export type OpenSipsProjectionRepo = ReturnType<typeof createOpenSipsProjectionRepo>;

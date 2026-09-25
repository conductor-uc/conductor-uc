import { kekRewrapper, type KekProvider } from '@cuc/crypto';
import { createRewrapJob, type Database, type RewrapTarget } from '@cuc/db';
import type { Logger } from '@cuc/logger';

import type { OrgServiceDb } from './schema.js';

/**
 * Every envelope-encrypted column this service stores (07 §5). Add a column
 * here when a repository starts calling `encrypt` for it, or it will keep its
 * old key version forever and block that version's removal.
 *
 * The associated data each value was encrypted with (noted per column) needs
 * no handling: a re-wrap changes only the wrapped data key, never the payload
 * the associated data authenticates.
 */
export const ENCRYPTED_COLUMNS: readonly RewrapTarget[] = [
  /** TLS private keys; AAD `tls_certificates.private_key_enc:<fqdn>`. */
  { table: 'tls_certificates', idColumn: 'fqdn', column: 'private_key_enc' },
  /** ACME account keys; AAD `acme_accounts.account_key_enc:<directory url>`. */
  { table: 'acme_accounts', idColumn: 'directory_url', column: 'account_key_enc' },
];

/**
 * The background job that moves those values to the current KEK version
 * (G-116). `main.ts` starts it and reports its count in `/readyz`.
 */
export function createKekRewrapJob(
  db: Database<OrgServiceDb>,
  kek: KekProvider,
  logger: Logger,
  batchSize?: number,
) {
  // Platform tables, not tenant-owned, so no `unscoped` is involved.
  const connection = db.kysely;
  return createRewrapJob({
    db: connection,
    targets: ENCRYPTED_COLUMNS,
    rewrapper: kekRewrapper(kek),
    logger,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

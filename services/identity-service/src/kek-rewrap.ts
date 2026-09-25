import { kekRewrapper, type KekProvider } from '@cuc/crypto';
import { createRewrapJob, type Database, type RewrapTarget } from '@cuc/db';
import type { Logger } from '@cuc/logger';

import type { IdentityServiceDb } from './schema.js';

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
  /** Login-token signing keys; AAD `signing_keys.private_key_enc:<key id>`. */
  { table: 'signing_keys', idColumn: 'id', column: 'private_key_enc' },
  /** TOTP secrets; AAD `mfa_factors.secret_enc:user:<user id>`. */
  { table: 'mfa_factors', idColumn: 'id', column: 'secret_enc' },
];

/**
 * The background job that moves those values to the current KEK version
 * (G-116). `main.ts` starts it and reports its count in `/readyz`.
 */
export function createKekRewrapJob(
  db: Database<IdentityServiceDb>,
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

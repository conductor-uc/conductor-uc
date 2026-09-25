import { kekRewrapper, type KekProvider } from '@cuc/crypto';
import { createRewrapJob, type Database, type RewrapTarget } from '@cuc/db';
import type { Logger } from '@cuc/logger';

import type { TrunkServiceDb } from './schema.js';

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
  /** Trunk credentials; AAD `<tenant>:trunks.secret_enc:<id>`. */
  { table: 'trunks', idColumn: 'id', column: 'secret_enc' },
];

/**
 * The background job that moves those values to the current KEK version
 * (G-116). `main.ts` starts it and reports its count in `/readyz`.
 */
export function createKekRewrapJob(
  db: Database<TrunkServiceDb>,
  kek: KekProvider,
  logger: Logger,
  batchSize?: number,
) {
  // Tenant-owned tables, every tenant at once: the one kind of work a
  // background job has to do unscoped. Declared (and reported) once, here.
  const connection = db.unscoped(
    {},
    'KEK re-wrap: moving stored secrets to the current key version (G-116)',
  );
  return createRewrapJob({
    db: connection,
    targets: ENCRYPTED_COLUMNS,
    rewrapper: kekRewrapper(kek),
    logger,
    ...(batchSize === undefined ? {} : { batchSize }),
  });
}

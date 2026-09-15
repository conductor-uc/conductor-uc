import type { Transaction } from 'kysely';
import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { PbxConfigClient } from './pbx-config-client.js';
import type { ReadModelRepo } from './repo/read-model.repo.js';
import type { OpenSipsProjectionRepo } from './repo/opensips-projection.repo.js';
import type { TelephonyConfigDb } from './schema.js';

/**
 * The projection operations both consumers (`consumers/org.consumer.ts`,
 * `consumers/pbx.consumer.ts`) share (S1-12).
 *
 * Every write here happens in two uncoordinated steps — the `opensips`
 * schema (a separate DB connection/user, 05 §1.1) first, then the local
 * read model on the caller's own transaction — because the two schemas can
 * never share one MariaDB transaction. If the process dies between them, the
 * event is redelivered (it was never acked) and both steps simply run again;
 * every operation here is an upsert or an idempotent delete, so a retry is
 * safe. The reconciliation pass (`reconcile.ts`) is the backstop for
 * anything that isn't retried this way — a partial write left behind by a
 * crash that never resulted in a redelivery.
 */
export function createProjection(
  readModel: ReadModelRepo,
  opensips: OpenSipsProjectionRepo,
  mi: OpenSipsMiClient,
  pbxConfig: PbxConfigClient,
  logger: Logger,
) {
  return {
    /**
     * A tenant becoming active with a known domain: project `domain` and
     * trigger `domain_reload` (03 §2 — `domain` is db_mode=1, cached).
     */
    async activateDomain(fqdn: string): Promise<void> {
      await opensips.upsertDomain(fqdn);
      await mi.call('domain_reload');
    },

    /** A tenant being suspended, or losing its domain: remove it and reload. */
    async deactivateDomain(fqdn: string): Promise<void> {
      await opensips.deleteDomain(fqdn);
      await mi.call('domain_reload');
    },

    /**
     * Fetches an extension's current digest credential and projects it —
     * shared by `pbx.extension.created` and `.updated` (the latter is
     * otherwise a no-op for this service, since renumbering never touches
     * `sip_credentials`; re-fetching is cheap self-healing, not dead code).
     * A 404 from pbx-config-service means the extension is already gone
     * (raced with a delete) — nothing to project.
     *
     * `auth_db` queries MariaDB live (no cache), so no MI reload follows a
     * `subscriber` change.
     */
    async projectExtension(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      extensionId: string,
    ): Promise<void> {
      const credential = await pbxConfig.findCredential(tenantId, extensionId);
      if (credential === undefined) {
        logger.warn({ tenantId, extensionId }, 'extension not found in pbx-config-service');
        return;
      }

      const previous = await readModel.upsertExtension(trx, {
        id: extensionId,
        tenantId,
        number: credential.number,
        username: credential.username,
        ha1: credential.ha1,
        realm: credential.realm,
      });

      if (
        previous !== undefined &&
        (previous.username !== credential.username || previous.realm !== credential.realm)
      ) {
        await opensips.deleteSubscriber(previous.username, previous.realm);
      }
      await opensips.upsertSubscriber(credential.username, credential.realm, credential.ha1);
    },

    /** `pbx.extension.deleted`: remove the local row and its subscriber projection. */
    async removeExtension(trx: Transaction<TelephonyConfigDb>, extensionId: string): Promise<void> {
      const removed = await readModel.deleteExtension(trx, extensionId);
      if (removed === undefined) return;
      await opensips.deleteSubscriber(removed.username, removed.realm);
    },
  };
}

export type Projection = ReturnType<typeof createProjection>;

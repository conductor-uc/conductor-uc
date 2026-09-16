import type { Transaction } from 'kysely';
import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { PbxConfigClient } from './pbx-config-client.js';
import type { ReadModelRepo, TrunkRow } from './repo/read-model.repo.js';
import type { OpenSipsProjectionRepo } from './repo/opensips-projection.repo.js';
import type { TelephonyConfigDb } from './schema.js';
import type { TrunkConfig, TrunkConfigClient } from './trunk-config-client.js';

/** `203.0.113.0/24` -> `{ ip: '203.0.113.0', mask: 24 }` (03 §1's `address` table). */
export function parseCidr(cidr: string): { ip: string; mask: number } {
  const [ip, maskText] = cidr.split('/');
  return { ip: ip ?? cidr, mask: maskText === undefined ? 32 : Number(maskText) };
}

/**
 * The `(registrar, aor, bindingUri)` triple `uac_registrant`'s unique
 * constraint keys on (S2-02) — derived the same way every time, from a
 * trunk's own config plus this OpenSIPs cluster's own SIP URI (what the
 * carrier should send calls and challenges back to).
 */
export function registrantKeyFor(
  trunk: Pick<TrunkConfig, 'host' | 'port' | 'username' | 'fromDomain'>,
  opensipsSipUri: string,
): { registrar: string; aor: string; bindingUri: string } {
  return {
    registrar: `sip:${trunk.host}:${String(trunk.port)}`,
    aor: `sip:${trunk.username ?? ''}@${trunk.fromDomain ?? trunk.host}`,
    bindingUri: `sip:${opensipsSipUri}`,
  };
}

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
  trunkConfig: TrunkConfigClient,
  /** This OpenSIPs cluster's own SIP URI, e.g. `opensips:5060` (`config.ts`'s `OPENSIPS_SIP_URI`). */
  opensipsSipUri: string,
) {
  return {
    /**
     * A tenant becoming active with a known domain: project `domain` and
     * trigger `domain_reload` (03 §2 — `domain` is db_mode=1, cached).
     */
    async activateDomain(fqdn: string, tenantId: string): Promise<void> {
      await opensips.upsertDomain(fqdn, tenantId);
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

    /**
     * Fetches a trunk's current full config (including its decrypted
     * secret and IPs) and projects it into `registrant` (register/both),
     * `address` (ip/both), and `dr_gateways` (always — 03 §1's LCR needs a
     * gateway row regardless of auth mode) — shared by `trunk.trunk.created`
     * and `.updated`, the same "thin event, re-fetch current state" story
     * `projectExtension` tells. A 404 from trunk-service means the trunk is
     * already gone (raced with a delete) — nothing to project.
     */
    async projectTrunk(
      trx: Transaction<TelephonyConfigDb>,
      tenantId: string,
      trunkId: string,
    ): Promise<void> {
      const trunk = await trunkConfig.findTrunk(tenantId, trunkId);
      if (trunk === undefined) {
        logger.warn({ tenantId, trunkId }, 'trunk not found in trunk-service');
        return;
      }

      const previous = await readModel.upsertTrunk(trx, toTrunkRow(trunk));
      const needsRegistration = trunk.authMode === 'register' || trunk.authMode === 'both';
      const needsAddress = trunk.authMode === 'ip' || trunk.authMode === 'both';

      let reloadRegistrant = false;
      if (previous !== undefined) {
        const previousNeedsRegistration =
          previous.authMode === 'register' || previous.authMode === 'both';
        if (previousNeedsRegistration) {
          const previousKey = registrantKeyFor(previous, opensipsSipUri);
          const currentKey = registrantKeyFor(trunk, opensipsSipUri);
          if (
            !needsRegistration ||
            previousKey.aor !== currentKey.aor ||
            previousKey.registrar !== currentKey.registrar
          ) {
            await opensips.deleteRegistrant(
              previousKey.aor,
              previousKey.registrar,
              previousKey.bindingUri,
            );
            reloadRegistrant = true;
          }
        }
      }
      if (needsRegistration && trunk.username !== null && trunk.secret !== null) {
        const key = registrantKeyFor(trunk, opensipsSipUri);
        await opensips.upsertRegistrant({ ...key, username: trunk.username, password: trunk.secret });
        reloadRegistrant = true;
      }
      if (reloadRegistrant) await mi.call('reg_reload');

      const desiredIps = needsAddress ? trunk.ips : [];
      const { added, removed } = await readModel.replaceTrunkIps(trx, trunk.id, desiredIps);
      if (added.length + removed.length > 0) {
        await opensips.replaceAddresses(trunk.id, desiredIps.map(parseCidr));
        await mi.call('address_reload');
      }

      const gatewayChanged =
        previous === undefined || previous.host !== trunk.host || previous.port !== trunk.port;
      await opensips.upsertDrGateway({
        gwid: trunk.id,
        address: `${trunk.host}:${String(trunk.port)}`,
        description: trunk.name,
      });
      if (gatewayChanged) await mi.call('dr_reload');
    },

    /**
     * `trunk.trunk.deleted`: remove the local row and every projection it
     * fed — `registrant` (if it registered), `address` (if it had IPs), and
     * `dr_gateways` (always).
     */
    async removeTrunk(trx: Transaction<TelephonyConfigDb>, trunkId: string): Promise<void> {
      const removed = await readModel.deleteTrunk(trx, trunkId);
      if (removed === undefined) return;

      const neededRegistration = removed.authMode === 'register' || removed.authMode === 'both';
      if (neededRegistration) {
        const key = registrantKeyFor(removed, opensipsSipUri);
        await opensips.deleteRegistrant(key.aor, key.registrar, key.bindingUri);
        await mi.call('reg_reload');
      }

      const neededAddress = removed.authMode === 'ip' || removed.authMode === 'both';
      if (neededAddress) {
        await opensips.replaceAddresses(trunkId, []);
        await mi.call('address_reload');
      }

      await opensips.deleteDrGateway(trunkId);
      await mi.call('dr_reload');
    },
  };
}

function toTrunkRow(trunk: TrunkConfig): TrunkRow {
  return {
    id: trunk.id,
    tenantId: trunk.tenantId,
    name: trunk.name,
    authMode: trunk.authMode,
    host: trunk.host,
    port: trunk.port,
    transport: trunk.transport,
    username: trunk.username,
    secret: trunk.secret,
    fromDomain: trunk.fromDomain,
    status: trunk.status,
  };
}

export type Projection = ReturnType<typeof createProjection>;

import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import { parseCidr, registrantKeyFor } from './projection.js';
import type { OpenSipsProjectionRepo } from './repo/opensips-projection.repo.js';
import type { ReadModelRepo } from './repo/read-model.repo.js';

export interface ReconcileReport {
  readonly domainsAdded: number;
  readonly domainsRemoved: number;
  readonly subscribersAdded: number;
  readonly subscribersRemoved: number;
  readonly registrantsAdded: number;
  readonly registrantsRemoved: number;
  readonly addressesAdded: number;
  readonly addressesRemoved: number;
  readonly gatewaysAdded: number;
  readonly gatewaysRemoved: number;
}

const subscriberKey = (username: string, domain: string): string => `${username} ${domain}`;
const registrantKey = (aor: string, registrar: string, bindingUri: string): string =>
  `${aor} ${registrar} ${bindingUri}`;
const addressKey = (trunkId: string, ip: string, mask: number): string =>
  `${trunkId} ${ip}/${String(mask)}`;

/**
 * The reconciliation job (06: "compares the read model with the source
 * services every 15 min and repairs drift").
 *
 * Scoped to what this service can honestly check today: telephony-config's
 * own read model (`tenants`/`domains`/`extensions`/`trunks`/`trunk_ips`,
 * kept current by `consumers/*`) against what is actually projected into
 * `opensips`. This
 * repairs the failure this service's own two-step, cross-schema writes can
 * leave behind — an `opensips` write that failed, or was made by hand —
 * which is the drift most likely to occur in practice given the design
 * (`projection.ts`'s own comment on why the two steps are not atomic).
 *
 * It does **not** re-verify the read model itself against org-service or
 * pbx-config-service's own current state (a missed event that never
 * redelivered, for instance): neither service exposes a "list everything"
 * internal endpoint yet, and building one is its own piece of work. Flagged
 * as gap G-17 in docs/decisions.md rather than silently left unimplemented.
 */
export function createReconciler(
  readModel: ReadModelRepo,
  opensips: OpenSipsProjectionRepo,
  mi: OpenSipsMiClient,
  logger: Logger,
  /** This OpenSIPs cluster's own SIP URI (`config.ts`'s `OPENSIPS_SIP_URI`) — see `projection.ts`'s `registrantKeyFor`. */
  opensipsSipUri: string,
) {
  async function reconcileOnce(): Promise<ReconcileReport> {
    const [
      tenants,
      domains,
      extensions,
      trunks,
      trunkIps,
      projectedDomains,
      projectedSubscribers,
      projectedRegistrants,
      projectedAddresses,
      projectedGateways,
    ] = await Promise.all([
      readModel.listTenants(),
      readModel.listDomains(),
      readModel.listExtensions(),
      readModel.listTrunks(),
      readModel.listAllTrunkIps(),
      opensips.listDomains(),
      opensips.listSubscribers(),
      opensips.listRegistrants(),
      opensips.listAddresses(),
      opensips.listDrGateways(),
    ]);

    const activeTenantIds = new Set(tenants.filter((t) => t.status === 'active').map((t) => t.id));
    const desiredDomains = new Map(
      domains
        .filter((d) => activeTenantIds.has(d.tenantId))
        .map((d) => [d.fqdn, d.tenantId] as const),
    );
    const projectedDomainSet = new Set(projectedDomains);

    let domainsAdded = 0;
    let domainsRemoved = 0;
    for (const [fqdn, tenantId] of desiredDomains) {
      if (!projectedDomainSet.has(fqdn)) {
        await opensips.upsertDomain(fqdn, tenantId);
        domainsAdded += 1;
      }
    }
    for (const fqdn of projectedDomainSet) {
      if (!desiredDomains.has(fqdn)) {
        await opensips.deleteDomain(fqdn);
        domainsRemoved += 1;
      }
    }
    if (domainsAdded + domainsRemoved > 0) await mi.call('domain_reload');

    const desiredSubscribers = new Map(
      extensions.map((e) => [subscriberKey(e.username, e.realm), e] as const),
    );
    const projectedSubscriberKeys = new Map(
      projectedSubscribers.map((s) => [subscriberKey(s.username, s.domain), s] as const),
    );

    let subscribersAdded = 0;
    let subscribersRemoved = 0;
    for (const [key, extension] of desiredSubscribers) {
      if (!projectedSubscriberKeys.has(key)) {
        await opensips.upsertSubscriber(extension.username, extension.realm, extension.ha1);
        subscribersAdded += 1;
      }
    }
    for (const [key, subscriber] of projectedSubscriberKeys) {
      if (!desiredSubscribers.has(key)) {
        await opensips.deleteSubscriber(subscriber.username, subscriber.domain);
        subscribersRemoved += 1;
      }
    }

    // Trunks with a register credential -> `registrant` (S2-02).
    const trunksById = new Map(trunks.map((t) => [t.id, t] as const));
    const registerTrunks = trunks.filter(
      (t) =>
        (t.authMode === 'register' || t.authMode === 'both') &&
        t.username !== null &&
        t.secret !== null,
    );
    const desiredRegistrants = new Map(
      registerTrunks.map((t) => {
        const key = registrantKeyFor(t, opensipsSipUri);
        return [
          registrantKey(key.aor, key.registrar, key.bindingUri),
          { ...key, trunk: t },
        ] as const;
      }),
    );
    const projectedRegistrantKeys = new Map(
      projectedRegistrants.map(
        (r) => [registrantKey(r.aor, r.registrar, r.bindingUri), r] as const,
      ),
    );

    let registrantsAdded = 0;
    let registrantsRemoved = 0;
    for (const [key, desired] of desiredRegistrants) {
      if (!projectedRegistrantKeys.has(key)) {
        await opensips.upsertRegistrant({
          registrar: desired.registrar,
          aor: desired.aor,
          bindingUri: desired.bindingUri,
          username: desired.trunk.username!,
          password: desired.trunk.secret!,
        });
        registrantsAdded += 1;
      }
    }
    for (const [key, projected] of projectedRegistrantKeys) {
      if (!desiredRegistrants.has(key)) {
        await opensips.deleteRegistrant(projected.aor, projected.registrar, projected.bindingUri);
        registrantsRemoved += 1;
      }
    }
    if (registrantsAdded + registrantsRemoved > 0) await mi.call('reg_reload');

    // Trunks with IPs (ip/both mode) -> `address` (S2-02).
    const addressTrunkIds = new Set(
      trunks.filter((t) => t.authMode === 'ip' || t.authMode === 'both').map((t) => t.id),
    );
    const desiredAddresses = new Map(
      trunkIps
        .filter((row) => addressTrunkIds.has(row.trunkId))
        .map((row) => {
          const { ip, mask } = parseCidr(row.cidr);
          return [addressKey(row.trunkId, ip, mask), { trunkId: row.trunkId, ip, mask }] as const;
        }),
    );
    const projectedAddressKeys = new Map(
      projectedAddresses.map((a) => [addressKey(a.trunkId, a.ip, a.mask), a] as const),
    );

    let addressesAdded = 0;
    let addressesRemoved = 0;
    // Grouped per trunk: `replaceAddresses` replaces a trunk's whole set in
    // one call (`opensips-projection.repo.ts` — the vendored table has no
    // unique constraint to upsert a single row against).
    const trunksNeedingAddressRepair = new Set<string>();
    for (const [key, desired] of desiredAddresses) {
      if (!projectedAddressKeys.has(key)) trunksNeedingAddressRepair.add(desired.trunkId);
    }
    for (const [key, projected] of projectedAddressKeys) {
      if (!desiredAddresses.has(key)) trunksNeedingAddressRepair.add(projected.trunkId);
    }
    for (const trunkId of trunksNeedingAddressRepair) {
      const desiredForTrunk = [...desiredAddresses.values()].filter((a) => a.trunkId === trunkId);
      const projectedForTrunk = [...projectedAddressKeys.values()].filter(
        (a) => a.trunkId === trunkId,
      );
      await opensips.replaceAddresses(trunkId, desiredForTrunk);
      addressesAdded += desiredForTrunk.length;
      addressesRemoved += projectedForTrunk.length;
    }
    if (trunksNeedingAddressRepair.size > 0) await mi.call('address_reload');

    // Every trunk -> `dr_gateways` (S2-02; docs/decisions.md G-23 on why not `dr_rules`/`dr_groups` yet).
    const desiredGatewayIds = new Set(trunks.map((t) => t.id));
    const projectedGatewaySet = new Set(projectedGateways);

    let gatewaysAdded = 0;
    let gatewaysRemoved = 0;
    for (const gwid of desiredGatewayIds) {
      if (!projectedGatewaySet.has(gwid)) {
        const trunk = trunksById.get(gwid)!;
        await opensips.upsertDrGateway({
          gwid,
          address: `${trunk.host}:${String(trunk.port)}`,
          description: trunk.name,
        });
        gatewaysAdded += 1;
      }
    }
    for (const gwid of projectedGatewaySet) {
      if (!desiredGatewayIds.has(gwid)) {
        await opensips.deleteDrGateway(gwid);
        gatewaysRemoved += 1;
      }
    }
    if (gatewaysAdded + gatewaysRemoved > 0) await mi.call('dr_reload');

    const report: ReconcileReport = {
      domainsAdded,
      domainsRemoved,
      subscribersAdded,
      subscribersRemoved,
      registrantsAdded,
      registrantsRemoved,
      addressesAdded,
      addressesRemoved,
      gatewaysAdded,
      gatewaysRemoved,
    };
    const total =
      domainsAdded +
      domainsRemoved +
      subscribersAdded +
      subscribersRemoved +
      registrantsAdded +
      registrantsRemoved +
      addressesAdded +
      addressesRemoved +
      gatewaysAdded +
      gatewaysRemoved;
    if (total > 0) logger.info(report, 'reconciliation repaired drift');
    else logger.debug(report, 'reconciliation found no drift');
    return report;
  }

  let timer: NodeJS.Timeout | undefined;

  return {
    reconcileOnce,

    /** Starts the periodic pass. A failed pass logs and tries again next interval. */
    start(intervalMs: number): void {
      timer = setInterval(() => {
        reconcileOnce().catch((error: unknown) => {
          logger.error({ err: error }, 'reconciliation pass failed');
        });
      }, intervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Reconciler = ReturnType<typeof createReconciler>;

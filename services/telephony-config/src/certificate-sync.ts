import { createHash } from 'node:crypto';

import type { Logger } from '@cuc/logger';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { OrgClient, SipCertificateMaterial } from './org-client.js';
import type { OpenSipsProjectionRepo } from './repo/opensips-projection.repo.js';

/** OpenSIPs' name for the row that answers a connection whose name matches no other row. */
export const DEFAULT_TLS_DOMAIN = 'default';

/**
 * Keeps OpenSIPs' `tls_mgm` table in step with the SIP proxy certificates
 * org-service holds (G-105), and tells OpenSIPs to reload them so a new or renewed
 * certificate takes effect with no restart.
 *
 * Each certificate is a row named for its hostname and chosen by the name a phone
 * asks for. The platform's own proxy (owned by no reseller) is also the `default`
 * row, which answers a name there is nothing for. The private key is written in the
 * clear, because OpenSIPs can only load it that way from the database; the
 * encrypted copy in org-service stays the source of truth.
 *
 * Used two ways that must agree: as each `org.certificate.issued` arrives (`syncOne`),
 * and on a timer (`syncAll`) that repairs anything a failed write or a lost event left
 * behind, and removes a row whose certificate org-service no longer holds.
 */
export function createCertificateSync(
  orgClient: OrgClient,
  opensips: OpenSipsProjectionRepo,
  mi: OpenSipsMiClient,
  logger: Logger,
) {
  async function write(material: SipCertificateMaterial): Promise<void> {
    await opensips.upsertTlsDomain({
      domain: material.fqdn,
      matchIpAddress: null,
      matchSipDomain: material.fqdn,
      certificate: material.certificate,
      privateKey: material.privateKey,
    });
    if (material.resellerId === null) {
      await opensips.upsertTlsDomain({
        domain: DEFAULT_TLS_DOMAIN,
        matchIpAddress: '*',
        matchSipDomain: null,
        certificate: material.certificate,
        privateKey: material.privateKey,
      });
    }
  }

  return {
    /** Fetches one certificate and projects it, then reloads. False when org-service holds none for the name. */
    async syncOne(fqdn: string): Promise<boolean> {
      const material = await orgClient.findCertificate(fqdn);
      if (material === undefined) {
        logger.warn({ fqdn }, 'certificates: none held for a certificate event');
        return false;
      }
      await write(material);
      await mi.call('tls_reload');
      return true;
    },

    /**
     * Brings the table in line with org-service: fetches only the certificates whose
     * fingerprint differs from what OpenSIPs holds, removes rows org-service no longer
     * lists, and reloads once if anything changed. Returns what it did.
     */
    async syncAll(): Promise<{ written: string[]; removed: string[] }> {
      const wanted = await orgClient.listSipCertificates();
      const held = new Map((await opensips.listTlsDomains()).map((r) => [r.domain, r.fingerprint]));
      const written: string[] = [];
      const removed: string[] = [];

      for (const summary of wanted) {
        const stale =
          held.get(summary.fqdn) !== summary.fingerprint ||
          (summary.resellerId === null && held.get(DEFAULT_TLS_DOMAIN) !== summary.fingerprint);
        if (!stale) continue;
        const material = await orgClient.findCertificate(summary.fqdn);
        if (material === undefined) continue;
        await write(material);
        written.push(summary.fqdn);
      }

      const wantedNames = new Set(wanted.map((w) => w.fqdn));
      const platformHeld = wanted.some((w) => w.resellerId === null);
      for (const domain of held.keys()) {
        const keep = wantedNames.has(domain) || (domain === DEFAULT_TLS_DOMAIN && platformHeld);
        if (keep) continue;
        await opensips.deleteTlsDomain(domain);
        removed.push(domain);
      }

      if (written.length > 0 || removed.length > 0) {
        await mi.call('tls_reload');
        logger.info({ written, removed }, 'certificates: reconciled OpenSIPs');
      }
      return { written, removed };
    },
  };
}

export type CertificateSync = ReturnType<typeof createCertificateSync>;

/** Runs `syncAll` now and then, logging rather than throwing so one failed pass does not stop the next. */
export function startCertificateSync(sync: CertificateSync, logger: Logger, intervalMs: number) {
  let timer: NodeJS.Timeout | undefined;
  let stopped = false;
  const pass = async (): Promise<void> => {
    try {
      await sync.syncAll();
    } catch (error) {
      logger.warn({ err: error }, 'certificates: reconcile failed');
    }
    if (!stopped) timer = setTimeout(() => void pass(), intervalMs);
  };
  void pass();
  return {
    stop(): void {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}

/** The fingerprint OpenSIPs' stored certificate would have, for tests and diagnostics. */
export function certificateFingerprint(pem: string): string {
  return createHash('sha256').update(pem, 'utf8').digest('hex');
}

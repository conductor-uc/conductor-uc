import type { Logger } from '@cuc/logger';

import type { AcmeIssuer } from './acme-issuer.js';
import type { AcmeAccountRepo } from './repo/acme-account.repo.js';
import type { AcmeSettingsRepo } from './repo/acme-settings.repo.js';
import type { Certificate, CertificateRepo } from './repo/certificate.repo.js';

export interface CertificateWorkerOptions {
  readonly certs: CertificateRepo;
  readonly settings: AcmeSettingsRepo;
  readonly accounts: AcmeAccountRepo;
  readonly issuer: AcmeIssuer;
  readonly logger: Logger;
  /** How often to look for certificates that are due. */
  readonly intervalMs?: number;
  /** How long one certificate is reserved for this worker while it works on it. */
  readonly leaseMs?: number;
  /** The most certificates taken at once, so one slow name does not hold up the rest. */
  readonly batchSize?: number;
  /** How long an HTTP challenge answer is served: more than a CA takes to check it. */
  readonly challengeTtlMs?: number;
  readonly now?: () => Date;
}

export interface WorkerPass {
  readonly issued: readonly string[];
  readonly failed: readonly string[];
  /** Why nothing was tried, when nothing was: the platform is not set up to request certificates. */
  readonly skipped: string | null;
}

/**
 * Requests and renews the certificates the platform keeps, in the background
 * (G-105). Each pass does nothing until the operator has saved a contact address
 * and agreed to the terms in the console. After that it takes whichever
 * certificates are due (never issued, failed and past their retry time, or inside
 * the renewal window), asks the CA for each with an HTTP-01 challenge, and stores
 * the result, or records why it failed and when it will try again.
 *
 * Safe to run on several instances: a certificate is leased to one at a time.
 */
export function createCertificateWorker(options: CertificateWorkerOptions) {
  const { certs, settings, accounts, issuer, logger } = options;
  const intervalMs = options.intervalMs ?? 60_000;
  const leaseMs = options.leaseMs ?? 15 * 60_000;
  const batchSize = options.batchSize ?? 5;
  const challengeTtlMs = options.challengeTtlMs ?? 15 * 60_000;
  const now = options.now ?? (() => new Date());
  let running = false;

  async function issue(
    cert: Certificate,
    config: Awaited<ReturnType<typeof settings.get>>,
  ): Promise<void> {
    if (config.contactEmail === null) throw new Error('No contact address is set.');
    const directoryUrl = config.directoryUrl;
    const account =
      (await accounts.get(directoryUrl)) ??
      (await accounts.create(directoryUrl, await issuer.newAccountKey()));

    const result = await issuer.issue({
      fqdn: cert.fqdn,
      directoryUrl,
      contactEmail: config.contactEmail,
      accountKeyPem: account.keyPem,
      accountUrl: account.accountUrl,
      publishChallenge: (token, keyAuthorization) =>
        certs.putChallenge({
          token,
          fqdn: cert.fqdn,
          keyAuthorization,
          expiresAt: new Date(now().getTime() + challengeTtlMs),
          now: now(),
        }),
      removeChallenge: (token) => certs.deleteChallenge(token),
    });

    if (result.accountUrl !== account.accountUrl) {
      await accounts.setAccountUrl(directoryUrl, result.accountUrl);
    }
    await certs.storeIssued({
      fqdn: cert.fqdn,
      certificatePem: result.certificatePem,
      privateKeyPem: result.privateKeyPem,
      now: now(),
    });
  }

  return {
    /** One pass: what was issued, what failed, or why nothing was tried. */
    async runOnce(): Promise<WorkerPass> {
      const config = await settings.get();
      if (!config.ready) {
        return {
          issued: [],
          failed: [],
          skipped: 'No contact address is saved, or the terms have not been agreed to.',
        };
      }

      await certs.purgeExpiredChallenges(now());
      const due = await certs.claimDue(now(), leaseMs, batchSize);
      const issued: string[] = [];
      const failed: string[] = [];
      for (const cert of due) {
        try {
          await issue(cert, config);
          issued.push(cert.fqdn);
          logger.info({ fqdn: cert.fqdn }, 'certificates: issued');
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failed.push(cert.fqdn);
          logger.warn({ fqdn: cert.fqdn, err: error }, 'certificates: could not issue');
          await certs.recordFailure(cert.fqdn, message, now());
        }
      }
      return { issued, failed, skipped: null };
    },

    /** Runs passes until [stop] is called. A pass that throws is logged and the loop carries on. */
    async run(): Promise<void> {
      running = true;
      while (running) {
        try {
          await this.runOnce();
        } catch (error) {
          logger.warn({ err: error }, 'certificates: pass failed');
        }
        await new Promise((resolve) => setTimeout(resolve, intervalMs));
      }
    },

    stop(): void {
      running = false;
    },
  };
}

export type CertificateWorker = ReturnType<typeof createCertificateWorker>;

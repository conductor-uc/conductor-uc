import { createHash } from 'node:crypto';

import type { Database } from '@cuc/db';
import { isDuplicateKeyError } from '@cuc/db';
import { decryptString, encrypt, type KekProvider } from '@cuc/crypto';
import { enqueueEvent } from '@cuc/events';

import {
  RENEW_BEFORE_MS,
  inspectCertificate,
  retryDelayMs,
  sipProxyHostname,
} from '../domain/certificates.js';
import { orgEvents } from '../events.js';
import type { CertificatePurpose, CertificateStatus, OrgServiceDb } from '../schema.js';

export interface Certificate {
  readonly fqdn: string;
  readonly purpose: CertificatePurpose;
  /** Null for the platform's own. */
  readonly resellerId: string | null;
  readonly status: CertificateStatus;
  readonly notBefore: Date | null;
  readonly notAfter: Date | null;
  readonly attempts: number;
  readonly nextAttemptAt: Date;
  readonly lastError: string | null;
  readonly version: number;
}

/** A certificate with its private key, for the consumers that serve it (OpenSIPs, the gateway). */
export interface CertificateMaterial {
  readonly fqdn: string;
  readonly purpose: CertificatePurpose;
  readonly resellerId: string | null;
  readonly version: number;
  readonly notAfter: Date;
  readonly certificatePem: string;
  readonly privateKeyPem: string;
}

/** One held certificate, described without its key. */
export interface CertificateSummary {
  readonly fqdn: string;
  readonly purpose: CertificatePurpose;
  readonly resellerId: string | null;
  readonly version: number;
  /** SHA-256 (hex) of the certificate PEM as stored. */
  readonly fingerprint: string;
}

export interface SipProxy {
  readonly host: string;
  readonly status: CertificateStatus;
}

export class CertificateNotFoundError extends Error {
  override readonly name = 'CertificateNotFoundError';
}

interface Row {
  fqdn: string;
  purpose: CertificatePurpose;
  reseller_id: string | null;
  status: CertificateStatus;
  not_before: Date | null;
  not_after: Date | null;
  attempts: number;
  next_attempt_at: Date;
  last_error: string | null;
  version: number;
}

function toCertificate(row: Row): Certificate {
  return {
    fqdn: row.fqdn,
    purpose: row.purpose,
    resellerId: row.reseller_id,
    status: row.status,
    notBefore: row.not_before,
    notAfter: row.not_after,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastError: row.last_error,
    version: row.version,
  };
}

const keyAssociatedData = (fqdn: string): string => `tls_certificates.private_key_enc:${fqdn}`;

export interface CertificateRepoOptions {
  readonly kek: KekProvider;
  /** The platform's own base domain: the master's console and the proxy direct tenants use. */
  readonly platformBaseDomain: string;
}

/**
 * The certificates the platform keeps, their ACME challenge answers, and which
 * SIP proxy a tenant's phones connect to (G-105).
 *
 * None of these tables is tenant-owned, so none goes through `scoped(ctx)`; the
 * private key is envelope-encrypted and only ever leaves through
 * `getMaterial`, which the internal route hands to a trusted consumer.
 */
export function createCertificateRepo(db: Database<OrgServiceDb>, options: CertificateRepoOptions) {
  const kysely = db.kysely;
  const { kek, platformBaseDomain } = options;

  return {
    /**
     * Makes sure a row exists for every hostname that should have a certificate,
     * worked out from what is already in the database, so no provisioning path has
     * to remember to ask: the platform's proxy and console, `sip.<base>` for each
     * active reseller base domain, and each registered console hostname. New rows
     * are due at once. Returns how many were added.
     */
    async reconcileWanted(now: Date = new Date()): Promise<number> {
      const wanted = new Map<string, { purpose: CertificatePurpose; resellerId: string | null }>();
      wanted.set(sipProxyHostname(platformBaseDomain), { purpose: 'sip', resellerId: null });
      wanted.set(`console.${platformBaseDomain}`.toLowerCase(), {
        purpose: 'console',
        resellerId: null,
      });
      for (const base of await kysely
        .selectFrom('reseller_base_domains')
        .select(['fqdn', 'reseller_id'])
        .where('status', '=', 'active')
        .execute()) {
        wanted.set(sipProxyHostname(base.fqdn), { purpose: 'sip', resellerId: base.reseller_id });
      }
      for (const host of await kysely
        .selectFrom('console_hostnames')
        .select(['fqdn', 'reseller_id'])
        .execute()) {
        wanted.set(host.fqdn.toLowerCase(), { purpose: 'console', resellerId: host.reseller_id });
      }

      const have = new Set(
        (await kysely.selectFrom('tls_certificates').select('fqdn').execute()).map((r) => r.fqdn),
      );
      let added = 0;
      for (const [fqdn, want] of wanted) {
        if (have.has(fqdn)) continue;
        try {
          await kysely
            .insertInto('tls_certificates')
            .values({
              fqdn,
              purpose: want.purpose,
              reseller_id: want.resellerId,
              status: 'pending',
              certificate_pem: null,
              private_key_enc: null,
              not_before: null,
              not_after: null,
              attempts: 0,
              next_attempt_at: now,
              last_error: null,
              version: 0,
              created_at: now,
              updated_at: now,
            })
            .execute();
          added += 1;
        } catch (error) {
          // Another instance added it between the read and the insert.
          if (!isDuplicateKeyError(error)) throw error;
        }
      }
      return added;
    },

    async list(filter: { resellerId: string | null }): Promise<Certificate[]> {
      const query = kysely.selectFrom('tls_certificates').selectAll().orderBy('fqdn', 'asc');
      const rows = await (
        filter.resellerId === null
          ? query.where('reseller_id', 'is', null)
          : query.where('reseller_id', '=', filter.resellerId)
      ).execute();
      return rows.map(toCertificate);
    },

    async find(fqdn: string): Promise<Certificate | undefined> {
      const row = await kysely
        .selectFrom('tls_certificates')
        .selectAll()
        .where('fqdn', '=', fqdn.toLowerCase())
        .executeTakeFirst();
      return row === undefined ? undefined : toCertificate(row);
    },

    /**
     * Takes up to [limit] certificates that are due (never issued, failed and
     * past their retry time, or inside the renewal window) and pushes each one's
     * clock forward by [leaseMs], so another instance does not pick the same one
     * while this one is working on it. A worker that dies simply lets the lease run out.
     */
    async claimDue(now: Date, leaseMs: number, limit: number): Promise<Certificate[]> {
      return kysely.transaction().execute(async (trx) => {
        const rows = await trx
          .selectFrom('tls_certificates')
          .selectAll()
          .where('next_attempt_at', '<=', now)
          .orderBy('next_attempt_at', 'asc')
          .limit(limit)
          .forUpdate()
          .skipLocked()
          .execute();
        if (rows.length === 0) return [];
        await trx
          .updateTable('tls_certificates')
          .set({ next_attempt_at: new Date(now.getTime() + leaseMs), updated_at: now })
          .where(
            'fqdn',
            'in',
            rows.map((r) => r.fqdn),
          )
          .execute();
        return rows.map(toCertificate);
      });
    },

    /**
     * Keeps a newly issued certificate: checked to cover the name and to match its
     * key, the key encrypted, the row made active with its renewal time set, the
     * console hostname's status updated, and `org.certificate.issued` queued, all in
     * one transaction (rule 6).
     */
    async storeIssued(input: {
      fqdn: string;
      certificatePem: string;
      privateKeyPem: string;
      now?: Date;
    }): Promise<Certificate> {
      const now = input.now ?? new Date();
      const fqdn = input.fqdn.toLowerCase();
      const facts = inspectCertificate(input.certificatePem, input.privateKeyPem, fqdn, now);
      const keyEnc = await encrypt(kek, input.privateKeyPem, keyAssociatedData(fqdn));

      return kysely.transaction().execute(async (trx) => {
        const row = await trx
          .selectFrom('tls_certificates')
          .selectAll()
          .where('fqdn', '=', fqdn)
          .forUpdate()
          .executeTakeFirst();
        if (row === undefined)
          throw new CertificateNotFoundError(`No certificate wanted for ${fqdn}.`);

        const version = row.version + 1;
        const renewAt = new Date(facts.notAfter.getTime() - RENEW_BEFORE_MS);
        await trx
          .updateTable('tls_certificates')
          .set({
            status: 'active',
            certificate_pem: input.certificatePem,
            private_key_enc: keyEnc,
            not_before: facts.notBefore,
            not_after: facts.notAfter,
            attempts: 0,
            // Due again at the renewal time; never sooner than now.
            next_attempt_at: renewAt > now ? renewAt : now,
            last_error: null,
            version,
            updated_at: now,
          })
          .where('fqdn', '=', fqdn)
          .execute();
        await trx
          .updateTable('console_hostnames')
          .set({ tls_status: 'active' })
          .where('fqdn', '=', fqdn)
          .execute();

        await enqueueEvent(trx, orgEvents, {
          type: 'org.certificate.issued',
          data: { fqdn, purpose: row.purpose, resellerId: row.reseller_id, version },
          ...(row.reseller_id === null ? {} : { orgContext: { resellerId: row.reseller_id } }),
        });

        return toCertificate({
          ...row,
          status: 'active',
          not_before: facts.notBefore,
          not_after: facts.notAfter,
          attempts: 0,
          last_error: null,
          version,
          next_attempt_at: renewAt > now ? renewAt : now,
        });
      });
    },

    /**
     * Notes that an attempt failed and when to try again. A certificate already
     * held stays `active` (it still works; a failed renewal is not an outage);
     * one never issued becomes `failed`.
     */
    async recordFailure(fqdn: string, message: string, now: Date = new Date()): Promise<void> {
      const name = fqdn.toLowerCase();
      const row = await kysely
        .selectFrom('tls_certificates')
        .select(['attempts', 'certificate_pem'])
        .where('fqdn', '=', name)
        .executeTakeFirst();
      if (row === undefined) return;
      const attempts = row.attempts + 1;
      await kysely
        .updateTable('tls_certificates')
        .set({
          attempts,
          status: row.certificate_pem === null ? 'failed' : 'active',
          last_error: message.slice(0, 1000),
          next_attempt_at: new Date(now.getTime() + retryDelayMs(attempts)),
          updated_at: now,
        })
        .where('fqdn', '=', name)
        .execute();
      if (row.certificate_pem === null) {
        await kysely
          .updateTable('console_hostnames')
          .set({ tls_status: 'failed' })
          .where('fqdn', '=', name)
          .execute();
      }
    },

    /**
     * The active certificates of one kind, without their keys, each with a
     * fingerprint (SHA-256 of the certificate as stored). What a consumer that keeps
     * its own copy (OpenSIPs' table, via telephony-config) compares against, so it
     * only fetches a key when the certificate it holds is not the current one.
     */
    async listActive(purpose: CertificatePurpose): Promise<CertificateSummary[]> {
      const rows = await kysely
        .selectFrom('tls_certificates')
        .select(['fqdn', 'purpose', 'reseller_id', 'version', 'certificate_pem'])
        .where('purpose', '=', purpose)
        .where('status', '=', 'active')
        .where('certificate_pem', 'is not', null)
        .orderBy('fqdn', 'asc')
        .execute();
      return rows.map((r) => ({
        fqdn: r.fqdn,
        purpose: r.purpose,
        resellerId: r.reseller_id,
        version: r.version,
        fingerprint: createHash('sha256')
          .update(r.certificate_pem ?? '', 'utf8')
          .digest('hex'),
      }));
    },

    /** The certificate and its decrypted key, or undefined while none has been issued. */
    async getMaterial(fqdn: string): Promise<CertificateMaterial | undefined> {
      const row = await kysely
        .selectFrom('tls_certificates')
        .selectAll()
        .where('fqdn', '=', fqdn.toLowerCase())
        .executeTakeFirst();
      if (
        row === undefined ||
        row.status !== 'active' ||
        row.certificate_pem === null ||
        row.private_key_enc === null ||
        row.not_after === null
      ) {
        return undefined;
      }
      return {
        fqdn: row.fqdn,
        purpose: row.purpose,
        resellerId: row.reseller_id,
        version: row.version,
        notAfter: row.not_after,
        certificatePem: row.certificate_pem,
        privateKeyPem: await decryptString(kek, row.private_key_enc, keyAssociatedData(row.fqdn)),
      };
    },

    /**
     * The SIP proxy a tenant's phones connect to: `sip.<base>` for the reseller
     * base domain the tenant's own domain sits under, and the platform's proxy for a
     * tenant with none (a direct tenant, or one whose reseller has no active base
     * domain). The tenant's domain is still the login realm; this is only where to
     * connect and whose certificate to expect.
     */
    async sipProxyFor(tenantId: string): Promise<SipProxy | undefined> {
      const domain = await kysely
        .selectFrom('tenant_domains')
        .select('fqdn')
        .where('tenant_id', '=', tenantId)
        .where('is_primary', '=', true)
        .executeTakeFirst();
      if (domain === undefined) return undefined;
      const tenant = await kysely
        .selectFrom('orgs')
        .select('reseller_id')
        .where('id', '=', tenantId)
        .executeTakeFirst();
      const bases =
        tenant?.reseller_id == null
          ? []
          : await kysely
              .selectFrom('reseller_base_domains')
              .select('fqdn')
              .where('reseller_id', '=', tenant.reseller_id)
              .where('status', '=', 'active')
              .execute();
      const under = bases.find((b) => domain.fqdn.endsWith(`.${b.fqdn}`));
      const host = sipProxyHostname(under?.fqdn ?? platformBaseDomain);
      const cert = await this.find(host);
      return { host, status: cert?.status ?? 'pending' };
    },

    async putChallenge(input: {
      token: string;
      fqdn: string;
      keyAuthorization: string;
      expiresAt: Date;
      now?: Date;
    }): Promise<void> {
      const now = input.now ?? new Date();
      await kysely
        .insertInto('acme_challenges')
        .values({
          token: input.token,
          fqdn: input.fqdn.toLowerCase(),
          key_authorization: input.keyAuthorization,
          expires_at: input.expiresAt,
          created_at: now,
        })
        .onDuplicateKeyUpdate({
          fqdn: input.fqdn.toLowerCase(),
          key_authorization: input.keyAuthorization,
          expires_at: input.expiresAt,
        })
        .execute();
    },

    /** The answer for [token] while it has not expired. */
    async getChallenge(token: string, now: Date = new Date()): Promise<string | undefined> {
      const row = await kysely
        .selectFrom('acme_challenges')
        .select('key_authorization')
        .where('token', '=', token)
        .where('expires_at', '>', now)
        .executeTakeFirst();
      return row?.key_authorization;
    },

    async deleteChallenge(token: string): Promise<void> {
      await kysely.deleteFrom('acme_challenges').where('token', '=', token).execute();
    },

    async purgeExpiredChallenges(now: Date = new Date()): Promise<number> {
      const result = await kysely
        .deleteFrom('acme_challenges')
        .where('expires_at', '<=', now)
        .executeTakeFirst();
      return Number(result.numDeletedRows);
    },
  };
}

export type CertificateRepo = ReturnType<typeof createCertificateRepo>;

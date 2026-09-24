import type { EventTables } from '@cuc/events';

export type OrgType = 'master' | 'reseller' | 'tenant';
export type OrgStatus = 'active' | 'suspended' | 'pending_deletion' | 'deleted';
/** A reseller base domain starts `pending` and becomes `active` once its TXT record verifies (02 §3). */
export type BaseDomainStatus = 'pending' | 'active';
/** What a certificate is for: the SIP proxy phones connect to, or a console hostname. */
export type CertificatePurpose = 'sip' | 'console';
/** `pending` until first issued, `active` while a usable certificate is held, `failed` after an attempt that has not yet succeeded. */
export type CertificateStatus = 'pending' | 'active' | 'failed';

/**
 * This service's own schema (05 §1.1). No cross-schema joins.
 *
 * `orgs` is deliberately **not** a tenant-owned table in the `@cuc/db` sense: it
 * has no `tenant_id` column, because it is what defines tenants, not data that
 * belongs to one. `scoped(ctx)` only accepts tables with a `tenant_id`
 * (`TenantOwnedTable<DB>`), so `orgs` cannot even be passed to it — it is
 * queried through `db.kysely` directly, with the org-ancestry check that would
 * normally come from `scoped(ctx)` done explicitly in the repository instead
 * (05 §2.5: "reseller-level queries scope by reseller_id"). See
 * `repo/org.repo.ts` for where and why.
 */
export interface OrgServiceDb extends EventTables {
  orgs: {
    id: string;
    type: OrgType;
    /** Null only for the master. */
    parent_id: string | null;
    /**
     * Denormalized owning reseller. Null for master and reseller rows; set for
     * every tenant row, since tenants cannot be re-parented in v1 (02 §1) and
     * this is what lets a reseller-scoped query filter without a join.
     */
    reseller_id: string | null;
    /** Lowercase DNS label, globally unique, reserved 90 days after deletion (02 §3). */
    slug: string;
    name: string;
    status: OrgStatus;
    timezone: string;
    country: string;
    /** Max extensions, channels, and so on. */
    limits: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };

  /**
   * Shell tables for the domain and brand models: enough structure for the org
   * hierarchy to reference, with the business logic — verification, CRUD,
   * uniqueness enforcement — landing in S1-03 and S1-04. Expanding them with
   * more nullable columns later is a compatible migration (rule 7); this is
   * not a design that will need to change shape, only to grow.
   */
  reseller_base_domains: {
    id: string;
    reseller_id: string;
    fqdn: string;
    verification_token: string;
    verified_at: Date | null;
    status: BaseDomainStatus;
    created_at: Date;
    updated_at: Date;
  };

  tenant_domains: {
    id: string;
    tenant_id: string;
    fqdn: string;
    is_primary: boolean;
    created_at: Date;
  };

  /** One brand per reseller (02 §5.3), fields per 02 §5.4. */
  brands: {
    reseller_id: string;
    display_name: string | null;
    primary_color: string | null;
    accent_color: string | null;
    /** S3 object keys (platform bucket) — the images themselves live in `@cuc/storage`. */
    logo_light_key: string | null;
    logo_dark_key: string | null;
    favicon_key: string | null;
    support_email: string | null;
    support_url: string | null;
    support_phone: string | null;
    email_from_name: string | null;
    /** Must pass SPF/DKIM before use (02 §5.4) — not enforced here; notification-service's concern. */
    email_from_address: string | null;
    sip_user_agent: string | null;
    legal_footer: string | null;
    created_at: Date;
    updated_at: Date;
  };

  /**
   * A certificate the platform keeps for one hostname (G-105). `private_key_enc`
   * is envelope-encrypted (07 §5); `certificate_pem` is the leaf and its chain.
   * Null until the first issue. `next_attempt_at` is the lease and retry clock.
   */
  tls_certificates: {
    fqdn: string;
    purpose: CertificatePurpose;
    /** The reseller whose proxy or console this is; null for the platform's own. */
    reseller_id: string | null;
    status: CertificateStatus;
    certificate_pem: string | null;
    private_key_enc: string | null;
    not_before: Date | null;
    not_after: Date | null;
    attempts: number;
    next_attempt_at: Date;
    last_error: string | null;
    /** Bumped each time a new certificate is stored, so a consumer can tell it changed. */
    version: number;
    created_at: Date;
    updated_at: Date;
  };

  /** The answer to an HTTP-01 challenge, served by the edge on port 80 until it expires. */
  acme_challenges: {
    token: string;
    fqdn: string;
    key_authorization: string;
    expires_at: Date;
    created_at: Date;
  };

  /** The ACME account per directory (the key is envelope-encrypted). */
  acme_accounts: {
    directory_url: string;
    account_key_enc: string;
    account_url: string | null;
    created_at: Date;
  };

  /** A reseller's branded console hostname (`portal.reseller-brand.com`), driving brand resolution (02 §5.2). */
  console_hostnames: {
    fqdn: string;
    reseller_id: string;
    tls_status: string;
    created_at: Date;
  };
}

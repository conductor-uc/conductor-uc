import type { EventTables } from '@cuc/events';

/**
 * telephony-config's own schema (05 §3, extending it: this service was not
 * in the initial catalogue's table listing since it is new in S1-12).
 *
 * This is a read model, not a source of truth (05 §1.1: "a service that
 * needs another service's data ... keeps a local read model built from
 * events ... because it's on the call-setup hot path"). Every row here is
 * derived from an `org.*`/`pbx.*` event or a reconciliation pass against the
 * owning service — nothing is ever written here by a public API, because
 * this service exposes none.
 *
 * `tenants`/`domains`/`extensions` intentionally carry only the columns
 * S1-12's projection needs (the `opensips` schema's `domain` and
 * `subscriber` tables) — not the fuller shape org-service or
 * pbx-config-service own. `number`/`display_name`/timezone and so on have
 * no reader here yet; S1-13 (xml_curl directory/dialplan) is what adds them,
 * the same incremental-schema-growth pattern pbx-config-service's own
 * schema.ts documents.
 */
export interface TelephonyConfigDb extends EventTables {
  tenants: {
    /** An org-service org id (`orgId` from `org.tenant.*`). */
    id: string;
    status: 'active' | 'suspended';
    created_at: Date;
    updated_at: Date;
  };
  /**
   * A tenant's current primary SIP domain. At most one row per tenant
   * (`tenant_id` is uniquely indexed) — 02 §3 describes exactly one primary
   * domain per tenant, and a later `org.domain.added` for the same tenant
   * (a domain change) replaces this row rather than adding a second one.
   */
  domains: {
    /** org-service's `tenant_domains.id` (`domainId` from `org.domain.added`). */
    id: string;
    tenant_id: string;
    fqdn: string;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * What `opensips.subscriber` was last projected from, plus the extension's
   * current dialable `number` (S1-13, migration 002). `username`/`realm`
   * mirror `sip_credentials.username`/`.realm` at the time they were last
   * fetched — not necessarily the extension's *current* dialable number:
   * pbx-config-service's own `update()` never touches `sip_credentials` when
   * only `number` changes (a device's SIP username does not change just
   * because its dialable number does), so `username` can outlive a later
   * renumbering. That is `subscriber.username`'s real value too, so
   * `username`/`ha1`/`realm` stay byte-for-byte what is actually projected.
   * `number` is fetched and stored separately for exactly the case
   * `username` cannot cover: `/fs/dialplan`'s ext→ext lookup, which must
   * match the number a caller actually dials, not the frozen SIP identity.
   */
  extensions: {
    id: string;
    tenant_id: string;
    number: string;
    username: string;
    ha1: string;
    realm: string;
    created_at: Date;
    updated_at: Date;
  };
}

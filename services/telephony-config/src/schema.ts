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
  /**
   * The desired state `reconcile.ts` diffs `opensips.registrant`/`address`
   * against (S2-02) — kept current by `consumers/trunk.consumer.ts`, the
   * same "local mirror is the trusted desired state" pattern `extensions`
   * above already establishes.
   *
   * `secret` is the plaintext register credential, not encrypted here: an
   * unavoidable consequence of what it is projected into — OpenSIPs'
   * `uac_registrant` module stores `registrant.password` as plaintext too
   * (it answers the carrier's own digest challenges itself; there is no
   * HA1-equivalent precompute for a trunk the way `sip_credentials` has for
   * an extension) — so this mirror can be no more protected than the table
   * it exists to repair drift against. Fetched from trunk-service's
   * internal API (`src/trunk-config-client.ts`), which is itself a second
   * `:reveal`-equivalent path, gated the same way (S2-02).
   */
  trunks: {
    id: string;
    tenant_id: string;
    name: string;
    auth_mode: string;
    host: string;
    port: number;
    transport: string;
    username: string | null;
    secret: string | null;
    from_domain: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
  };
  /** Mirrors trunk-service's own `trunk_ips` (1:N — `extensions`' flat-row shape cannot represent this). */
  trunk_ips: {
    id: string;
    trunk_id: string;
    cidr: string;
    created_at: Date;
  };
}

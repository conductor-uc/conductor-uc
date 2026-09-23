import type { Generated } from '@cuc/db';
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
    /**
     * ISO 3166-1 alpha-2, org-service's own `orgs.country` (S2-04) — the
     * default region `domain/e164.ts` normalizes an outbound-dialed number
     * against. Fetched once via `org-client.ts` when `org.tenant.created`
     * fires; null for a tenant created before this column existed, or if
     * that fetch ever failed (no retry/backfill exists yet — a gap,
     * docs/decisions.md).
     */
    country: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * A stable, small per-tenant integer (S2-04) — what OpenSIPs' `route{}`
   * passes explicitly as `do_routing()`'s `groupID` argument (via the
   * `X-Dr-Group-Id` header `xml.ts`'s outbound dialplan document sets), and
   * what `dr_rules.groupid` is projected from (`projection.ts`). A UUID
   * `tenant_id` cannot go directly into that column (`drouting`'s own
   * vendored schema types it a plain `INT`) — this table exists solely to
   * hand out one via `AUTO_INCREMENT`, never touched by anything but that.
   */
  tenant_dr_groups: {
    dr_group_id: Generated<number>;
    tenant_id: string;
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
    /**
     * The extension's own caller-ID override (S2-04's own precedence:
     * extension, then a bound DID, then the trunk's policy — `projection.ts`'s
     * `resolveOutboundCallerId`). Null means "no override at this tier."
     */
    caller_id_name: string | null;
    caller_id_number: string | null;
    /** S2-06 (G-1) — an `emergency_locations` id, pbx-config-service's own. Never re-resolved to a full address here; `pbx-config-client.ts`'s `findEmergencyLocation` does that live, at the moment an emergency call needs it. */
    emergency_location_id: string;
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
    /** S2-04's caller-ID precedence, third tier (G-22) — flattened from trunk-service's `{name, number}` `caller_id_policy`. */
    caller_id_name: string | null;
    caller_id_number: string | null;
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
  /**
   * S2-03's own local mirror of pbx-config-service's `dids` table — what
   * `/fs/dialplan`'s from-trunk lookup resolves against (03 §3.2's "from-
   * trunk: DID → destination"). Unlike `registrant`/`address`, a DID has no
   * `opensips` schema counterpart at all: routing a DID to its destination
   * is entirely FS's own dialplan decision, not anything OpenSIPs' script
   * needs to know about, so this table exists only here and is never
   * diffed by `reconcile.ts` against a projected OpenSIPs table (there is
   * none) — the same "list everything" gap `reconcile.ts` already has for
   * org-service/pbx-config-service applies here too (docs/decisions.md G-16).
   */
  dids: {
    id: string;
    tenant_id: string;
    e164: string;
    trunk_id: string;
    destination_type: string;
    destination_id: string;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * S2-04's own local mirror of trunk-service's `outbound_routes` (05 §3.4)
   * — what `dr_rules` is projected from (`projection.ts`'s `projectOutboundRoute`)
   * and what `/fs/dialplan`'s outbound branch matches a normalized dialed
   * number against, the same "local read model on the call-setup hot path"
   * story `trunks` above already tells.
   */
  outbound_routes: {
    id: string;
    tenant_id: string;
    priority: number;
    pattern: string;
    /** JSON array of trunk ids, in try-order — same driver-parsing quirk `trunks.secret` etc. never hit, since this one really is JSON. */
    trunk_ids: string;
    strip: number;
    prepend: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * S2-06 (G-1) — trunk-service's own singleton mirrored locally, the same
   * "local read model on the call-setup hot path" story `outbound_routes`
   * tells: `/fs/dialplan` checks a dialed number against this *before*
   * anything else (channel limits, international policy, normal outbound
   * routing), all of which an emergency call must bypass.
   */
  emergency_routes: {
    id: string;
    tenant_id: string;
    trunk_id: string;
    /** JSON array of direct-dial numbers, e.g. `["911"]`. */
    numbers: string;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * S2-08's own local mirror of pbx-config-service's `ring_groups` — what
   * `/fs/dialplan`'s from-trunk lookup resolves against when a DID's
   * `destination_type` is `ring_group`, the same "local read model on the
   * call-setup hot path" story `dids` above already tells. `member_
   * extension_ids` is a JSON array (as text), in ring order — the round-robin
   * counter itself lives in Redis, not here (`main.ts`'s `redisClient`).
   */
  ring_groups: {
    id: string;
    tenant_id: string;
    label: string;
    strategy: string;
    member_extension_ids: string;
    ring_timeout_seconds: number;
    no_answer_destination_type: string | null;
    no_answer_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /** S2-13's own local mirror of pbx-config-service's `queues` — what `/fs/configuration`'s `callcenter.conf` builder and `/fs/dialplan`'s from-trunk `queue` branch both resolve against. */
  queues: {
    id: string;
    tenant_id: string;
    label: string;
    strategy: string;
    moh_media_asset_id: string | null;
    max_wait_seconds: number;
    announce_position: boolean;
    announce_frequency_seconds: number | null;
    no_agent_destination_type: string | null;
    no_agent_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /** S2-13's own local mirror of pbx-config-service's `agents`. */
  agents: {
    id: string;
    tenant_id: string;
    extension_id: string;
    max_no_answer: number;
    wrap_up_seconds: number;
    reject_delay_seconds: number;
    created_at: Date;
    updated_at: Date;
  };
  /** S2-13's own local mirror of pbx-config-service's `queue_tiers`. */
  queue_tiers: {
    id: string;
    tenant_id: string;
    queue_id: string;
    agent_id: string;
    level: number;
    position: number;
  };
  /** S2-14's own local mirror of pbx-config-service's `parking_lots`. */
  parking_lots: {
    id: string;
    tenant_id: string;
    label: string;
    slot_start: number;
    slot_end: number;
    timeout_seconds: number;
    return_destination_type: string | null;
    return_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * S2-15's own local mirror of pbx-config-service's `conference_rooms` —
   * no `pin_enc` here (`010_add_conference_rooms.ts`'s own comment on why),
   * just the `pin_required` bit `conference.lua` needs to decide whether to
   * prompt at all.
   */
  conference_rooms: {
    id: string;
    tenant_id: string;
    label: string;
    number: string;
    pin_required: boolean;
    max_members: number;
    created_at: Date;
    updated_at: Date;
  };
}

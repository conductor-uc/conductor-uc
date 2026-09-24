import type { Generated } from 'kysely';

/**
 * The `opensips` schema tables this service projects into (S1-12's `domain`/
 * `subscriber`; S2-02 adds `registrant`/`address`/`dr_gateways`; S2-04 adds
 * `dr_rules` — trunk-service's projection, per 06's telephony-config
 * section). `dr_groups` is still not projected: `do_routing()`'s own
 * `groupID` parameter turned out to be compile-time-only (confirmed live —
 * passing a runtime pvar fails config parsing, "Variable in param [1] is
 * not an integer", despite `README.drouting` documenting it as a plain
 * `(int, optional)`), which rules out communicating a per-call tenant group
 * id through it *or* through `dr_groups`' own (username, domain)-keyed
 * auto-detection (rejected anyway: the caller identity on an FS-originated
 * outbound leg is not guaranteed to be a real registered subscriber's own
 * AOR). Tenant isolation instead lives in `$rU` itself — `route{}`'s
 * outbound branch calls `do_routing()` with the group param omitted (a
 * single shared `default_group`, modparam), and FS's own outbound dialplan
 * document (`xml.ts`'s `buildOutboundDialplanDocument`) prepends the
 * tenant's own `tenant_dr_groups.dr_group_id` — zero-padded to
 * `opensips-projection.repo.ts`'s `DR_TAG_WIDTH` — to the dialed number
 * before the re-INVITE ever reaches OpenSIPs, so the prefix trie can only
 * ever match that tenant's own `dr_rules` rows. Resolves docs/decisions.md
 * G-23.
 *
 * Column shapes are copied from OpenSIPs' own vendored table definitions
 * (`telephony/opensips/db-schema/{domain,auth_db,registrant,drouting,
 * permissions}-create.sql`) — this file describes an existing schema for
 * Kysely, it does not create one. `opensips`'s tables are provisioned by
 * `infra/compose/mariadb/init/02-opensips-schema.sh` (S1-11), not by this
 * service's own migrations: 05 §1.1 says telephony-config *writes* the
 * schema, not that it owns the DDL, and staying byte-identical to what
 * OpenSIPs ships is why S1-11 vendored those files verbatim in the first
 * place.
 */
export interface OpenSipsDb {
  /**
   * OpenSIPs' `tls_mgm` table (G-105): the TLS certificates it presents, one row per
   * SIP proxy hostname, chosen by the name a client asks for (SNI). `type` is 2 for a
   * *server* domain (1 is a client domain: the opposite of what one would guess, found
   * against a real OpenSIPs). `certificate` and `private_key` are PEM text, in the
   * clear, because that is how OpenSIPs loads them from the database.
   */
  tls_mgm: {
    id: Generated<number>;
    domain: string;
    match_ip_address: string | null;
    match_sip_domain: string | null;
    type: number;
    method: string | null;
    verify_cert: number | null;
    require_cert: number | null;
    certificate: string | null;
    private_key: string | null;
    cipher_list: string | null;
  };
  domain: {
    id: Generated<number>;
    domain: string;
    attrs: string | null;
    accept_subdomain: number;
    last_modified: Date;
  };
  subscriber: {
    id: Generated<number>;
    username: string;
    domain: string;
    password: string;
    ha1: string;
    ha1_sha256: string;
    ha1_sha512t256: string;
  };
  /**
   * `uac_registrant`'s own table (S2-02; 03 §1: "Owns (`uac_registrant`,
   * clustered)"). One row per register-mode trunk. `username`/`password`
   * are the trunk's plaintext register credential — the module answers the
   * carrier's own digest challenges itself, unlike `auth_db`'s HA1 scheme.
   * `state` is the module's own runtime field (never written by this
   * service) — `reg_list`'s MI output is how `opensips-mi-client.ts` reads
   * it back for trunk-status (S2-02).
   */
  registrant: {
    id: Generated<number>;
    /** The carrier's registrar URI, e.g. `sip:carrier.example.com`. */
    registrar: string;
    proxy: string | null;
    /** The AOR OpenSIPs registers as — `sip:{trunk.username}@{trunk.fromDomain ?? trunk.host}`. */
    aor: string;
    third_party_registrant: string | null;
    username: string | null;
    password: string | null;
    binding_uri: string;
    binding_params: string | null;
    expiry: number | null;
    forced_socket: string | null;
    cluster_shtag: string | null;
    state: number;
  };
  /**
   * `permissions`' own table (S2-02; 03 §1: "Owns (`permissions` address
   * table + registrant contact match)") — inbound trunk identification by
   * source IP. One row per `trunk_ips` CIDR. `grp` matches
   * `opensips.cfg.template`'s `check_source_address(1)` call site — every
   * projected row uses group 1 (no per-tenant grouping at the `permissions`
   * level; the tenant is recovered from `context_info`, not `grp`).
   */
  address: {
    id: Generated<number>;
    grp: number;
    ip: string;
    mask: number;
    port: number;
    proto: string;
    pattern: string | null;
    /** The owning trunk's id — what `route{}` reads back after a match (03 §2's header-setting story). */
    context_info: string | null;
  };
  /**
   * `drouting`'s gateway table (S2-02; 03 §1: "Owns (`drouting`, one rule
   * group per tenant)"). One row per trunk — `gwid` is the trunk's id,
   * `address` is `host:port`.
   */
  dr_gateways: {
    id: Generated<number>;
    gwid: string;
    type: number;
    address: string;
    strip: number;
    pri_prefix: string | null;
    attrs: string | null;
    probe_mode: number;
    state: number;
    socket: string | null;
    description: string | null;
  };
  /**
   * `drouting`'s rule table (S2-04; 03 §1: "Owns (`drouting`, one rule
   * group per tenant)"). One row per outbound route — `groupid` is the
   * tenant's own `tenant_dr_groups.dr_group_id` (a plain int; the column
   * cannot hold a UUID `tenant_id` directly), `prefix` is the route's own
   * E.164 prefix pattern, `gwlist` is the route's `trunk_ids`, comma-joined
   * in try-order (`sort_alg` stays `'N'`, the vendored default — "use the
   * given order", exactly the failover sequence 03 §2.1 calls for). `attrs`
   * carries `strip:prepend`, read back via `do_routing()`'s own
   * `rule_attrs_pvar` output and applied to `$rU` in script before relaying.
   */
  dr_rules: {
    ruleid: Generated<number>;
    groupid: string;
    prefix: string;
    timerec: string | null;
    priority: number;
    routeid: string | null;
    gwlist: string | null;
    sort_alg: string;
    sort_profile: number | null;
    attrs: string | null;
    description: string | null;
  };
}

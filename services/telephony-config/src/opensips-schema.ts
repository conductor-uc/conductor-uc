import type { Generated } from 'kysely';

/**
 * The `opensips` schema tables this service projects into (S1-12's `domain`/
 * `subscriber`; S2-02 adds `registrant`/`address`/`dr_gateways` — trunk-
 * service's projection, per 06's telephony-config section). `dr_rules` and
 * `dr_groups` are not projected yet: `dr_rules`' content (prefix, priority,
 * gateway order) comes from a tenant's *outbound routes*, which trunk-service
 * does not own until S2-04, and `dr_groups`' own keying (which `username`/
 * `domain` pair `do_routing()`'s group-selection matches against) is
 * inseparable from the outbound-call `route{}` branch S2-04 also owns —
 * see docs/decisions.md G-23. `dr_gateways` has no such dependency (one row
 * per trunk, independent of how a tenant's calls get routed to it), so it
 * is projected now.
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
}

import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (05 §3.4). No cross-schema joins (05 §1.1).
 */
export interface TrunkServiceDb extends EventTables {
  trunks: {
    id: string;
    /** Present on every tenant-owned table, indexed first (05 §2.1). */
    tenant_id: string;
    /**
     * Denormalized from org-service at creation time (`src/org-client.ts`),
     * so a reseller-scoped trunk list needs no cross-schema join (05 §1.1).
     */
    reseller_id: string;
    name: string;
    /** `register`: outbound registration to a carrier. `ip`: inbound source-IP identification. `both`: both. */
    auth_mode: string;
    host: string;
    port: number;
    transport: string;
    /** Register auth username. Null when `auth_mode` is `ip`. */
    username: string | null;
    /** Envelope-encrypted register auth secret (07 §5). Null when `auth_mode` is `ip`. */
    secret_enc: string | null;
    /** SIP domain used in the From header / registration AOR. Null when `auth_mode` is `ip`. */
    from_domain: string | null;
    /** JSON array of codec names, in preference order. */
    codecs: string;
    /** Null means no platform-enforced limit for this trunk. */
    max_channels: number | null;
    /** JSON `{ name, number }` — the trunk's own caller-ID fallback (S2-04 decides final precedence). Null means none set. */
    caller_id_policy: string | null;
    status: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  trunk_ips: {
    id: string;
    /** Denormalized from `trunks.tenant_id` so `scoped(ctx)` works on this table directly (`@cuc/db`'s `TenantOwnedTable` constraint). */
    tenant_id: string;
    trunk_id: string;
    /** IPv4 or IPv6 CIDR, used for inbound trunk identification. */
    cidr: string;
    created_at: Date;
  };
  /**
   * S2-04 (05 §3.4). `pattern` is an E.164 prefix, not a full regex —
   * `domain/outbound-route.ts`'s own comment on why. `trunk_ids` is a JSON
   * array, ordered (failover sequence, 03 §2.1) — `dr_rules.gwlist` is
   * exactly this list, comma-joined, once projected (S2-04's `projection.ts`).
   */
  outbound_routes: {
    id: string;
    tenant_id: string;
    priority: number;
    pattern: string;
    /** JSON array of trunk ids, in try-order. */
    trunk_ids: string;
    strip: number;
    /** Null means prepend nothing. */
    prepend: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * S2-06 (05 §3.4, G-1) — one row per tenant (`emergency_routes_tenant_idx`
   * unique), a single dedicated trunk for every emergency number: no
   * `priority`/`strip`/`prepend`/ordered-failover-chain the way
   * `outbound_routes` has, since G-1's own scope names exactly one trunk
   * ("a priority emergency route"), not several.
   */
  emergency_routes: {
    id: string;
    tenant_id: string;
    trunk_id: string;
    /** JSON array of direct-dial emergency numbers, e.g. `["911"]`. */
    numbers: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}

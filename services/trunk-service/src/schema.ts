import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (05 §3.4). No cross-schema joins (05 §1.1).
 *
 * Only `trunks` and `trunk_ips` — 05 §3.4 also lists `outbound_routes` and
 * `emergency_routes` under trunk-service, but S2-01's scope is trunk CRUD,
 * IPs, and credentials only; those two tables arrive with S2-04 and S2-06.
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
}

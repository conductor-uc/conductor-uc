import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (05 §3.3). No cross-schema joins (05 §1.1):
 * `user_id` names an identity-service user by id only.
 *
 * Only the columns S1-09 actually gives meaning to. 05 §3.3's `extensions`
 * row also lists `forwarding`, `dnd`, and `max_concurrent` — call-control
 * state nothing in this service reads or writes yet. Adding them now with no
 * code behind them would be schema for its own sake; a later migration is a
 * compatible expansion, the same way org-service's brand/domain tables grew
 * across S1-03/S1-04 rather than being pre-built in S1-01.
 *
 * `emergency_location_id` (S2-06; G-1) is *not* one of those deferred
 * columns: issue #96 requires a dispatchable location before an extension
 * can be created at all, so it lands with real code behind it now.
 */
export interface PbxConfigServiceDb extends EventTables {
  extensions: {
    id: string;
    /** Present on every tenant-owned table, indexed first (05 §2.1). */
    tenant_id: string;
    number: string;
    /** An identity-service user id. Null for an extension with no owning user (a shared lobby phone). */
    user_id: string | null;
    display_name: string;
    caller_id_name: string | null;
    caller_id_number: string | null;
    voicemail_enabled: boolean;
    /** A `emergency_locations` row in this same tenant — required (S2-06; G-1: "cannot be created without one"). */
    emergency_location_id: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * A dispatchable civic address (S2-06; G-1/issue #96: US and Canada in
   * scope for v1) — its own resource, not inlined onto `extensions`, so
   * one location can be shared across every extension at the same site
   * (issue #96's own "Site" hint; not a dedicated grouping concept yet,
   * just the natural consequence of a location being its own row a
   * `emergency_location_id` can point more than one extension at).
   */
  emergency_locations: {
    id: string;
    tenant_id: string;
    /** A human-readable name for picking the right one at extension-creation time, e.g. "Main Office - 3rd Floor". */
    label: string;
    address_line1: string;
    address_line2: string | null;
    city: string;
    /** State/province code (05's own "USA and Canada" scope, per issue #96). */
    state: string;
    postal_code: string;
    /** `'US'` or `'CA'` (issue #96's own v1 scope) — `domain/emergency-location.ts` is what enforces this, not the column type. */
    country: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  sip_credentials: {
    id: string;
    tenant_id: string;
    /** One credential per extension (1:1) — the unique index in the migration enforces it. */
    extension_id: string;
    username: string;
    /** Envelope-encrypted (07 §5). Decrypted only by the `:reveal` action. */
    secret_enc: string;
    /** `MD5(username:realm:password)` — recomputed whenever `realm` changes. */
    ha1: string;
    /** `MD5(username@realm:realm:password)` — some UAs authenticate with the domain in the username. */
    ha1b: string;
    /** The tenant's SIP domain at the time these were last computed (02 §3). */
    realm: string;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * S2-03 (05 §3.3). `sms_enabled`/`fax_enabled` are not modeled yet — no
   * service reads or writes them through S2-03 (`domain/dids.ts`'s own
   * comment on why), the same incremental-schema-growth pattern `extensions`
   * above already establishes.
   */
  dids: {
    id: string;
    tenant_id: string;
    /** E.164, globally unique across every tenant (`dids_e164_idx`). */
    e164: string;
    /** A trunk-service trunk id. Not a local FK: trunk-service is a different service (05 §1.1). */
    trunk_id: string;
    destination_type: string;
    /** An id in whatever table `destination_type` names — `extensions.id` when `destination_type` is `'extension'`. */
    destination_id: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}

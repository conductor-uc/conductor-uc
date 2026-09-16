import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (05 §3.3). No cross-schema joins (05 §1.1):
 * `user_id` names an identity-service user by id only.
 *
 * Only the columns S1-09 actually gives meaning to. 05 §3.3's `extensions`
 * row also lists `forwarding`, `dnd`, `max_concurrent`, and
 * `emergency_location_id` — call-routing state nothing in this service reads
 * or writes yet (call-control and G-1 respectively). Adding them now with no
 * code behind them would be schema for its own sake; a later migration is a
 * compatible expansion, the same way org-service's brand/domain tables grew
 * across S1-03/S1-04 rather than being pre-built in S1-01.
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

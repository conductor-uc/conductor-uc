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
  /**
   * A tenant-uploaded prompt/MOH/greeting (S2-07; 05 §3.3, G-5). `status`
   * walks `pending` (row created, presigned PUT handed out) ->
   * `processing` (client called `:finalize`, `pbx.media_asset.finalize_requested`
   * enqueued) -> `ready` | `failed` (the transcode worker's own callback,
   * `internal.routes.ts`'s `:complete`/`:fail`) — `domain/media-asset.ts`
   * owns the actual transition rules. `object_key` is the tenant's own raw
   * upload; `variant_8k_key`/`variant_16k_key` are null until `ready`.
   */
  media_assets: {
    id: string;
    tenant_id: string;
    /** `'prompt' | 'moh' | 'greeting'` — `domain/media-asset.ts` owns the enum. */
    kind: string;
    label: string;
    status: string;
    /** The raw upload's own declared content type (e.g. `audio/mpeg`) — what `presignPut` advertised, not verified against the actual bytes here. */
    content_type: string;
    object_key: string;
    variant_8k_key: string | null;
    variant_16k_key: string | null;
    duration_ms: number | null;
    sha256: string | null;
    size_bytes: number | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * A ring/hunt group (S2-08; 05 §3.3). A DID's `destination_type` can name
   * one of these the same way it names an `extensions` row (`domain/dids.ts`'s
   * `DESTINATION_TYPES`). `member_extension_ids` is a JSON array, in ring
   * order — the same "ordered list as a JSON column, not a join table"
   * choice trunk-service's own `outbound_routes.trunk_ids` already made
   * (`repo/outbound-route.repo.ts`'s `parseTrunkIds`).
   */
  ring_groups: {
    id: string;
    tenant_id: string;
    label: string;
    /** `'simultaneous' | 'sequential' | 'round_robin' | 'random'` — `domain/ring-group.ts` owns the enum. */
    strategy: string;
    /** JSON array of `extensions.id`, in ring order. */
    member_extension_ids: string;
    ring_timeout_seconds: number;
    /** Same `DestinationType` union `dids.destination_type` uses — null means "no fallback, just stop ringing". */
    no_answer_destination_type: string | null;
    no_answer_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * A queue's config (S2-13; `mod_callcenter`) — `domain/queue.ts` owns the
   * `strategy` enum. `moh_media_asset_id` names a `media_assets.id` in this
   * tenant; null means FS's own default hold music, not "no MOH".
   */
  queues: {
    id: string;
    tenant_id: string;
    label: string;
    strategy: string;
    moh_media_asset_id: string | null;
    /** 0 = unlimited (mod_callcenter's own convention). */
    max_wait_seconds: number;
    announce_position: boolean;
    announce_frequency_seconds: number | null;
    /** Same `DestinationType` union as `ring_groups.no_answer_destination_type` — where an abandoned/overflowed caller goes. */
    no_agent_destination_type: string | null;
    no_agent_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * An agent identity (S2-13) — one row per extension acting as an agent,
   * `extension_id` unique per tenant (`006_add_queues.ts`'s own comment on
   * why live status is deliberately not a column here).
   */
  agents: {
    id: string;
    tenant_id: string;
    extension_id: string;
    max_no_answer: number;
    wrap_up_seconds: number;
    reject_delay_seconds: number;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /** The queue<->agent many-to-many join (S2-13), one row per tier assignment — `(queue_id, agent_id)` unique. */
  queue_tiers: {
    id: string;
    tenant_id: string;
    queue_id: string;
    agent_id: string;
    level: number;
    position: number;
    created_at: Date;
  };
  /**
   * A parking lot (S2-14; `mod_valet_parking`). `slot_start`/`slot_end` is
   * the inclusive numeric range a caller dials to park or retrieve — see
   * `007_add_parking_lots.ts`'s own comment on why park/retrieve share one
   * dialplan action and need no separate table.
   */
  parking_lots: {
    id: string;
    tenant_id: string;
    label: string;
    slot_start: number;
    slot_end: number;
    timeout_seconds: number;
    /** Same `DestinationType` union as `queues.no_agent_destination_type` — null means `mod_valet_parking`'s own default (ring back whoever parked it). */
    return_destination_type: string | null;
    return_destination_id: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * A provisioned desk phone (see `010_add_devices.ts`). `mac` is unique across
   * tenants; `token_hash` is the SHA-256 of the provisioning password, null
   * until one is issued.
   */
  devices: {
    id: string;
    tenant_id: string;
    extension_id: string;
    vendor: string;
    model: string | null;
    mac: string;
    label: string | null;
    token_hash: string | null;
    last_provisioned_at: Date | null;
    last_seen_ip: string | null;
    last_user_agent: string | null;
    created_at: Date;
    updated_at: Date;
  };
  /**
   * A schedule (S3-08; 05 §3.3): open hours as weekly windows plus holiday
   * dates, evaluated in `timezone`. `rules` and `holidays` hold what
   * `domain/schedule.ts` validates, as parsed JSON or JSON text depending on
   * the driver.
   */
  schedules: {
    id: string;
    tenant_id: string;
    label: string;
    timezone: string;
    rules: unknown;
    holidays: unknown;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * Per-extension call handling (parity 1a; `011_add_extension_call_handling.ts`),
   * 1:1 with `extensions`. The destination columns hold a
   * `domain/call-handling.ts` `Destination` as JSON (parsed or text depending
   * on the driver); `simultaneous_ring` a JSON array of them.
   */
  extension_call_handling: {
    extension_id: string;
    tenant_id: string;
    dnd: boolean;
    dnd_action: string;
    forward_always: unknown;
    forward_busy: unknown;
    forward_no_answer: unknown;
    no_answer_seconds: number;
    forward_unreachable: unknown;
    simultaneous_ring: unknown;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  /**
   * A conference room (S2-15; `mod_conference`). `pin_enc` is envelope-
   * encrypted (07 §5) — null means no PIN required. `video` records intent
   * only; see `008_add_conference_rooms.ts`'s own comment on why it has no
   * effect yet.
   */
  conference_rooms: {
    id: string;
    tenant_id: string;
    label: string;
    number: string;
    pin_enc: string | null;
    video: boolean;
    layout: string | null;
    max_members: number;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}

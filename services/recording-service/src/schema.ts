import type { EventTables } from '@cuc/events';

/**
 * recording-service's own schema (S5-01, S5-04, S5-05; 06's recording-service
 * section). Ids of other services' rows (`extension_id`, `queue_id`, `did_id`,
 * `consent_asset_id`) are plain strings with no cross-schema join (05 §1.1).
 */
export interface RecordingServiceDb extends EventTables {
  recording_policies: {
    id: string;
    tenant_id: string;
    /** `tenant`, `extension`, `agent` (S5-14: an extension as a queue agent), `queue` or `did`. */
    scope_type: string;
    /** The extension, queue or DID id; for scope `tenant`, the tenant's own id. */
    scope_id: string;
    /** `any`, `inbound`, `outbound` or `internal`. */
    direction: string;
    /** `record` or `no_record`. */
    action: string;
    /** Play a consent announcement before recording starts (07 §6, O-12). */
    announce: boolean;
    /** A media asset (pbx-config-service) to play; null plays the neutral default tone. */
    consent_asset_id: string | null;
    /** S5-13: feature codes may start/stop (no_record) or pause/resume (record) on its calls. */
    allow_on_demand: boolean;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  recordings: {
    /** Opaque and random. It is also the spool file name, so it names nothing about the tenant or the call. */
    id: string;
    tenant_id: string;
    call_uuid: string;
    /** The extension on the call: the caller for internal and outbound calls, the callee for inbound. */
    extension_id: string | null;
    /** The other extension on an internal call. */
    peer_extension_id: string | null;
    queue_id: string | null;
    did_id: string | null;
    direction: string;
    policy_id: string | null;
    node_id: string | null;
    /** A consent announcement was played first. */
    announced: boolean;
    /** `pending` (registered, not uploaded), `ready`, `failed` or `expired`. */
    status: string;
    object_key: string;
    content_type: string;
    started_at: Date;
    duration_ms: number | null;
    size_bytes: number | null;
    /** As reported by the uploader (05 §4: every object's row records sha256). */
    sha256: string | null;
    failure_reason: string | null;
    /** After this the retention sweep deletes the object. Null keeps it indefinitely. */
    retention_date: Date | null;
    /** S5-13: started by a feature code rather than by a rule. */
    on_demand: boolean;
    /** S5-13: when an on-demand recording was stopped by feature code. */
    stopped_at: Date | null;
    /** S5-13: JSON text, `[{ from, to }]`; an open interval (`to` null) means paused now. */
    pause_intervals: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  recording_settings: {
    tenant_id: string;
    /** 0 keeps recordings until deleted. */
    retention_days: number;
    /**
     * S5-12: refuse a call when the recording its rules may require cannot be set up (this
     * service unreachable, or the recording not registered). Off by default (fail open).
     */
    fail_closed: boolean;
    updated_at: Date;
    version: number;
  };
}

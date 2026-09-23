import type { EventTables } from '@cuc/events';

/**
 * This service's own schema (S2-18; 06's cdr-service section, CDR v1).
 *
 * `queue_id`/`flow_id`/`extension_ids` exist as columns with no extraction
 * logic behind them yet (docs/decisions.md G-51) — the same "schema for a
 * field a later task fills in" precedent `pbx-config-service/src/schema.ts`
 * sets for `extensions.forwarding`/`dnd`/`max_concurrent`.
 */
export interface CdrServiceDb extends EventTables {
  cdrs: {
    id: string;
    tenant_id: string;
    /** Denormalized at ingest time (C-1/D-013) — null if the reseller lookup failed or the tenant has none. */
    reseller_id: string | null;
    /** The A-leg's own FS channel UUID (`mod_json_cdr`'s `variables.uuid`). */
    call_uuid: string;
    /** `cuc_node_id` (vars.xml) — which FS node ingested this call. */
    node_id: string;
    direction: string;
    start_at: Date;
    answer_at: Date | null;
    end_at: Date;
    duration_sec: number;
    billable_sec: number;
    from_number: string;
    from_name: string | null;
    to_number: string;
    dialed_number: string;
    /** Set for an inbound call only. */
    did: string | null;
    trunk_id: string | null;
    /** JSON array of extension ids — always `'[]'` today (G-51). */
    extension_ids: string;
    disposition: string;
    hangup_cause: string;
    hangup_by: string;
    queue_id: string | null;
    flow_id: string | null;
    /** JSON array of recording ids — always `'[]'` until recording-service exists (S5). */
    recording_ids: string;
    /** JSON, best-effort — `mod_json_cdr`'s own `callflow` array, unparsed. */
    legs: string | null;
    /** JSON, best-effort — codec/MOS/user-agent. */
    sip: string | null;
    created_at: Date;
  };
  cdr_exports: {
    id: string;
    tenant_id: string;
    /** `'pending' | 'processing' | 'ready' | 'failed'` — `domain/export.ts` owns the enum. */
    status: string;
    from_at: Date;
    to_at: Date;
    /** Null until `status` is `'ready'`. */
    object_key: string | null;
    error_message: string | null;
    created_at: Date;
    updated_at: Date;
  };
}

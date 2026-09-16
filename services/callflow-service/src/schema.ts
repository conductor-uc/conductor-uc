import type { EventTables } from '@cuc/events';

/** This service's own schema. No cross-schema joins (05 §1.1). */
export interface CallflowServiceDb extends EventTables {
  flows: {
    id: string;
    /** Present on every tenant-owned table, indexed first (05 §2.1). */
    tenant_id: string;
    name: string;
    /** The mutable working copy — a raw `FlowGraphInput` (JSON.stringify'd). */
    draft_graph: string;
    draft_updated_at: Date;
    /** Null until the first `:publish`. FK into flow_versions, same flow. */
    current_published_version_id: string | null;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
  flow_versions: {
    id: string;
    tenant_id: string;
    flow_id: string;
    /** Monotonic per flow, starting at 1. Never reused, even across rollback. */
    version_number: number;
    /** The exact raw graph compiled to produce this version (JSON). */
    graph: string;
    /** The compiled IR flow_runner.lua actually fetches (JSON). Immutable once written. */
    ir: string;
    published_at: Date;
  };
}

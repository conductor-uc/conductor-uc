import type { EventTables } from '@cuc/events';

/** This service's own schema. No cross-schema joins (05 §1.1). */
export interface ExampleServiceDb extends EventTables {
  widgets: {
    id: string;
    /** Present on every tenant-owned table, indexed first (05 §2.1). */
    tenant_id: string;
    name: string;
    created_at: Date;
    updated_at: Date;
    version: number;
  };
}

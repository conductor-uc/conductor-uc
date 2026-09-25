import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as addRecordingTables from './002_add_recording_tables.js';
import * as addFailClosed from './003_add_fail_closed.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly (Node's `import()` cannot load
 * `.ts`, so `FileMigrationProvider`'s directory scan only works against the
 * compiled `dist/migrations/*.js` this service ships).
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_add_recording_tables': addRecordingTables,
  '003_add_fail_closed': addFailClosed,
};

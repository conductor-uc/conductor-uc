import type { Migration } from 'kysely/migration';

import * as initial from '../../migrations/001_initial.js';

/**
 * A manifest of statically imported migrations, for tests. Node's `import()`
 * cannot load `.ts`, so `FileMigrationProvider`'s directory scan only works
 * against the compiled `dist/migrations/*.js` this service ships.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
};

import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as rolesAndGrants from './002_roles_and_grants.js';
import * as auditEvents from './003_audit_events.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly.
 *
 * Node's `import()` cannot load `.ts`, so `FileMigrationProvider`'s directory
 * scan only works against the compiled `dist/migrations/*.js` this service
 * ships — which is what `src/main.ts` and the `migrate` script point at. This
 * manifest is the other path, used by `test/user.repo.test.ts`.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_roles_and_grants': rolesAndGrants,
  '003_audit_events': auditEvents,
};

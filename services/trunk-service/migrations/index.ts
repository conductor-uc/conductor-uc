import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as addOutboundRoutes from './002_add_outbound_routes.js';
import * as addEmergencyRoutes from './003_add_emergency_routes.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly.
 *
 * Node's `import()` cannot load `.ts`, so `FileMigrationProvider`'s directory
 * scan only works against the compiled `dist/migrations/*.js` this service
 * ships — which is what `src/main.ts` and the `migrate` script point at. This
 * manifest is the other path, used by the repo tests.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_add_outbound_routes': addOutboundRoutes,
  '003_add_emergency_routes': addEmergencyRoutes,
};

import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as addExtensionNumber from './002_add_extension_number.js';
import * as addTrunks from './003_add_trunks.js';
import * as addDids from './004_add_dids.js';
import * as addOutboundRouting from './005_add_outbound_routing.js';
import * as addEmergencyCalling from './006_add_emergency_calling.js';
import * as addRingGroups from './007_add_ring_groups.js';
import * as addQueues from './008_add_queues.js';
import * as addParkingLots from './009_add_parking_lots.js';

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
  '002_add_extension_number': addExtensionNumber,
  '003_add_trunks': addTrunks,
  '004_add_dids': addDids,
  '005_add_outbound_routing': addOutboundRouting,
  '006_add_emergency_calling': addEmergencyCalling,
  '007_add_ring_groups': addRingGroups,
  '008_add_queues': addQueues,
  '009_add_parking_lots': addParkingLots,
};

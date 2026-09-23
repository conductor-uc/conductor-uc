import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as addDids from './002_add_dids.js';
import * as addEmergencyLocations from './003_add_emergency_locations.js';
import * as addMediaAssets from './004_add_media_assets.js';
import * as addRingGroups from './005_add_ring_groups.js';
import * as addQueues from './006_add_queues.js';
import * as addParkingLots from './007_add_parking_lots.js';

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
  '002_add_dids': addDids,
  '003_add_emergency_locations': addEmergencyLocations,
  '004_add_media_assets': addMediaAssets,
  '005_add_ring_groups': addRingGroups,
  '006_add_queues': addQueues,
  '007_add_parking_lots': addParkingLots,
};

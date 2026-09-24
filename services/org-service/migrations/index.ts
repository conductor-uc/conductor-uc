import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as brandsAndHostnames from './002_brands_and_hostnames.js';
import * as certificates from './003_certificates.js';
import * as acmeSettings from './004_acme_settings.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly.
 *
 * Node's `import()` cannot load `.ts`, so `FileMigrationProvider`'s directory
 * scan only works against the compiled `dist/migrations/*.js` this service
 * ships — which is what `src/main.ts` and the `migrate` script point at. This
 * manifest is the other path, used by `test/org.repo.test.ts`.
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_brands_and_hostnames': brandsAndHostnames,
  '003_certificates': certificates,
  '004_acme_settings': acmeSettings,
};

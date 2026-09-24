import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as addVoicemailTables from './002_add_voicemail_tables.js';
import * as addEmailSettings from './003_add_email_settings.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly (see the identical comment
 * in pbx-config-service's own `migrations/index.ts` for why this exists
 * alongside `FileMigrationProvider`'s directory scan of compiled JS).
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_add_voicemail_tables': addVoicemailTables,
  '003_add_email_settings': addEmailSettings,
};

import type { Migration } from 'kysely/migration';

import * as initial from './001_initial.js';
import * as sentEmailsPerRecipient from './002_sent_emails_per_recipient.js';

/**
 * A manifest of statically imported migrations, for tests and anywhere else
 * that runs against TypeScript source directly (Node's `import()` cannot load
 * `.ts`, so the directory scan only works against the compiled `dist`).
 */
export const migrations: Record<string, Migration> = {
  '001_initial': initial,
  '002_sent_emails_per_recipient': sentEmailsPerRecipient,
};

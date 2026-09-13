export { createDatabase, type Database, type DatabaseOptions } from './client.js';
export { dbEnvSchema } from './config.js';
export { isDuplicateKeyError } from './errors.js';
export {
  MissingTenantContextError,
  requireTenant,
  type DbContext,
  type TenantContext,
} from './context.js';
export {
  createMigration,
  manifestMigrationProvider,
  migrateDown,
  migrateToLatest,
  migrateToNothing,
  migrateUp,
  migrationStatus,
  MigrationFailedError,
  type MigrateOptions,
  type MigrationSource,
  type MigrationStatus,
} from './migrate.js';
export {
  scopedFor,
  type ScopedDb,
  type ScopedInsertBuilder,
  type ScopedInsertValues,
  type TenantOwnedTable,
} from './scoped.js';
export {
  loggingUnscopedSink,
  MissingUnscopedReasonError,
  unscopedFor,
  type UnscopedAccess,
  type UnscopedAccessSink,
} from './unscoped.js';

// Re-exported so services build schemas and migrations against one Kysely
// version, and so `@cuc/db` stays the single place that imports it.
export type {
  ColumnType,
  Generated,
  Insertable,
  JSONColumnType,
  Kysely,
  Selectable,
  Transaction,
  Updateable,
} from 'kysely';

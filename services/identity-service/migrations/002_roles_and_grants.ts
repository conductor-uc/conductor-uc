import type { Kysely } from 'kysely';

/**
 * Every migration is backward compatible with the previous service version:
 * expand now, contract later (CLAUDE.md rule 7). This adds the roles/grants
 * schema for S1-06 without touching anything 001 created.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await db.schema
    .createTable('roles')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('name', 'varchar(128)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('roles_org_idx').on('roles').column('org_id').execute();
  // A custom role's name is unique within its own org, not globally.
  await db.schema
    .createIndex('roles_org_name_idx')
    .on('roles')
    .columns(['org_id', 'name'])
    .unique()
    .execute();

  await db.schema
    .createTable('role_permissions')
    .addColumn('role_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('permission', 'varchar(128)', (col) => col.notNull())
    .addForeignKeyConstraint('role_permissions_role_fk', ['role_id'], 'roles', ['id'])
    .execute();
  await db.schema
    .createIndex('role_permissions_pk_idx')
    .on('role_permissions')
    .columns(['role_id', 'permission'])
    .unique()
    .execute();

  await db.schema
    .createTable('role_assignments')
    .addColumn('user_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('role_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('scope_org_id', 'varchar(36)', (col) => col.notNull())
    .addForeignKeyConstraint('role_assignments_user_fk', ['user_id'], 'users', ['id'])
    .execute();
  // role_id is not a foreign key to `roles`: most assignments name a built-in
  // role id (e.g. `tenant_admin`), which is @cuc/authz data, not a row here.
  await db.schema
    .createIndex('role_assignments_pk_idx')
    .on('role_assignments')
    .columns(['user_id', 'role_id', 'scope_org_id'])
    .unique()
    .execute();
  await db.schema
    .createIndex('role_assignments_user_idx')
    .on('role_assignments')
    .column('user_id')
    .execute();

  await db.schema
    .createTable('grants')
    .addColumn('id', 'varchar(36)', (col) => col.primaryKey())
    .addColumn('org_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('principal_type', 'varchar(16)', (col) => col.notNull())
    .addColumn('principal_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('permission', 'varchar(128)', (col) => col.notNull())
    .addColumn('scope_type', 'varchar(32)', (col) => col.notNull())
    .addColumn('scope_id', 'varchar(36)', (col) => col.notNull())
    .addColumn('created_at', 'datetime(3)', (col) => col.notNull())
    .execute();
  await db.schema.createIndex('grants_org_idx').on('grants').column('org_id').execute();
  // What the evaluator actually queries by: "every grant for this principal".
  await db.schema
    .createIndex('grants_principal_idx')
    .on('grants')
    .columns(['principal_type', 'principal_id'])
    .execute();
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await db.schema.dropTable('grants').execute();
  await db.schema.dropTable('role_assignments').execute();
  await db.schema.dropTable('role_permissions').execute();
  await db.schema.dropTable('roles').execute();
}

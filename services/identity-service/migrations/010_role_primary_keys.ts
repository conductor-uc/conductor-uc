import { sql, type Kysely } from 'kysely';

/**
 * S4-07 (D-016, 10 §4.3): Galera replicates row changes by primary key. These two tables had
 * only a unique index over the same non-null columns, which InnoDB already used as the clustered
 * key; the index becomes the explicit primary key, so nothing depends on that implicit choice.
 * The unique index guarantees there are no duplicates to stop it.
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE role_permissions ADD PRIMARY KEY (role_id, permission), DROP INDEX role_permissions_pk_idx`.execute(
    db,
  );
  await sql`ALTER TABLE role_assignments ADD PRIMARY KEY (user_id, role_id, scope_org_id), DROP INDEX role_assignments_pk_idx`.execute(
    db,
  );
}

export async function down(db: Kysely<unknown>): Promise<void> {
  await sql`ALTER TABLE role_assignments ADD UNIQUE INDEX role_assignments_pk_idx (user_id, role_id, scope_org_id), DROP PRIMARY KEY`.execute(
    db,
  );
  await sql`ALTER TABLE role_permissions ADD UNIQUE INDEX role_permissions_pk_idx (role_id, permission), DROP PRIMARY KEY`.execute(
    db,
  );
}

import { sql, type Kysely } from 'kysely';

/** What the server says about itself, for the operations console (S4-12). */
export interface ServerStatus {
  /** `VERSION()`, e.g. `11.4.8-MariaDB-ubu2404`. */
  readonly version: string;
  /** `SHOW GLOBAL STATUS` for the names asked, as numbers (a missing one is absent). */
  readonly variables: Readonly<Record<string, number>>;
}

/**
 * S4-12: the MariaDB server's version and a few `SHOW GLOBAL STATUS` counters (connections,
 * queries, uptime). Raw SQL lives here rather than in a service (the lint rule). It reads no table,
 * so it needs no tenant scope, and a plain service user may run it.
 */
export async function readServerStatus<DB>(
  db: Kysely<DB>,
  names: readonly string[],
): Promise<ServerStatus> {
  const [version, status] = await Promise.all([
    sql<{ version: string }>`SELECT VERSION() AS version`.execute(db),
    names.length === 0
      ? Promise.resolve({ rows: [] as { Variable_name: string; Value: string }[] })
      : sql<{
          Variable_name: string;
          Value: string;
        }>`SHOW GLOBAL STATUS WHERE Variable_name IN (${sql.join(names.map((name) => sql.lit(name)))})`.execute(
          db,
        ),
  ]);
  const variables: Record<string, number> = {};
  for (const row of status.rows) {
    const value = Number(row.Value);
    if (Number.isFinite(value)) variables[row.Variable_name] = value;
  }
  return { version: version.rows[0]?.version ?? '', variables };
}

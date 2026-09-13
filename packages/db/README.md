# @cuc/db

Kysely over MariaDB, with tenant scoping built in. One schema and one DB user per service
(05 §1.1); no cross-schema joins and no cross-service foreign keys.

```ts
import { createDatabase, dbEnvSchema, type Generated } from '@cuc/db';

interface DB {
  extensions: {
    id: string;
    tenant_id: string;
    number: string;
    version: Generated<number>;
  };
}

const db = createDatabase<DB>({
  host: config.DB_HOST,
  port: config.DB_PORT,
  user: config.DB_USER,
  password: config.DB_PASSWORD,
  database: config.DB_NAME,
  poolSize: config.DB_POOL_SIZE,
  logger,
});

app.addReadinessCheck('db', async () => ({ status: (await db.ping()) ? 'pass' : 'fail' }));
```

## Tenant scoping

`db.scoped(ctx)` is the only way a repository reads tenant-owned data (CLAUDE.md rule 2).
Every builder comes back with the `tenant_id` predicate already applied, and inserts get
`tenant_id` set for them:

```ts
await db.scoped(ctx).insertInto('extensions').values({ id, number: '1001' }).execute();

const rows = await db.scoped(ctx).selectFrom('extensions').selectAll().execute();
//  … where `extensions`.`tenant_id` = ?
```

Three things make this hard to get wrong:

- **Only tenant-owned tables type-check.** `TenantOwnedTable<DB>` selects the tables whose row
  type has a `tenant_id`, so `scoped(ctx).selectFrom('orgs')` is a compile error rather than a
  query that filters on nothing.
- **A missing tenant throws.** `scoped(ctx)` without `ctx.tenantId` raises
  `MissingTenantContextError` instead of quietly reading every tenant's rows.
- **The predicate is qualified** (`extensions.tenant_id`), so it stays unambiguous once a
  repository joins another table that also has one.

`db.scoped(ctx).transaction(fn)` stays scoped inside the transaction, and joins an already-open
one rather than pretending MariaDB has nested transactions.

## Crossing tenants on purpose

Master and reseller dashboards and background jobs legitimately span tenants (05 §2.3):

```ts
const rows = await db
  .unscoped(ctx, 'master dashboard: tenants by status')
  .selectFrom('tenant_summaries')
  .selectAll()
  .execute();
```

The reason is mandatory — an empty one throws — and is reported to the audit sink. Until
`@cuc/audit` lands the default sink logs at `warn`, so a cross-tenant read shows up in a log
search instead of looking like any other query. Pass `onUnscopedAccess` to route it elsewhere.

## Raw SQL

Raw SQL is allowed in `migrations/` and inside this package, and nowhere else. The repository's
ESLint config enforces it: importing `sql` from `kysely`, importing `mysql2`, using a
``sql`…` `` template, or reaching into `db.kysely.executeQuery` from a service is an error that
names `scoped(ctx)` as the alternative. `packages/db/test/raw-sql-rule.test.ts` asserts the rule
still covers the paths it should.

## Migrations

```sh
pnpm exec cuc-db latest                 # apply everything pending
pnpm exec cuc-db status                 # what has run, and what has not
pnpm exec cuc-db up                     # one step forward
pnpm exec cuc-db down                   # one step back (development only)
pnpm exec cuc-db create add_extensions  # new timestamped migration
```

Run it from a package that depends on `@cuc/db` — pnpm links a package's bin into its *dependents'*
`node_modules/.bin`, not its own, so `pnpm exec cuc-db` from the repository root will not find it.
A service's own `package.json` should wrap it: `"migrate": "cuc-db latest"`.

Connection settings come from `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD`, and `DB_NAME`, and an
incomplete environment fails before a connection is attempted, listing every missing variable.
Kysely holds a lock for the run, so several instances starting at once is safe: one migrates and
the others wait.

**Every migration is backward compatible with the previous service version** — expand now,
contract in a later migration once nothing reads the old shape (rule 7). `down` exists for the
inner loop; a deployed contraction is a new forward migration, not a rollback.

Two ways to supply migrations, and the choice matters:

| Source | Use for |
|---|---|
| `dir` | The deployment path. The container runs compiled `dist/migrations/*.js` and `cuc-db` points at that folder. |
| `migrations` | An explicit manifest of statically imported modules. Required from a test runner or plain `node`, because a directory scan bottoms out in Node's own `import()`, which cannot load TypeScript. It is also the only form in which the migration list shows up in a diff. |

MariaDB has no transactional DDL, so a migration that fails part-way leaves what already
succeeded in place. `migrateToLatest` throws after reporting which ones applied.

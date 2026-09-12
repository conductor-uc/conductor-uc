# @cuc/testing

Integration-test helpers: a MariaDB to run against, and the cross-tenant probe every repository
suite is expected to carry (05 §2.4).

This package deliberately **does not depend on `@cuc/db`** — the dependency runs the other way, so
`@cuc/db` can use these helpers in its own tests without a workspace cycle. Wiring the two
together is three lines at the call site.

## A database to test against

```ts
import { silentLogger, startTestDatabase } from '@cuc/testing';
import { createDatabase, migrateToLatest } from '@cuc/db';

const handle = await startTestDatabase();
const db = createDatabase<DB>({ ...handle, logger: silentLogger() });
await migrateToLatest({ db: db.kysely, migrations, logger });
// … and in afterAll: await db.destroy(); await handle.stop();
```

Two paths, because both matter:

- **`TEST_DATABASE_URL`** points at an already-running server — the compose stack from S0-05, or a
  local install. No Docker, and the suite starts in milliseconds, which is what makes the inner
  loop usable.
- **Otherwise** a Testcontainers MariaDB 11.4 is started and shared for the process. The image
  matches production: a test that passes against a different major is not evidence about
  production.

Either way each call creates its own uniquely named schema, so suites running in parallel never
see each other's rows.

When neither is available, a suite skips rather than fails, so `pnpm test` stays usable on a
laptop with no Docker:

```ts
const skipReason = await databaseOrSkipReason();
describe.skipIf(skipReason !== undefined)('…', () => { /* … */ });
```

**CI must set `REQUIRE_DB_TESTS=1`.** `databaseOrSkipReason()` then throws instead of returning a
reason, so a runner with a broken database fails the build. Without it, the same run would report
green with every integration test silently skipped.

## The cross-tenant probe

```ts
import { crossTenantProbe } from '@cuc/testing';

crossTenantProbe({
  name: 'extensions',
  seed: (tenantId) => repo.create(ctxFor(tenantId), { number: '1001' }),
  list: (tenantId) => repo.list(ctxFor(tenantId)),
  findById: (tenantId, id) => repo.findById(ctxFor(tenantId), id),
  update: (tenantId, id) => repo.rename(ctxFor(tenantId), id, 'probed'),
  remove: (tenantId, id) => repo.remove(ctxFor(tenantId), id),
});
```

It creates a row in tenant A and one in tenant B, then drives the repository as tenant A and
checks that B's row is unreachable — by list, by primary key, by update, and by delete. Only the
capabilities you declare are probed.

**It also asserts that tenant A can see its own row.** Without that, a repository returning
nothing at all would pass every isolation check, and "returns nothing" is a far more common bug
than "returns too much".

`assertTenantIsolation` carries the logic and imports no test framework, so it can be called
directly — which is how `@cuc/db` proves the probe catches a real unscoped repository against
real MariaDB, using a deliberately broken fixture.

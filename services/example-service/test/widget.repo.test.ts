import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  crossTenantProbe,
  databaseOrSkipReason,
  silentLogger,
  startTestDatabase,
} from '@cuc/testing';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';

import { createWidgetRepo, type WidgetRepo } from '../src/repo/widget.repo.js';
import type { ExampleServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('widget repo', () => {
  let db: Database<ExampleServiceDb>;
  let repo: WidgetRepo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<ExampleServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    // A manifest, not `dir`: Node's `import()` cannot load `.ts`, so a
    // directory scan only works against compiled migrations (see
    // migrations/index.ts).
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createWidgetRepo(db);
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  it('creates and lists a widget for its own tenant', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Test Widget');

    expect(created.name).toBe('Test Widget');
    expect(await repo.list({ tenantId })).toContainEqual(created);
  });

  it('finds a widget by id', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Findable');

    expect(await repo.findById({ tenantId }, created.id)).toEqual(created);
  });

  it('returns undefined for an id that does not exist', async () => {
    expect(await repo.findById({ tenantId: randomUUID() }, randomUUID())).toBeUndefined();
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'widgets',
    seed: (tenantId) => repo.create({ tenantId }, 'Probe').then((row) => row.id),
    list: (tenantId) => repo.list({ tenantId }),
    findById: (tenantId, id) => repo.findById({ tenantId }, id),
  });
});

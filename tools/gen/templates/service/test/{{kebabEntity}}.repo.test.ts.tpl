import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  crossTenantProbe,
  databaseOrSkipReason,
  silentLogger,
  startTestDatabase,
} from '@cuc/testing';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';

import { create{{Entity}}Repo, type {{Entity}}Repo } from '../src/repo/{{kebabEntity}}.repo.js';
import type { {{Pascal}}Db } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('{{entity}} repo', () => {
  let db: Database<{{Pascal}}Db>;
  let repo: {{Entity}}Repo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<{{Pascal}}Db>({
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
    repo = create{{Entity}}Repo(db);
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  it('creates and lists a {{entity}} for its own tenant', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Test {{Entity}}');

    expect(created.name).toBe('Test {{Entity}}');
    expect(await repo.list({ tenantId })).toContainEqual(created);
  });

  it('finds a {{entity}} by id', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Findable');

    expect(await repo.findById({ tenantId }, created.id)).toEqual(created);
  });

  it('returns undefined for an id that does not exist', async () => {
    expect(await repo.findById({ tenantId: randomUUID() }, randomUUID())).toBeUndefined();
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: '{{table}}',
    seed: (tenantId) => repo.create({ tenantId }, 'Probe').then((row) => row.id),
    list: (tenantId) => repo.list({ tenantId }),
    findById: (tenantId, id) => repo.findById({ tenantId }, id),
  });
});

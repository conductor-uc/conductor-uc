import { randomUUID } from 'node:crypto';

import type { FlowGraphInput } from '@cuc/callflow-ir';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  crossTenantProbe,
  databaseOrSkipReason,
  silentLogger,
  startTestDatabase,
} from '@cuc/testing';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';

import {
  createFlowRepo,
  FlowNotFoundError,
  FlowVersionNotFoundError,
  InvalidDraftGraphError,
  type FlowRepo,
} from '../src/repo/flow.repo.js';
import type { CallflowServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();

/** A minimal, valid single-node graph: one entry point straight to a hangup. */
function validGraph(): FlowGraphInput {
  return {
    entryPoints: { main: 'hu1' },
    nodes: [{ id: 'hu1', type: 'hangup', config: {} }],
    edges: [],
  };
}

/** Missing its required 'next' port — `validateGraph`/`compileGraph` reject it. */
function invalidGraph(): FlowGraphInput {
  return {
    entryPoints: { main: 'p1' },
    nodes: [{ id: 'p1', type: 'play', config: { mediaAssetId: 'm1' } }],
    edges: [],
  };
}

describe.skipIf(skipReason !== undefined)('flow repo', () => {
  let db: Database<CallflowServiceDb>;
  let repo: FlowRepo;
  let stop: () => Promise<void>;

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<CallflowServiceDb>({
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
    repo = createFlowRepo(db);
    stop = async () => {
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  it('creates a flow with an empty, unpublished draft', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Test Flow');

    expect(created.name).toBe('Test Flow');
    expect(created.currentPublishedVersionId).toBeNull();
    expect(created.draftGraph).toEqual({ entryPoints: {}, nodes: [], edges: [] });
  });

  it('lists flows for its own tenant as summaries', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Listed Flow');

    const rows = await repo.list({ tenantId });
    expect(rows).toContainEqual({
      id: created.id,
      name: created.name,
      currentPublishedVersionId: null,
    });
  });

  it('finds a flow by id', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Findable');

    expect(await repo.findById({ tenantId }, created.id)).toEqual(created);
  });

  it('returns undefined for an id that does not exist', async () => {
    expect(await repo.findById({ tenantId: randomUUID() }, randomUUID())).toBeUndefined();
  });

  it('replaces the draft graph via updateDraft, without publishing anything', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Draft Target');
    const graph = validGraph();

    const updated = await repo.updateDraft({ tenantId }, created.id, graph);
    expect(updated.draftGraph).toEqual(graph);
    expect(updated.currentPublishedVersionId).toBeNull();

    const reFetched = await repo.findById({ tenantId }, created.id);
    expect(reFetched?.draftGraph).toEqual(graph);
  });

  it('updateDraft on an unknown flow throws FlowNotFoundError', async () => {
    await expect(
      repo.updateDraft({ tenantId: randomUUID() }, randomUUID(), validGraph()),
    ).rejects.toThrow(FlowNotFoundError);
  });

  it('validateDraft reports issues without mutating anything', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Validate Target');
    await repo.updateDraft({ tenantId }, created.id, invalidGraph());

    const issues = await repo.validateDraft({ tenantId }, created.id);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((issue) => issue.kind === 'missing_port')).toBe(true);

    // No publish happened as a side effect of validating.
    expect((await repo.findById({ tenantId }, created.id))?.currentPublishedVersionId).toBeNull();
  });

  it('validateDraft on a valid graph reports no issues', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Valid Target');
    await repo.updateDraft({ tenantId }, created.id, validGraph());

    expect(await repo.validateDraft({ tenantId }, created.id)).toEqual([]);
  });

  it('publish compiles the draft into version 1, updates the pointer, and version 1 is immutable thereafter', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Publishable');
    await repo.updateDraft({ tenantId }, created.id, validGraph());

    const version = await repo.publish({ tenantId }, created.id);
    expect(version.versionNumber).toBe(1);

    const flow = await repo.findById({ tenantId }, created.id);
    expect(flow?.currentPublishedVersionId).toBe(version.id);

    const ir = await repo.findPublishedIr({ tenantId }, created.id);
    expect(ir?.nodes['hu1']).toEqual({ id: 'hu1', type: 'hangup', config: {}, ports: {} });

    // Changing the draft afterward must not touch the already-published version's IR.
    await repo.updateDraft({ tenantId }, created.id, {
      entryPoints: { main: 'hu2' },
      nodes: [{ id: 'hu2', type: 'hangup', config: {} }],
      edges: [],
    });
    const irAfterDraftChange = await repo.findPublishedIr({ tenantId }, created.id);
    expect(irAfterDraftChange).toEqual(ir);
  });

  it('publish refuses an invalid draft and does not create a version or move the pointer', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Unpublishable');
    await repo.updateDraft({ tenantId }, created.id, invalidGraph());

    await expect(repo.publish({ tenantId }, created.id)).rejects.toThrow(InvalidDraftGraphError);
    expect((await repo.findById({ tenantId }, created.id))?.currentPublishedVersionId).toBeNull();
  });

  it('publishing twice produces monotonically increasing version numbers, never reused', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Multi-version');
    await repo.updateDraft({ tenantId }, created.id, validGraph());
    const v1 = await repo.publish({ tenantId }, created.id);

    await repo.updateDraft({ tenantId }, created.id, {
      entryPoints: { main: 'hu2' },
      nodes: [{ id: 'hu2', type: 'hangup', config: {} }],
      edges: [],
    });
    const v2 = await repo.publish({ tenantId }, created.id);

    expect(v2.versionNumber).toBe(v1.versionNumber + 1);
    const versions = await repo.listVersions({ tenantId }, created.id);
    expect(versions.map((v) => v.versionNumber)).toEqual([1, 2]);
  });

  it('rollback repoints to an earlier version without creating a new one or changing its IR', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Rollback Target');
    await repo.updateDraft({ tenantId }, created.id, validGraph());
    const v1 = await repo.publish({ tenantId }, created.id);
    const irV1 = await repo.findPublishedIr({ tenantId }, created.id);

    await repo.updateDraft({ tenantId }, created.id, {
      entryPoints: { main: 'hu2' },
      nodes: [{ id: 'hu2', type: 'hangup', config: {} }],
      edges: [],
    });
    await repo.publish({ tenantId }, created.id);

    const rolledBack = await repo.rollback({ tenantId }, created.id, v1.versionNumber);
    expect(rolledBack.id).toBe(v1.id);

    const flow = await repo.findById({ tenantId }, created.id);
    expect(flow?.currentPublishedVersionId).toBe(v1.id);
    expect(await repo.findPublishedIr({ tenantId }, created.id)).toEqual(irV1);

    // Still only two version rows — rollback never inserts one.
    expect(await repo.listVersions({ tenantId }, created.id)).toHaveLength(2);
  });

  it('rollback to a version number that never existed throws FlowVersionNotFoundError', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'No Such Version');
    await repo.updateDraft({ tenantId }, created.id, validGraph());
    await repo.publish({ tenantId }, created.id);

    await expect(repo.rollback({ tenantId }, created.id, 99)).rejects.toThrow(
      FlowVersionNotFoundError,
    );
  });

  it('findPublishedIr returns undefined for a flow that has never published', async () => {
    const tenantId = randomUUID();
    const created = await repo.create({ tenantId }, 'Never Published');
    expect(await repo.findPublishedIr({ tenantId }, created.id)).toBeUndefined();
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'flows',
    seed: (tenantId) => repo.create({ tenantId }, 'Probe').then((row) => row.id),
    list: (tenantId) => repo.list({ tenantId }),
    findById: (tenantId, id) => repo.findById({ tenantId }, id),
  });
});

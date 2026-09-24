import { randomUUID } from 'node:crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createFlowRepo, type FlowRepo } from '../src/repo/flow.repo.js';
import { registerFlowRoutes } from '../src/routes/flow.routes.js';
import type { CallflowServiceDb } from '../src/schema.js';
import { migrations } from '../migrations/index.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';

/** A valid flow whose nodes carry the editor's layout. */
const graph = {
  entryPoints: { main: 'm1' },
  nodes: [
    {
      id: 'm1',
      type: 'menu',
      config: { promptMediaAssetId: 'p1', timeoutSeconds: 5, maxInvalidAttempts: 3 },
      position: { x: 40, y: 80 },
      openPorts: ['1', '2'],
    },
    { id: 'h1', type: 'hangup', config: {}, position: { x: 400, y: 80 } },
  ],
  edges: [
    { from: 'm1', port: 'timeout', to: 'h1' },
    { from: 'm1', port: 'invalid', to: 'h1' },
  ],
};

describe.skipIf(skipReason !== undefined)('flow routes', () => {
  let db: Database<CallflowServiceDb>;
  let repo: FlowRepo;
  let app: Server;
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
    await migrateToLatest({ db: db.kysely, migrations, logger });
    repo = createFlowRepo(db);
    app = await createServer({
      serviceName: 'callflow-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerFlowRoutes(app, repo);
    await app.ready();
    stop = async () => {
      await app.close();
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  function headers(tenantId: string) {
    return signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  it('keeps the editor layout in the draft and in a published version, and out of the IR', async () => {
    const tenantId = randomUUID();
    const h = headers(tenantId);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/flows`,
      headers: h,
      payload: { name: 'Layout' },
    });
    const id = created.json<{ id: string }>().id;

    const saved = await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/flows/${id}/draft`,
      headers: h,
      payload: graph,
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json<{ draftGraph: typeof graph }>().draftGraph.nodes[0]).toMatchObject({
      position: { x: 40, y: 80 },
      openPorts: ['1', '2'],
    });

    const published = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/flows/${id}/publish`,
      headers: h,
    });
    expect(published.statusCode).toBe(201);

    const version = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/flows/${id}/versions/1`,
      headers: h,
    });
    expect(version.statusCode).toBe(200);
    const body = version.json<{ versionNumber: number; graph: typeof graph }>();
    expect(body.versionNumber).toBe(1);
    expect(body.graph.nodes[0]).toMatchObject({ position: { x: 40, y: 80 } });

    const ir = await repo.findPublishedIr({ tenantId }, id);
    expect(JSON.stringify(ir)).not.toContain('position');
    expect(JSON.stringify(ir)).not.toContain('openPorts');
  });

  it('404s a version that was never published', async () => {
    const tenantId = randomUUID();
    const h = headers(tenantId);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/flows`,
      headers: h,
      payload: { name: 'Nothing published' },
    });
    const id = created.json<{ id: string }>().id;
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/flows/${id}/versions/7`,
      headers: h,
    });
    expect(response.statusCode).toBe(404);
  });
});

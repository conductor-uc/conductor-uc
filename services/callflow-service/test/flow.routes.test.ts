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

  async function newFlow(tenantId: string, name: string): Promise<string> {
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/flows`,
      headers: headers(tenantId),
      payload: { name },
    });
    return created.json<{ id: string }>().id;
  }

  it('renames a flow (S9-10)', async () => {
    const tenantId = randomUUID();
    const id = await newFlow(tenantId, 'Main line');
    const renamed = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/flows/${id}`,
      headers: headers(tenantId),
      payload: { name: 'Main number' },
    });
    expect(renamed.statusCode).toBe(200);
    expect(renamed.json()).toMatchObject({ id, name: 'Main number' });
  });

  it('deletes a flow, and refuses one another flow jumps to (S9-10)', async () => {
    const tenantId = randomUUID();
    const h = headers(tenantId);
    const target = await newFlow(tenantId, 'After hours');
    const caller = await newFlow(tenantId, 'Main number');
    await app.inject({
      method: 'PUT',
      url: `/v1/tenants/${tenantId}/flows/${caller}/draft`,
      headers: h,
      payload: {
        entryPoints: { main: 'g1' },
        nodes: [{ id: 'g1', type: 'goto_flow', config: { flowId: target, entryPoint: 'main' } }],
        edges: [],
      },
    });

    const refused = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/flows/${target}`,
      headers: h,
    });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({
      code: 'flow_in_use',
      params: { usedBy: ['Main number'] },
    });

    const gone = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/flows/${caller}`,
      headers: h,
    });
    expect(gone.statusCode).toBe(204);
    const now = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/flows/${target}`,
      headers: h,
    });
    expect(now.statusCode).toBe(204);
    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/flows`,
      headers: h,
    });
    expect(list.json<{ rows: unknown[] }>().rows).toEqual([]);
    const events = await db.kysely
      .selectFrom('outbox')
      .select('type')
      .where('type', '=', 'callflow.flow.deleted')
      .execute();
    expect(events.length).toBeGreaterThanOrEqual(2);
  });
});

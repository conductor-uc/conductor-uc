import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerMediaAssetRoutes } from '../src/routes/media-asset.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

const VALID_BODY = { kind: 'prompt', label: 'Welcome greeting', contentType: 'audio/mpeg' };

describe.skipIf(skipReason !== undefined)('media asset HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerMediaAssetRoutes(app, h.mediaAssets);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function actorHeaders(tenantId: string) {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });

  it('creates, lists, gets, finalizes, and deletes an asset', async () => {
    const tenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets`,
      headers: actorHeaders(tenantId),
      payload: VALID_BODY,
    });
    expect(created.statusCode, JSON.stringify(created.json())).toBe(201);
    const { asset, uploadUrl }: { asset: { id: string; status: string }; uploadUrl: string } =
      created.json();
    expect(asset.status).toBe('pending');
    expect(uploadUrl).toContain('http');

    const list = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/media-assets`,
      headers: actorHeaders(tenantId),
    });
    expect(list.statusCode).toBe(200);
    expect(list.json()).toMatchObject({ rows: [{ label: 'Welcome greeting' }] });

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ status: 'pending' });

    const finalized = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}/finalize`,
      headers: actorHeaders(tenantId),
    });
    expect(finalized.statusCode).toBe(200);
    expect(finalized.json()).toMatchObject({ status: 'processing' });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const afterDelete = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(afterDelete.statusCode).toBe(404);
  });

  it('400s creating an asset with an unsupported content type', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets`,
      headers: actorHeaders(tenantId),
      payload: { ...VALID_BODY, contentType: 'video/mp4' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s getting an asset that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/media-assets/${crypto.randomUUID()}`,
      headers: actorHeaders(tenantId),
    });
    expect(response.statusCode).toBe(404);
  });

  it('409s finalizing an asset that is already processing', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets`,
      headers: actorHeaders(tenantId),
      payload: VALID_BODY,
    });
    const { asset }: { asset: { id: string } } = created.json();
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}/finalize`,
      headers: actorHeaders(tenantId),
    });

    const secondFinalize = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/media-assets/${asset.id}/finalize`,
      headers: actorHeaders(tenantId),
    });
    expect(secondFinalize.statusCode).toBe(409);
  });
});

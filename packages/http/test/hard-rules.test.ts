import { describe, expect, it } from 'vitest';

import { testServer } from './helpers.js';

/** Hard rule H1: the reseller private-data wall (07 §3.1). */
async function serverWithRoutes() {
  const app = await testServer({ context: { trustInternalHeaders: true } });
  app.get('/v1/cdrs', { config: { permission: 'cdr.read', dataClass: 'private' } }, () => ({
    rows: [],
  }));
  app.get(
    '/v1/extensions',
    { config: { permission: 'extension.manage', dataClass: 'config' } },
    () => ({ rows: [] }),
  );
  app.get(
    '/v1/usage',
    { config: { permission: 'analytics.view', dataClass: 'usage' } },
    () => ({}),
  );
  return app;
}

async function get(url: string, orgType?: string) {
  const app = await serverWithRoutes();
  await app.ready();
  return app.inject({
    method: 'GET',
    url,
    headers: orgType === undefined ? {} : { 'x-internal-org-type': orgType },
  });
}

describe('H1 — reseller private-data wall', () => {
  it('denies a reseller actor on a private route', async () => {
    const response = await get('/v1/cdrs', 'reseller');

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      type: '/problems/forbidden',
      status: 403,
      code: 'reseller_private_data_denied',
    });
  });

  it('allows a reseller actor on a config route', async () => {
    const response = await get('/v1/extensions', 'reseller');

    expect(response.statusCode).toBe(200);
  });

  it('allows a reseller actor on a usage route, pending D-013', async () => {
    const response = await get('/v1/usage', 'reseller');

    expect(response.statusCode).toBe(200);
  });

  it('allows a tenant actor on a private route', async () => {
    const response = await get('/v1/cdrs', 'tenant');

    expect(response.statusCode).toBe(200);
  });

  it('allows a master actor on a private route', async () => {
    const response = await get('/v1/cdrs', 'master');

    expect(response.statusCode).toBe(200);
  });

  it('cannot be overridden by a route, because it runs before the handler', async () => {
    const app = await testServer({ context: { trustInternalHeaders: true } });
    let handlerRan = false;
    app.get(
      '/v1/recordings',
      { config: { permission: 'recording.listen', dataClass: 'private' } },
      () => {
        handlerRan = true;
        return {};
      },
    );
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/v1/recordings',
      headers: { 'x-internal-org-type': 'reseller' },
    });

    expect(handlerRan).toBe(false);
  });

  it('logs the denial so the wall is visible in an audit', async () => {
    const { captureLogger } = await import('./helpers.js');
    const { lines, logger } = captureLogger();
    const app = await testServer({ logger, context: { trustInternalHeaders: true } });
    app.get('/v1/cdrs', { config: { permission: 'cdr.read', dataClass: 'private' } }, () => ({}));
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/v1/cdrs',
      headers: { 'x-internal-org-type': 'reseller' },
    });

    expect(lines.some((line) => line['msg'] === 'H1: reseller denied private tenant data')).toBe(
      true,
    );
  });
});

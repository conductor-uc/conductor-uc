import { describe, expect, it } from 'vitest';
import { Type } from 'typebox';

import { testServer } from './helpers.js';

interface OpenApiDocument {
  openapi: string;
  info: { title: string; version: string; description?: string };
  paths?: Record<string, Record<string, { requestBody?: unknown }>>;
}

describe('GET /openapi.json', () => {
  it('serves an OpenAPI 3.1 document describing the declared routes', async () => {
    const app = await testServer();
    app.post(
      '/v1/extensions',
      {
        config: { permission: 'extension.manage', dataClass: 'config' },
        schema: {
          body: Type.Object({ name: Type.String() }),
          response: { 201: Type.Object({ id: Type.String() }) },
        },
      },
      () => ({ id: 'e1' }),
    );
    await app.ready();

    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    expect(document.openapi).toMatch(/^3\.1/);
    expect(document.paths).toHaveProperty('/v1/extensions');
    expect(document.paths?.['/v1/extensions']?.['post']?.requestBody).toBeDefined();
  });

  it('titles the document with the service name by default', async () => {
    const app = await testServer();
    await app.ready();

    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    expect(document.info).toMatchObject({ title: 'test-service', version: '1.2.3' });
  });

  it('accepts a functional title override', async () => {
    const app = await testServer({
      openapi: { title: 'Extensions API', description: 'PBX extensions.' },
    });
    await app.ready();

    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    expect(document.info).toMatchObject({
      title: 'Extensions API',
      description: 'PBX extensions.',
    });
  });

  it('names no product, operator, or codebase anywhere in the document', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: { permission: 'p', dataClass: 'config' } }, () => ({}));
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/openapi.json' })).body.toLowerCase();

    for (const forbidden of ['conductoruc', 'conductor-uc', 'conductor uc']) {
      expect(body).not.toContain(forbidden);
    }
  });

  it('keeps the infrastructure routes out of the published surface', async () => {
    const app = await testServer();
    await app.ready();

    const document = (
      await app.inject({ method: 'GET', url: '/openapi.json' })
    ).json<OpenApiDocument>();

    expect(document.paths ?? {}).not.toHaveProperty('/healthz');
    expect(document.paths ?? {}).not.toHaveProperty('/readyz');
    expect(document.paths ?? {}).not.toHaveProperty('/openapi.json');
  });
});

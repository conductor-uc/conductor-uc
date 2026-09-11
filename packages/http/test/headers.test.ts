import { describe, expect, it } from 'vitest';

import { testServer } from './helpers.js';

/**
 * The Master tier is unbranded, and `Server` / `X-Powered-By` are listed brand-
 * leak surfaces (02 §5.5). Fastify sends neither by default; these tests exist
 * so a future plugin cannot reintroduce one unnoticed.
 */
describe('server identity headers', () => {
  it('emits no Server or X-Powered-By header on a successful response', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: { permission: 'p', dataClass: 'config' } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });

    expect(response.statusCode).toBe(200);
    expect(response.headers).not.toHaveProperty('server');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('emits neither header on the health routes', async () => {
    const app = await testServer();
    await app.ready();

    for (const url of ['/healthz', '/readyz']) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.headers).not.toHaveProperty('server');
      expect(response.headers).not.toHaveProperty('x-powered-by');
    }
  });

  it('emits neither header on an error response', async () => {
    const app = await testServer();
    app.get('/v1/boom', { config: { permission: 'p', dataClass: 'config' } }, () => {
      throw new Error('internal detail');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/boom' });

    expect(response.statusCode).toBe(500);
    expect(response.headers).not.toHaveProperty('server');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('emits neither header on a 404', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/nope' });

    expect(response.statusCode).toBe(404);
    expect(response.headers).not.toHaveProperty('server');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('emits neither header on the OpenAPI document', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(response.statusCode).toBe(200);
    expect(response.headers).not.toHaveProperty('server');
    expect(response.headers).not.toHaveProperty('x-powered-by');
  });

  it('names no product, operator, or codebase anywhere in the response', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: { permission: 'p', dataClass: 'config' } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });
    const serialized = `${JSON.stringify(response.headers)}${response.body}`.toLowerCase();

    for (const forbidden of ['conductoruc', 'conductor-uc', 'conductor uc']) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe('request id propagation', () => {
  it('echoes the caller request id so one id spans every hop', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: { permission: 'p', dataClass: 'config' } }, (request) => ({
      seen: request.context.requestId,
    }));
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: { 'x-request-id': 'caller-supplied-id' },
    });

    expect(response.headers['x-request-id']).toBe('caller-supplied-id');
    expect(response.json()).toEqual({ seen: 'caller-supplied-id' });
  });

  it('generates a request id when the caller supplies none', async () => {
    const app = await testServer();
    app.get('/v1/x', { config: { permission: 'p', dataClass: 'config' } }, () => ({ ok: true }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/v1/x' });

    expect(response.headers['x-request-id']).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
  });

  it('returns the request id on error responses too', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({
      method: 'GET',
      url: '/nope',
      headers: { 'x-request-id': 'r-404' },
    });

    expect(response.headers['x-request-id']).toBe('r-404');
    expect(response.json()).toMatchObject({ requestId: 'r-404' });
  });
});

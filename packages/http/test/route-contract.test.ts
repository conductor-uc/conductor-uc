import { describe, expect, it } from 'vitest';

import { RouteContractError } from '../src/route-guard.js';
import { testServer } from './helpers.js';

describe('route contract guard', () => {
  it('rejects a route that declares no dataClass', async () => {
    const app = await testServer();

    expect(() =>
      app.get('/v1/extensions', { config: { permission: 'extension.manage' } }, () => ({})),
    ).toThrow(RouteContractError);
  });

  it('rejects a route that declares no permission', async () => {
    const app = await testServer();

    expect(() =>
      app.get('/v1/extensions', { config: { dataClass: 'config' } }, () => ({})),
    ).toThrow(/does not declare a permission/);
  });

  it('rejects a route that declares neither', async () => {
    const app = await testServer();

    expect(() => app.get('/v1/extensions', () => ({}))).toThrow(RouteContractError);
  });

  it('fails readiness when the offending route is inside a plugin', async () => {
    const app = await testServer();
    // Async on purpose: a callback-style plugin turns the guard's throw into an
    // uncaught exception instead of rejecting `ready()`.
    // eslint-disable-next-line @typescript-eslint/require-await
    void app.register(async (instance) => {
      instance.get('/v1/extensions', { config: { permission: 'extension.manage' } }, () => ({}));
    });

    await expect(app.ready()).rejects.toThrow(/does not declare a dataClass/);
  });

  it('names the offending route so the failure is actionable', async () => {
    const app = await testServer();

    expect(() =>
      app.post(
        '/v1/tenants/:tenantId/queues',
        { config: { permission: 'queue.manage' } },
        () => ({}),
      ),
    ).toThrow(/POST \/v1\/tenants\/:tenantId\/queues/);
  });

  it('rejects an unknown dataClass', async () => {
    const app = await testServer();

    expect(() =>
      app.get(
        '/v1/extensions',
        // @ts-expect-error the contract type rejects this at compile time too
        { config: { permission: 'extension.manage', dataClass: 'internal' } },
        () => ({}),
      ),
    ).toThrow(/unknown dataClass 'internal'/);
  });

  it('accepts a route that declares both', async () => {
    const app = await testServer();
    app.get(
      '/v1/extensions',
      { config: { permission: 'extension.manage', dataClass: 'config' } },
      () => ({ ok: true }),
    );

    await expect(app.ready()).resolves.toBeDefined();
  });

  it('rejects a route that is both public and permissioned', async () => {
    const app = await testServer();

    expect(() =>
      app.get('/v1/x', { config: { public: true, permission: 'extension.manage' } }, () => ({})),
    ).toThrow(/marked public but also declares a permission/);
  });

  it('records every route so CI can assert over the whole surface', async () => {
    const app = await testServer();
    app.get('/v1/cdrs', { config: { permission: 'cdr.read', dataClass: 'private' } }, () => ({}));
    await app.ready();

    expect(app.registeredRoutes).toContainEqual({
      method: 'GET',
      url: '/v1/cdrs',
      permission: 'cdr.read',
      dataClass: 'private',
      public: false,
    });
  });

  it('exempts only the infrastructure routes from the contract', async () => {
    const app = await testServer();
    app.get('/v1/a', { config: { permission: 'p', dataClass: 'config' } }, () => ({}));
    await app.ready();

    const exempt = app.registeredRoutes.filter((route) => route.public).map((route) => route.url);

    expect(new Set(exempt)).toEqual(new Set(['/healthz', '/readyz', '/openapi.json']));
    for (const route of app.registeredRoutes) {
      expect(route.public || (route.permission !== null && route.dataClass !== null)).toBe(true);
    }
  });
});

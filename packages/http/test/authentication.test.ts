import { describe, expect, it, vi } from 'vitest';

import type { RequestContext } from '../src/context.js';
import type { PermissionResolver } from '../src/permission-guard.js';
import type { Server } from '../src/server-type.js';
import { signedHeaders, testServer } from './helpers.js';

/** Unauthenticated requests on protected routes (G-112). */

const SERVICE_TOKEN = 'test-internal-service-token';

const tenantAdmin = {
  actorId: 'u1',
  actorType: 'user' as const,
  orgId: 't1',
  orgType: 'tenant' as const,
};

async function server(
  options: {
    readonly trustInternalHeaders?: boolean;
    readonly internalServiceToken?: string;
    readonly permissions?: PermissionResolver;
  } = {},
): Promise<{ app: Server; handled: () => number }> {
  let calls = 0;
  const app = await testServer({
    context: {
      trustInternalHeaders: options.trustInternalHeaders ?? true,
      ...(options.internalServiceToken === undefined
        ? {}
        : { internalServiceToken: options.internalServiceToken }),
    },
    ...(options.permissions === undefined ? {} : { permissions: options.permissions }),
  });
  app.post(
    '/v1/tenants/:tenantId/extensions',
    { config: { permission: 'extension.manage', dataClass: 'config' } },
    (request) => {
      calls += 1;
      return request.context;
    },
  );
  app.get('/v1/public/thing', { config: { public: true } }, (request) => request.context);
  await app.ready();
  return { app, handled: () => calls };
}

function post(app: Server, headers: Record<string, string> = {}) {
  return app.inject({
    method: 'POST',
    url: '/v1/tenants/t1/extensions',
    headers,
    payload: { anything: true },
  });
}

describe('authentication requirement (G-112)', () => {
  it('refuses a request with no identity at all, before the handler runs', async () => {
    const { app, handled } = await server({ internalServiceToken: SERVICE_TOKEN });

    const response = await post(app);

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ status: 401, code: 'authentication_required' });
    expect(handled()).toBe(0);
  });

  it('refuses it on a service with no permission resolver, too', async () => {
    const { app } = await server();

    expect((await post(app)).statusCode).toBe(401);
  });

  it('answers with a neutral message', async () => {
    const { app } = await server();

    const body = (await post(app)).json<{ title: string; detail: string }>();

    expect(`${body.title} ${body.detail}`).not.toMatch(/token|internal|gateway|header/i);
  });

  it('still refuses forged identity headers as forged', async () => {
    const { app, handled } = await server();

    const response = await post(app, {
      'x-internal-actor-type': 'user',
      'x-internal-actor-id': 'u1',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'internal_headers_forged' });
    expect(handled()).toBe(0);
  });

  it('refuses a validly signed context that names no caller', async () => {
    const { app } = await server();

    const orgOnly = await post(app, signedHeaders({ orgId: 't1', orgType: 'tenant' }));
    const addressOnly = await post(app, signedHeaders({ clientIp: '203.0.113.9' }));

    expect(orgOnly.statusCode).toBe(401);
    expect(addressOnly.statusCode).toBe(401);
    expect(addressOnly.json()).toMatchObject({ code: 'authentication_required' });
  });

  it('passes a signed-in person on to the permission guard', async () => {
    const resolve = vi.fn<PermissionResolver>(() => Promise.resolve(true));
    const { app, handled } = await server({ permissions: resolve });

    const response = await post(app, signedHeaders(tenantAdmin));

    expect(response.statusCode).toBe(200);
    expect(resolve).toHaveBeenCalledWith(
      { id: 'u1', orgId: 't1', orgType: 'tenant' },
      'extension.manage',
    );
    expect(handled()).toBe(1);
  });

  it('still lets the permission guard refuse a signed-in person', async () => {
    const { app } = await server({ permissions: () => Promise.resolve(false) });

    const response = await post(app, signedHeaders(tenantAdmin));

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'permission_denied' });
  });

  it('accepts the internal service token as a trusted machine caller', async () => {
    const resolve = vi.fn<PermissionResolver>(() => Promise.resolve(false));
    const { app, handled } = await server({
      internalServiceToken: SERVICE_TOKEN,
      permissions: resolve,
    });

    const response = await post(app, { authorization: `Bearer ${SERVICE_TOKEN}` });

    expect(response.statusCode).toBe(200);
    const context = response.json<RequestContext>();
    expect(context.actorType).toBe('service');
    expect(context.orgId).toBeUndefined();
    expect(context.orgType).toBeUndefined();
    // The permission guard judges people only.
    expect(resolve).not.toHaveBeenCalled();
    expect(handled()).toBe(1);
  });

  it('refuses a wrong token', async () => {
    const { app, handled } = await server({ internalServiceToken: SERVICE_TOKEN });

    for (const authorization of [
      `Bearer ${SERVICE_TOKEN}x`,
      'Bearer nope',
      `Basic ${SERVICE_TOKEN}`,
      SERVICE_TOKEN,
      'Bearer ',
    ]) {
      const response = await post(app, { authorization });
      expect(response.statusCode, authorization).toBe(401);
      expect(response.json()).toMatchObject({ code: 'authentication_required' });
    }
    expect(handled()).toBe(0);
  });

  it('refuses any bearer token when the service has none configured', async () => {
    const { app } = await server();

    expect((await post(app, { authorization: 'Bearer anything' })).statusCode).toBe(401);
  });

  it('does not let the token stand in for a signature on forged identity headers', async () => {
    const { app } = await server({ internalServiceToken: SERVICE_TOKEN });

    const response = await post(app, {
      authorization: `Bearer ${SERVICE_TOKEN}`,
      'x-internal-org-type': 'master',
    });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'internal_headers_forged' });
  });

  it('leaves public routes open to anyone', async () => {
    const { app } = await server({ internalServiceToken: SERVICE_TOKEN });

    const anonymous = await app.inject({ method: 'GET', url: '/v1/public/thing' });
    const wrongToken = await app.inject({
      method: 'GET',
      url: '/v1/public/thing',
      headers: { authorization: 'Bearer nope' },
    });
    const health = await app.inject({ method: 'GET', url: '/healthz' });
    const openapi = await app.inject({ method: 'GET', url: '/openapi.json' });

    expect(anonymous.statusCode).toBe(200);
    expect(anonymous.json<RequestContext>().actorType).toBeUndefined();
    expect(wrongToken.statusCode).toBe(200);
    expect(health.statusCode).toBe(200);
    expect(openapi.statusCode).toBe(200);
  });

  it('answers an unknown path with 404, not 401', async () => {
    const { app } = await server();

    expect((await app.inject({ method: 'GET', url: '/v1/nothing-here' })).statusCode).toBe(404);
  });

  it('changes nothing on a service that does not trust internal headers', async () => {
    const { app, handled } = await server({
      trustInternalHeaders: false,
      internalServiceToken: SERVICE_TOKEN,
    });

    const anonymous = await post(app);
    const withToken = await post(app, { authorization: `Bearer ${SERVICE_TOKEN}` });

    expect(anonymous.statusCode).toBe(200);
    expect(withToken.statusCode).toBe(200);
    // The token means nothing to a service that trusts no caller-supplied identity.
    expect(withToken.json<RequestContext>().actorType).toBeUndefined();
    expect(handled()).toBe(2);
  });
});

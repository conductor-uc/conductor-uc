import { describe, expect, it, vi } from 'vitest';

import {
  createRemotePermissionResolver,
  selfActor,
  type PermissionResolver,
} from '../src/permission-guard.js';
import { ProblemError } from '../src/problem.js';
import { signedHeaders, testServer } from './helpers.js';

async function server(resolve: PermissionResolver) {
  const app = await testServer({ context: { trustInternalHeaders: true }, permissions: resolve });
  app.get(
    '/v1/tenants/:tenantId/extensions',
    { config: { permission: 'extension.manage', dataClass: 'config' } },
    () => ({ rows: [] }),
  );
  app.get(
    '/v1/tenants/:tenantId/cdrs',
    { config: { permission: 'cdr.read', dataClass: 'private' } },
    () => ({ rows: [] }),
  );
  app.get(
    '/v1/orgs/:orgId/me',
    { config: { permission: 'org.view', dataClass: 'config' } },
    () => ({
      ok: true,
    }),
  );
  app.post(
    '/v1/tenants/:tenantId/calls/:callUuid/listen',
    { config: { permission: 'monitor.listen', dataClass: 'private', scopedPermission: true } },
    () => ({ handlerDecides: true }),
  );
  app.post(
    '/v1/orgs/:orgId/users',
    { config: { permission: 'user.manage', dataClass: 'config' } },
    () => ({ created: true }),
  );
  app.get(
    '/v1/tenants/:tenantId/me/extension',
    { config: { permission: 'self.settings', dataClass: 'config' } },
    (request) => selfActor(request as never),
  );
  await app.ready();
  return app;
}

const tenantUser = {
  actorId: 'u1',
  actorType: 'user' as const,
  orgId: 't1',
  orgType: 'tenant' as const,
};
const holds =
  (...held: string[]): PermissionResolver =>
  (_actor, permission) =>
    Promise.resolve(held.includes(permission));

describe('permission guard', () => {
  it('lets a person through when the resolver says they hold the route permission', async () => {
    const app = await server(holds('extension.manage'));
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/extensions',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(200);
  });

  it('refuses a person who does not hold it, with a clear code', async () => {
    const app = await server(holds('self.settings'));
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/extensions',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'permission_denied' });
  });

  it('refuses a tenant person naming another tenant, even holding the permission (H2)', async () => {
    const resolve = vi.fn(holds('extension.manage'));
    const app = await server(resolve);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t2/extensions',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'tenant_boundary' });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('keeps the H1 answer for a reseller on a private route', async () => {
    const app = await server(holds('cdr.read'));
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/cdrs',
      headers: signedHeaders({ ...tenantUser, orgId: 'r1', orgType: 'reseller' }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'reseller_private_data_denied' });
  });

  it('never checks org.view, so a person with no role can still ask what they may do', async () => {
    const resolve = vi.fn(holds());
    const app = await server(resolve);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/orgs/t1/me',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  it('does not ask about services or nodes', async () => {
    const resolve = vi.fn(holds());
    const app = await server(resolve);
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/extensions',
      headers: signedHeaders({ ...tenantUser, actorType: 'service' }),
    });
    expect(response.statusCode).toBe(200);
    expect(resolve).not.toHaveBeenCalled();
  });

  describe('API keys (S1-08, G-14)', () => {
    const tenantKey = { ...tenantUser, actorId: 'k1', actorType: 'apikey' as const };

    it('checks a key against its own permissions, as a key', async () => {
      const resolve = vi.fn(holds('extension.manage'));
      const app = await server(resolve);
      const allowed = await app.inject({
        method: 'GET',
        url: '/v1/tenants/t1/extensions',
        headers: signedHeaders(tenantKey),
      });
      expect(allowed.statusCode).toBe(200);
      expect(resolve).toHaveBeenCalledWith(
        { id: 'k1', orgId: 't1', orgType: 'tenant', type: 'apikey' },
        'extension.manage',
      );
      const refused = await app.inject({
        method: 'GET',
        url: '/v1/tenants/t1/cdrs',
        headers: signedHeaders(tenantKey),
      });
      expect(refused.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('never lets a key manage people, roles, grants or keys (H4), whatever it holds', async () => {
      const resolve = vi.fn(holds('user.manage'));
      const app = await server(resolve);
      const response = await app.inject({
        method: 'POST',
        url: '/v1/orgs/t1/users',
        headers: signedHeaders(tenantKey),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'api_key_not_allowed' });
      expect(resolve).not.toHaveBeenCalled();
    });

    it('refuses a key on a scoped route and on self-service, which are about a person', async () => {
      const app = await server(holds('monitor.listen', 'self.settings'));
      const scoped = await app.inject({
        method: 'POST',
        url: '/v1/tenants/t1/calls/c1/listen',
        headers: signedHeaders(tenantKey),
      });
      expect(scoped.json()).toMatchObject({ code: 'people_only' });
      const self = await app.inject({
        method: 'GET',
        url: '/v1/tenants/t1/me/extension',
        headers: signedHeaders(tenantKey),
      });
      expect(self.statusCode).toBe(403);
    });

    it("keeps a key to its own tenant (H2), and a reseller's key from private data (H1)", async () => {
      const app = await server(holds('extension.manage', 'cdr.read'));
      const other = await app.inject({
        method: 'GET',
        url: '/v1/tenants/t2/extensions',
        headers: signedHeaders(tenantKey),
      });
      expect(other.json()).toMatchObject({ code: 'tenant_boundary' });
      const reseller = await app.inject({
        method: 'GET',
        url: '/v1/tenants/t1/cdrs',
        headers: signedHeaders({ ...tenantKey, orgId: 'r1', orgType: 'reseller' }),
      });
      expect(reseller.json()).toMatchObject({ code: 'reseller_private_data_denied' });
    });
  });

  it('S5-09: leaves a scoped-permission route to its handler, without asking the resolver', async () => {
    const resolve = vi.fn(holds());
    const app = await server(resolve);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants/t1/calls/c1/listen',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ handlerDecides: true });
    expect(resolve).not.toHaveBeenCalled();
  });

  it('S5-09: still applies the tenant boundary and H1 to a scoped-permission route', async () => {
    const app = await server(holds('monitor.listen'));
    const otherTenant = await app.inject({
      method: 'POST',
      url: '/v1/tenants/t2/calls/c1/listen',
      headers: signedHeaders(tenantUser),
    });
    expect(otherTenant.statusCode).toBe(403);
    expect(otherTenant.json()).toMatchObject({ code: 'tenant_boundary' });

    const reseller = await app.inject({
      method: 'POST',
      url: '/v1/tenants/t1/calls/c1/listen',
      headers: signedHeaders({ actorId: 'r1', actorType: 'user', orgId: 'r', orgType: 'reseller' }),
    });
    expect(reseller.statusCode).toBe(403);
    expect(reseller.json()).toMatchObject({ code: 'reseller_private_data_denied' });
  });

  it('a resolver that cannot tell fails the request rather than allowing it', async () => {
    const app = await server(() =>
      Promise.reject(ProblemError.unavailable('down', { code: 'test_down' })),
    );
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/extensions',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(503);
  });

  it('is off when a service does not pass a resolver', async () => {
    const app = await testServer({ context: { trustInternalHeaders: true } });
    app.get(
      '/v1/tenants/:tenantId/extensions',
      { config: { permission: 'extension.manage', dataClass: 'config' } },
      () => ({}),
    );
    await app.ready();
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t2/extensions',
      headers: signedHeaders(tenantUser),
    });
    expect(response.statusCode).toBe(200);
  });
});

describe('selfActor', () => {
  it('returns the signed actor and tenant', async () => {
    const app = await server(holds('self.settings'));
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/me/extension',
      headers: signedHeaders(tenantUser),
    });
    expect(response.json()).toEqual({ userId: 'u1', tenantId: 't1' });
  });

  it.each([
    ['a reseller', { orgId: 'r1', orgType: 'reseller' as const }],
    ['the master', { orgId: 'm1', orgType: 'master' as const }],
    ['an API key', { actorType: 'apikey' as const }],
  ])('refuses %s', async (_name, override) => {
    const app = await server(holds('self.settings'));
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/me/extension',
      headers: signedHeaders({ ...tenantUser, ...override }),
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'self_service_only' });
  });

  it('refuses without a signed identity', async () => {
    const app = await server(holds('self.settings'));
    const response = await app.inject({ method: 'GET', url: '/v1/tenants/t1/me/extension' });
    expect(response.statusCode).toBe(401);
  });
});

describe('createRemotePermissionResolver', () => {
  const actor = { id: 'u1', orgId: 't1', orgType: 'tenant' as const };

  function resolver(fetchImpl: typeof fetch, now = () => 0) {
    return createRemotePermissionResolver({
      baseUrl: 'http://identity/',
      internalServiceToken: 'tok',
      fetchImpl,
      now,
      ttlMs: 1000,
    });
  }

  it('asks identity-service with the service token, and caches for the ttl', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ permissions: ['self.settings'] })),
    );
    let clock = 0;
    const resolve = resolver(fetchImpl, () => clock);

    expect(await resolve(actor, 'self.settings')).toBe(true);
    expect(await resolve(actor, 'extension.manage')).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://identity/internal/v1/orgs/t1/users/u1/permissions',
      { headers: { authorization: 'Bearer tok' } },
    );

    clock = 1001;
    await resolve(actor, 'self.settings');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('asks about an API key at its own address, and caches it apart from a person with the same id', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ permissions: ['extension.read'] })),
    );
    const resolve = resolver(fetchImpl);
    expect(await resolve({ ...actor, type: 'apikey' }, 'extension.read')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith(
      'http://identity/internal/v1/orgs/t1/api-keys/u1/permissions',
      { headers: { authorization: 'Bearer tok' } },
    );
    await resolve(actor, 'extension.read');
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats a held .manage permission as holding its .read twin (G-10), never the reverse', async () => {
    const fetchImpl = vi.fn(() =>
      Promise.resolve(Response.json({ permissions: ['extension.manage', 'trunk.read'] })),
    );
    const resolve = resolver(fetchImpl);

    expect(await resolve(actor, 'extension.read')).toBe(true);
    expect(await resolve(actor, 'trunk.read')).toBe(true);
    expect(await resolve(actor, 'trunk.manage')).toBe(false);
    expect(await resolve(actor, 'did.read')).toBe(false);
  });

  it('does not remember "holds nothing", so a role just given works at once', async () => {
    let body: unknown = null;
    const fetchImpl = vi.fn(() =>
      Promise.resolve(body === null ? new Response(null, { status: 404 }) : Response.json(body)),
    );
    const resolve = resolver(fetchImpl);
    expect(await resolve(actor, 'self.settings')).toBe(false);
    body = { permissions: ['self.settings'] };
    expect(await resolve(actor, 'self.settings')).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('treats an unknown person as holding nothing', async () => {
    const resolve = resolver(() => Promise.resolve(new Response(null, { status: 404 })));
    expect(await resolve(actor, 'self.settings')).toBe(false);
  });

  it('fails closed when identity-service is unreachable or errors', async () => {
    const down = resolver(() => Promise.reject(new Error('refused')));
    await expect(down(actor, 'self.settings')).rejects.toMatchObject({ status: 503 });
    const broken = resolver(() => Promise.resolve(new Response(null, { status: 500 })));
    await expect(broken(actor, 'self.settings')).rejects.toMatchObject({ status: 503 });
  });
});

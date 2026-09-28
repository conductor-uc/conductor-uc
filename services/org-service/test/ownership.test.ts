import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';

import type { Org } from '../src/repo/org.repo.js';
import { registerOrgOwnership } from '../src/routes/ownership.js';

const SECRET = 'test-internal-header-secret';

const org = (id: string, type: Org['type'], resellerId: string | null): Org => ({
  id,
  type,
  parentId: resellerId,
  resellerId,
  slug: id,
  name: id,
  status: 'active',
  timezone: 'UTC',
  country: 'US',
  limits: {},
  deleteAfter: null,
});

const ORGS = new Map<string, Org>([
  ['acme', org('acme', 'reseller', null)],
  ['other', org('other', 'reseller', null)],
  ['acme-dental', org('acme-dental', 'tenant', 'acme')],
  ['other-cafe', org('other-cafe', 'tenant', 'other')],
]);

describe('who may address an org by id', () => {
  let app: Server;

  beforeAll(async () => {
    app = await createServer({
      serviceName: 'org-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerOrgOwnership(app, { findById: (id) => Promise.resolve(ORGS.get(id)) });
    for (const url of [
      '/v1/resellers/:id/brand',
      '/v1/resellers/:id/tenants',
      '/v1/tenants/:id',
      '/v1/tenants/:id/domain',
    ]) {
      app.get(url, { config: { permission: 'org.view', dataClass: 'config' } }, () => ({
        ok: true,
      }));
    }
    app.get('/v1/public/brand', { config: { public: true } }, () => ({ ok: true }));
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  const get = (
    url: string,
    actor: { orgType: 'master' | 'reseller' | 'tenant'; orgId: string } | 'service',
  ) =>
    app.inject({
      method: 'GET',
      url,
      headers: signInternalHeaders(
        SECRET,
        actor === 'service'
          ? { actorId: 'svc', actorType: 'service' }
          : { actorId: 'u1', actorType: 'user', ...actor },
      ),
    });

  it.each([
    [
      'a reseller reaches itself',
      '/v1/resellers/acme/brand',
      { orgType: 'reseller', orgId: 'acme' },
      200,
    ],
    [
      'a reseller reaches its tenant',
      '/v1/tenants/acme-dental/domain',
      { orgType: 'reseller', orgId: 'acme' },
      200,
    ],
    [
      'a reseller never another reseller',
      '/v1/resellers/other/brand',
      { orgType: 'reseller', orgId: 'acme' },
      404,
    ],
    [
      "a reseller never another reseller's tenants",
      '/v1/resellers/other/tenants',
      { orgType: 'reseller', orgId: 'acme' },
      404,
    ],
    [
      "a reseller never another reseller's tenant",
      '/v1/tenants/other-cafe',
      { orgType: 'reseller', orgId: 'acme' },
      404,
    ],
    [
      'a tenant reaches itself',
      '/v1/tenants/acme-dental',
      { orgType: 'tenant', orgId: 'acme-dental' },
      200,
    ],
    [
      'a tenant never another tenant',
      '/v1/tenants/other-cafe',
      { orgType: 'tenant', orgId: 'acme-dental' },
      404,
    ],
    [
      'a tenant never its reseller',
      '/v1/resellers/acme/brand',
      { orgType: 'tenant', orgId: 'acme-dental' },
      404,
    ],
    [
      'the master reaches any',
      '/v1/tenants/other-cafe/domain',
      { orgType: 'master', orgId: 'm' },
      200,
    ],
    [
      'an org that does not exist is the same answer',
      '/v1/tenants/nobody',
      { orgType: 'reseller', orgId: 'acme' },
      404,
    ],
  ] as const)('%s', async (_name, url, actor, status) => {
    expect((await get(url, actor)).statusCode).toBe(status);
  });

  it("the platform's own tooling (service token) reaches any, and other routes are untouched", async () => {
    expect((await get('/v1/tenants/other-cafe', 'service')).statusCode).toBe(200);
    expect((await app.inject({ method: 'GET', url: '/v1/public/brand' })).statusCode).toBe(200);
  });

  it('answers a refusal exactly as a missing org', async () => {
    const refused = await get('/v1/tenants/other-cafe', { orgType: 'reseller', orgId: 'acme' });
    const missing = await get('/v1/tenants/nobody', { orgType: 'reseller', orgId: 'acme' });
    expect(refused.json()).toMatchObject({ code: 'tenant_not_found' });
    expect(missing.json()).toMatchObject({ code: 'tenant_not_found' });
  });
});

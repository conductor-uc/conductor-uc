import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestRedis, type TestRedisHandle } from '@cuc/testing';
import { Redis } from 'ioredis';

import { buildApp } from '../src/app.js';
import type { Server } from '@cuc/http';
import { testConfig } from './config.js';
import {
  baseServerOptions,
  mintAccessToken,
  startFakeDownstream,
  startFakeJwks,
  type FakeDownstream,
  type FakeIdentityKeys,
} from './helpers.js';

const SECRET = 'test-internal-header-secret';

describe('api-gateway: auth + proxy', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let jwks: FakeIdentityKeys;
  let identity: FakeDownstream;
  let org: FakeDownstream;
  // One fake per tenant-route service: each answers with its own name so a
  // test can see which one the gateway chose (G-60).
  let tenantServices: Record<string, FakeDownstream>;
  let app: Server;

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);

    jwks = await startFakeJwks();

    identity = await startFakeDownstream(SECRET, (fake) => {
      fake.post('/v1/auth/login', { config: { public: true } }, () => ({
        status: 'ok',
        accessToken: 'x',
        refreshToken: 'y',
        expiresIn: 600,
      }));
      // Echoes what the gateway forwarded, and sets two cookies.
      fake.post('/v1/auth/refresh', { config: { public: true } }, (request, reply) => {
        void reply.header('set-cookie', [
          'refresh=new; Path=/v1/auth; HttpOnly',
          'other=1; Path=/',
        ]);
        return {
          cookie: request.headers.cookie ?? null,
          transport: request.headers['x-refresh-transport'] ?? null,
          userAgent: request.headers['user-agent'] ?? null,
          forwardedFor: request.headers['x-forwarded-for'] ?? null,
          forwardedHost: request.headers['x-forwarded-host'] ?? null,
        };
      });
      fake.post(
        '/v1/orgs/:id/echo-cookie',
        { config: { permission: 'user.manage', dataClass: 'config' } },
        (request) => ({
          cookie: request.headers.cookie ?? null,
        }),
      );
    });

    org = await startFakeDownstream(SECRET, (fake) => {
      fake.get('/v1/public/brand', { config: { public: true } }, () => ({ neutral: true }));
      fake.get(
        '/v1/tenants/:id',
        { config: { permission: 'tenant.read', dataClass: 'config' } },
        (request) => ({ id: (request.params as { id: string }).id, context: request.context }),
      );
      fake.post(
        '/v1/tenants/:id/echo',
        { config: { permission: 'tenant.read', dataClass: 'config' } },
        (request) => request.body,
      );
    });

    const routes: Record<string, string[]> = {
      pbx: [
        '/v1/tenants/:id/extensions',
        '/v1/tenants/:id/sip-endpoint',
        '/v1/tenants/:id/extensions/:extId/reveal',
      ],
      callflow: ['/v1/tenants/:id/flows/:flowId/versions/:n'],
      voicemail: ['/v1/tenants/:id/voicemail/mailboxes'],
      trunk: ['/v1/tenants/:id/trunks'],
      cdr: ['/v1/tenants/:id/cdrs'],
    };
    tenantServices = {};
    for (const [name, urls] of Object.entries(routes)) {
      tenantServices[name] = await startFakeDownstream(SECRET, (fake) => {
        if (name === 'pbx') {
          // A phone's settings: text, authenticated by the Basic header the
          // gateway must pass through, and a challenge it must pass back.
          fake.get(
            '/v1/public/provision/yealink/:file',
            { config: { public: true } },
            (request, reply) => {
              if (request.headers.authorization !== 'Basic cGhvbmU6cHc=') {
                void reply.status(401).header('www-authenticate', 'Basic realm="provisioning"');
                return 'Unauthorized\n';
              }
              void reply.type('text/plain; charset=utf-8');
              return '#!version:1.0.0.1\naccount.1.enable = 1\n';
            },
          );
        }
        for (const url of urls) {
          fake.get(
            url,
            {
              config: { permission: 'cdr.read', dataClass: name === 'cdr' ? 'private' : 'config' },
            },
            (request) => ({ service: name, tenantId: request.context.tenantId, rows: [] }),
          );
        }
      });
    }

    app = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: identity.url,
        ORG_SERVICE_URL: org.url,
        PBX_CONFIG_SERVICE_URL: tenantServices['pbx']!.url,
        CALLFLOW_SERVICE_URL: tenantServices['callflow']!.url,
        VOICEMAIL_SERVICE_URL: tenantServices['voicemail']!.url,
        CDR_SERVICE_URL: tenantServices['cdr']!.url,
        TRUNK_SERVICE_URL: tenantServices['trunk']!.url,
        RATE_LIMIT_IP_MAX: '100000',
        RATE_LIMIT_ACTOR_MAX: '100000',
      }),
      redis,
      jwksUrl: jwks.jwksUrl,
      rateLimitKeyPrefix: redisHandle.keyPrefix,
      ...baseServerOptions(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await identity.stop();
    await org.stop();
    for (const fake of Object.values(tenantServices)) await fake.stop();
    await jwks.stop();
    redis.disconnect();
    await redisHandle.stop();
  });

  it('proxies a public route with no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/public/brand' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ neutral: true });
  });

  it('proxies a public POST route, forwarding the body', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      payload: { orgId: 'o1', email: 'a@example.com', password: 'x' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok' });
  });

  it('forwards the refresh cookie and transport header to /v1/auth, and every Set-Cookie back', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: {
        cookie: 'refresh=old',
        'x-refresh-transport': 'cookie',
        'user-agent': 'a-browser/1.0',
        'x-forwarded-for': '203.0.113.9',
      },
      payload: {},
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      cookie: 'refresh=old',
      transport: 'cookie',
      userAgent: 'a-browser/1.0',
      forwardedFor: '203.0.113.9',
    });
    expect(response.headers['set-cookie']).toEqual([
      'refresh=new; Path=/v1/auth; HttpOnly',
      'other=1; Path=/',
    ]);
  });

  it("passes a phone's Basic credentials to the provisioning route, and its text answer and challenge back", async () => {
    const ok = await app.inject({
      method: 'GET',
      url: '/v1/public/provision/yealink/001565aabbcc.cfg',
      headers: { authorization: 'Basic cGhvbmU6cHc=' },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers['content-type']).toContain('text/plain');
    expect(ok.body).toBe('#!version:1.0.0.1\naccount.1.enable = 1\n');

    const challenge = await app.inject({
      method: 'GET',
      url: '/v1/public/provision/yealink/001565aabbcc.cfg',
    });
    expect(challenge.statusCode).toBe(401);
    expect(challenge.headers['www-authenticate']).toBe('Basic realm="provisioning"');
  });

  it('tells identity-service which hostname the browser used, and ignores a forged one', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/auth/refresh',
      headers: { host: 'portal.acme.example', 'x-forwarded-host': 'console.platform.test' },
      payload: {},
    });
    expect(response.json()).toMatchObject({ forwardedHost: 'portal.acme.example' });
  });

  it('does not forward cookies outside /v1/auth', async () => {
    const token = await mintAccessToken(jwks.privateKey, { org: 'org-1', ot: 'master' });
    const response = await app.inject({
      method: 'POST',
      url: '/v1/orgs/org-1/echo-cookie',
      headers: { authorization: `Bearer ${token}`, cookie: 'refresh=secret' },
      payload: {},
    });
    expect(response.json()).toEqual({ cookie: null });
  });

  it('rejects a protected route with no Authorization header', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/tenants/t1' });

    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ type: '/problems/unauthorized' });
  });

  it('rejects a malformed bearer token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: 'Bearer not-a-real-jwt' },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a token signed by a key the JWKS does not publish', async () => {
    const { generateKeyPair, SignJWT } = await import('jose');
    const { privateKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' });
    const forged = await new SignJWT({
      org: 'o1',
      ot: 'tenant',
      roles: [],
      perms: [],
      amr: ['pwd'],
      sid: 's1',
    })
      .setProtectedHeader({ alg: 'EdDSA', kid: 'not-the-real-key' })
      .setSubject('user-x')
      .setIssuedAt()
      .setExpirationTime('10m')
      .sign(privateKey);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${forged}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects an expired token', async () => {
    const token = await mintAccessToken(jwks.privateKey, {
      org: 'org-1',
      ot: 'tenant',
      expiresInSeconds: -10,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(401);
  });

  it('reports API-key auth as not implemented, distinctly from a bad credential', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: 'ApiKey some-key' },
    });

    expect(response.statusCode).toBe(501);
    expect(response.json()).toMatchObject({ code: 'api_key_auth_not_implemented' });
  });

  it('forwards a verified actor as a signed internal context a real downstream accepts', async () => {
    const token = await mintAccessToken(jwks.privateKey, {
      sub: 'user-42',
      org: 'tenant-9',
      ot: 'tenant',
      rsl: 'reseller-3',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: 't1',
      context: {
        actorId: 'user-42',
        actorType: 'user',
        orgId: 'tenant-9',
        orgType: 'tenant',
        resellerId: 'reseller-3',
        tenantId: 'tenant-9',
      },
    });
  });

  it.each([
    ['/v1/tenants/tenant-9/extensions', 'pbx'],
    ['/v1/tenants/tenant-9/extensions/e1/reveal', 'pbx'],
    ['/v1/tenants/tenant-9/sip-endpoint', 'pbx'],
    ['/v1/tenants/tenant-9/flows/f1/versions/2', 'callflow'],
    ['/v1/tenants/tenant-9/voicemail/mailboxes', 'voicemail'],
    ['/v1/tenants/tenant-9/trunks', 'trunk'],
    ['/v1/tenants/tenant-9/cdrs', 'cdr'],
  ])('sends %s to the %s service, still signed as the actor', async (url, service) => {
    const token = await mintAccessToken(jwks.privateKey, {
      sub: 'user-42',
      org: 'tenant-9',
      ot: 'tenant',
    });

    const response = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ service, tenantId: 'tenant-9' });
  });

  it('still sends the tenant record itself to org-service', async () => {
    const token = await mintAccessToken(jwks.privateKey, {
      sub: 'user-42',
      org: 'tenant-9',
      ot: 'tenant',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.json()).toMatchObject({ id: 't1' });
  });

  it('lets the downstream service enforce H1 on the forwarded org type', async () => {
    const resellerToken = await mintAccessToken(jwks.privateKey, {
      sub: 'reseller-user',
      org: 'reseller-3',
      ot: 'reseller',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1/cdrs',
      headers: { authorization: `Bearer ${resellerToken}` },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ code: 'reseller_private_data_denied' });
  });

  it('forwards a JSON body and returns the downstream response body unchanged', async () => {
    const token = await mintAccessToken(jwks.privateKey, { org: 'tenant-9', ot: 'tenant' });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/tenants/t1/echo',
      headers: { authorization: `Bearer ${token}` },
      payload: { hello: 'world' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ hello: 'world' });
  });

  it('returns 404 for a path no routing table entry covers', async () => {
    // Authenticated, so the request actually reaches the proxy handler —
    // an unauthenticated request to an unmapped path is correctly a 401
    // (no route existence is revealed pre-auth), covered separately above.
    const token = await mintAccessToken(jwks.privateKey, { org: 'tenant-9', ot: 'tenant' });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/nowhere',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
  });

  it('returns 503 when the downstream service is unreachable', async () => {
    const unreachable = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: identity.url,
        ORG_SERVICE_URL: 'http://127.0.0.1:1',
        RATE_LIMIT_IP_MAX: '100000',
        RATE_LIMIT_ACTOR_MAX: '100000',
      }),
      redis,
      jwksUrl: jwks.jwksUrl,
      rateLimitKeyPrefix: redisHandle.keyPrefix,
      ...baseServerOptions(),
    });
    await unreachable.ready();

    const response = await unreachable.inject({ method: 'GET', url: '/v1/public/brand' });

    expect(response.statusCode).toBe(503);
    await unreachable.close();
  });
});

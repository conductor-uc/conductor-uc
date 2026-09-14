import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
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

describe('api-gateway: rate limiting', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let jwks: FakeIdentityKeys;
  let org: FakeDownstream;
  const apps: Server[] = [];

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);
    jwks = await startFakeJwks();

    org = await startFakeDownstream(SECRET, (fake) => {
      fake.get('/v1/public/brand', { config: { public: true } }, () => ({ neutral: true }));
      fake.get(
        '/v1/tenants/:id',
        { config: { permission: 'tenant.read', dataClass: 'config' } },
        () => ({ ok: true }),
      );
    });
  });

  afterAll(async () => {
    for (const app of apps) await app.close();
    await org.stop();
    await jwks.stop();
    redis.disconnect();
    await redisHandle.stop();
  });

  afterEach(() => {
    apps.length = 0;
  });

  async function appWithLimits(overrides: Record<string, string>): Promise<Server> {
    const app = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: org.url,
        ORG_SERVICE_URL: org.url,
        ...overrides,
      }),
      redis,
      jwksUrl: jwks.jwksUrl,
      // Each test gets its own counter namespace: they all inject from the
      // same '127.0.0.1' and would otherwise share (and exhaust) one budget.
      rateLimitKeyPrefix: `${redisHandle.keyPrefix}${randomUUID()}:`,
      ...baseServerOptions(),
    });
    await app.ready();
    apps.push(app);
    return app;
  }

  it('limits requests from one IP and recovers once the window rolls', async () => {
    const app = await appWithLimits({
      RATE_LIMIT_IP_MAX: '2',
      RATE_LIMIT_IP_WINDOW_MS: '100000',
      RATE_LIMIT_ACTOR_MAX: '100000',
    });

    const first = await app.inject({ method: 'GET', url: '/v1/public/brand' });
    const second = await app.inject({ method: 'GET', url: '/v1/public/brand' });
    const third = await app.inject({ method: 'GET', url: '/v1/public/brand' });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    expect(third.statusCode).toBe(429);
    expect(third.json()).toMatchObject({ code: 'rate_limit_ip' });
    expect(third.headers['retry-after']).toBeDefined();
  });

  it('applies the IP limit to public routes too, protecting login from brute force', async () => {
    const app = await appWithLimits({
      RATE_LIMIT_IP_MAX: '1',
      RATE_LIMIT_IP_WINDOW_MS: '100000',
      RATE_LIMIT_ACTOR_MAX: '100000',
    });

    await app.inject({ method: 'GET', url: '/v1/public/brand' });
    const second = await app.inject({ method: 'GET', url: '/v1/public/brand' });

    expect(second.statusCode).toBe(429);
  });

  it('limits requests from one authenticated actor independently of other actors', async () => {
    const app = await appWithLimits({
      RATE_LIMIT_IP_MAX: '100000',
      RATE_LIMIT_ACTOR_MAX: '2',
      RATE_LIMIT_ACTOR_WINDOW_MS: '100000',
    });
    const tokenA = await mintAccessToken(jwks.privateKey, {
      sub: 'user-a',
      org: 'o1',
      ot: 'tenant',
    });
    const tokenB = await mintAccessToken(jwks.privateKey, {
      sub: 'user-b',
      org: 'o1',
      ot: 'tenant',
    });

    const a1 = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const a2 = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const a3 = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${tokenA}` },
    });
    const b1 = await app.inject({
      method: 'GET',
      url: '/v1/tenants/t1',
      headers: { authorization: `Bearer ${tokenB}` },
    });

    expect(a1.statusCode).toBe(200);
    expect(a2.statusCode).toBe(200);
    expect(a3.statusCode).toBe(429);
    expect(a3.json()).toMatchObject({ code: 'rate_limit_actor' });
    // A different actor's budget is untouched by user A's requests.
    expect(b1.statusCode).toBe(200);
  });

  it('does not rate-limit an anonymous request by actor, only by IP', async () => {
    const app = await appWithLimits({
      RATE_LIMIT_IP_MAX: '100000',
      RATE_LIMIT_ACTOR_MAX: '1',
    });

    const responses = await Promise.all(
      Array.from({ length: 5 }, () => app.inject({ method: 'GET', url: '/v1/public/brand' })),
    );

    for (const response of responses) expect(response.statusCode).toBe(200);
  });

  it('reports the limit and remaining budget on every response', async () => {
    const app = await appWithLimits({ RATE_LIMIT_IP_MAX: '10', RATE_LIMIT_ACTOR_MAX: '10' });

    const response = await app.inject({ method: 'GET', url: '/v1/public/brand' });

    expect(response.headers['x-ratelimit-limit']).toBe('10');
    expect(response.headers['x-ratelimit-remaining']).toBe('9');
  });
});

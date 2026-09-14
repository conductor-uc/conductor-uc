import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startTestRedis, type TestRedisHandle } from '@cuc/testing';
import { Redis } from 'ioredis';

import { buildApp } from '../src/app.js';
import type { Server } from '@cuc/http';
import { testConfig } from './config.js';
import {
  baseServerOptions,
  startFakeDownstream,
  startFakeJwks,
  type FakeDownstream,
  type FakeIdentityKeys,
} from './helpers.js';

const SECRET = 'test-internal-header-secret';

describe('api-gateway: CORS (06 — console hostnames)', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let jwks: FakeIdentityKeys;
  let org: FakeDownstream;
  let app: Server;

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);
    jwks = await startFakeJwks();
    org = await startFakeDownstream(SECRET, (fake) => {
      fake.get('/v1/public/brand', { config: { public: true } }, () => ({ neutral: true }));
    });

    app = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: org.url,
        ORG_SERVICE_URL: org.url,
        RATE_LIMIT_IP_MAX: '100000',
        RATE_LIMIT_ACTOR_MAX: '100000',
        CONSOLE_HOSTNAMES: 'console.example.com,admin.example.com',
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
    await org.stop();
    await jwks.stop();
    redis.disconnect();
    await redisHandle.stop();
  });

  it('allows a registered console hostname', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/public/brand',
      headers: { origin: 'https://console.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBe('https://console.example.com');
  });

  it('does not allow an origin outside the configured console hostnames', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/public/brand',
      headers: { origin: 'https://evil.example.com' },
    });

    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  });

  it('answers a preflight request for an allowed origin', async () => {
    const response = await app.inject({
      method: 'OPTIONS',
      url: '/v1/public/brand',
      headers: {
        origin: 'https://console.example.com',
        'access-control-request-method': 'GET',
      },
    });

    expect(response.statusCode).toBeLessThan(300);
    expect(response.headers['access-control-allow-origin']).toBe('https://console.example.com');
  });
});

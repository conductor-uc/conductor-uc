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

interface Health {
  checkedAt: string;
  services: {
    name: string;
    status: 'up' | 'degraded' | 'down';
    latencyMs: number;
    failing: string[];
  }[];
}

describe('api-gateway: GET /v1/platform/health', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let jwks: FakeIdentityKeys;
  let healthy: FakeDownstream;
  let degraded: FakeDownstream;
  let app: Server;

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);
    jwks = await startFakeJwks();
    healthy = await startFakeDownstream(SECRET, () => undefined);
    degraded = await startFakeDownstream(SECRET, (fake) => {
      fake.addReadinessCheck('database', () => ({ status: 'fail' }));
    });
    app = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: healthy.url,
        ORG_SERVICE_URL: healthy.url,
        // Something that answers, but is not ready.
        PBX_CONFIG_SERVICE_URL: degraded.url,
        // Nothing is listening here at all.
        CALLFLOW_SERVICE_URL: 'http://127.0.0.1:1',
        VOICEMAIL_SERVICE_URL: healthy.url,
        CDR_SERVICE_URL: healthy.url,
        TRUNK_SERVICE_URL: healthy.url,
        RECORDING_SERVICE_URL: healthy.url,
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
    await healthy.stop();
    await degraded.stop();
    await jwks.stop();
    redis.disconnect();
    await redisHandle.stop();
  });

  async function get(fields?: { org: string; ot: 'master' | 'reseller' | 'tenant' }) {
    const token = fields === undefined ? undefined : await mintAccessToken(jwks.privateKey, fields);
    return app.inject({
      method: 'GET',
      url: '/v1/platform/health',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it('tells the master which services are up, degraded, and down, and what is failing', async () => {
    const response = await get({ org: 'master-1', ot: 'master' });

    expect(response.statusCode).toBe(200);
    const body = response.json<Health>();
    const byName = Object.fromEntries(body.services.map((s) => [s.name, s]));
    expect(Object.keys(byName)).toEqual([
      'identity-service',
      'org-service',
      'pbx-config-service',
      'callflow-service',
      'voicemail-service',
      'cdr-service',
      'trunk-service',
      'recording-service',
    ]);
    expect(byName['org-service']).toMatchObject({ status: 'up', failing: [] });
    expect(byName['pbx-config-service']).toMatchObject({
      status: 'degraded',
      failing: ['database'],
    });
    expect(byName['callflow-service']).toMatchObject({ status: 'down', failing: [] });
    expect(Number.isNaN(Date.parse(body.checkedAt))).toBe(false);
  });

  it('is master only: a reseller or a tenant is refused', async () => {
    expect((await get({ org: 'r1', ot: 'reseller' })).statusCode).toBe(403);
    expect((await get({ org: 't1', ot: 'tenant' })).statusCode).toBe(403);
  });

  it('needs a signed-in actor', async () => {
    expect((await get()).statusCode).toBe(401);
  });
});

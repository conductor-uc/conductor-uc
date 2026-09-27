import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ProblemError, type Server } from '@cuc/http';
import { redisOrSkipReason, startTestRedis, type TestRedisHandle } from '@cuc/testing';
import { Redis } from 'ioredis';

import { buildApp, parseStatusTargets } from '../src/app.js';
import { testConfig } from './config.js';
import {
  baseServerOptions,
  mintAccessToken,
  startFakeDownstream,
  startFakeJwks,
  type FakeDownstream,
  type FakeIdentityKeys,
} from './helpers.js';

const skipReason = await redisOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TOKEN = 'test-internal-service-token';

type Json = Record<string, unknown>;

/** Registers an internal route that answers only the service token, like the real ones. */
function internal(app: Server, path: string, body: () => unknown): void {
  app.get(path, { config: { public: true } }, (request) => {
    if (request.headers.authorization !== `Bearer ${TOKEN}`) {
      throw ProblemError.unauthorized('token');
    }
    return body();
  });
}

describe.skipIf(skipReason !== undefined)('api-gateway: GET /v1/platform/overview (S4-12)', () => {
  let redisHandle: TestRedisHandle;
  let redis: Redis;
  let jwks: FakeIdentityKeys;
  let healthy: FakeDownstream;
  let degraded: FakeDownstream;
  let callControl: FakeDownstream;
  let telephony: FakeDownstream;
  let app: Server;
  /** Actor ids that hold `platform.observe`. */
  const observers = new Set(['admin-1']);

  beforeAll(async () => {
    redisHandle = await startTestRedis();
    redis = new Redis(redisHandle.url);
    jwks = await startFakeJwks();
    healthy = await startFakeDownstream(SECRET, (fake) => {
      fake.addStatusSection('outbox', () => ({ pending: 3, oldestPendingSeconds: 12, failed: 1 }));
    });
    degraded = await startFakeDownstream(SECRET, (fake) => {
      fake.addReadinessCheck('database', () => ({ status: 'fail' }));
    });
    callControl = await startFakeDownstream(SECRET, (fake) => {
      internal(fake, '/internal/v1/nodes', () => ({
        nodes: [
          {
            nodeId: 'fs1',
            status: 'up',
            draining: false,
            calls: 4,
            leases: 1,
            sessions: 8,
            maxSessions: 1000,
            cpuIdlePercent: 91.5,
            sessionsPerSecond: 1,
            uptimeSeconds: 900,
            heartbeatAt: '2026-09-27T22:00:00.000Z',
          },
          {
            nodeId: 'fs2',
            status: 'draining',
            draining: true,
            calls: 1,
            leases: 0,
            sessions: null,
            maxSessions: null,
            cpuIdlePercent: null,
            sessionsPerSecond: null,
            uptimeSeconds: null,
            heartbeatAt: null,
          },
          {
            nodeId: 'fs3',
            status: 'up',
            draining: false,
            calls: 0,
            leases: 0,
            sessions: null,
            maxSessions: null,
            cpuIdlePercent: null,
            sessionsPerSecond: null,
            uptimeSeconds: null,
            heartbeatAt: null,
          },
        ],
      }));
    });
    telephony = await startFakeDownstream(SECRET, (fake) => {
      internal(fake, '/internal/v1/platform/status', () => ({
        signalling: { status: 'up', registrations: 42, activeDialogs: 5 },
        dispatcher: [
          { uri: 'sip:fs1:5060', nodeId: 'fs1', state: 'active', weight: 3 },
          { uri: 'sip:fs2:5060', nodeId: 'fs2', state: 'inactive', weight: 1 },
        ],
        mariadb: {
          name: 'mariadb',
          status: 'up',
          version: '11.4.8',
          uptimeSeconds: 100,
          facts: [{ label: 'Connections', value: 9, unit: 'count' }],
        },
      }));
    });
    app = await buildApp({
      config: testConfig({
        IDENTITY_SERVICE_URL: healthy.url,
        ORG_SERVICE_URL: healthy.url,
        PBX_CONFIG_SERVICE_URL: degraded.url,
        CALLFLOW_SERVICE_URL: 'http://127.0.0.1:1',
        VOICEMAIL_SERVICE_URL: healthy.url,
        CDR_SERVICE_URL: healthy.url,
        TRUNK_SERVICE_URL: healthy.url,
        RECORDING_SERVICE_URL: healthy.url,
        CALL_CONTROL_URL: callControl.url,
        TELEPHONY_CONFIG_URL: telephony.url,
        PLATFORM_STATUS_TARGETS: `media-worker=${healthy.url}`,
        INTERNAL_SERVICE_TOKEN: TOKEN,
        REDIS_URL: redisHandle.url,
      }),
      redis,
      jwksUrl: jwks.jwksUrl,
      rateLimitKeyPrefix: redisHandle.keyPrefix,
      platform: {
        permissions: (actor, permission) =>
          Promise.resolve(permission === 'platform.observe' && observers.has(actor.id)),
      },
      ...baseServerOptions(),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await Promise.all([healthy, degraded, callControl, telephony].map((fake) => fake?.stop()));
    await jwks?.stop();
    redis?.disconnect();
    await redisHandle?.stop();
  });

  async function get(fields?: { sub?: string; org: string; ot: 'master' | 'reseller' | 'tenant' }) {
    const token = fields === undefined ? undefined : await mintAccessToken(jwks.privateKey, fields);
    return app.inject({
      method: 'GET',
      url: '/v1/platform/overview',
      headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
    });
  }

  it('gathers services, media nodes with their dispatcher weight, the SIP edge and the stores', async () => {
    const response = await get({ sub: 'admin-1', org: 'master-1', ot: 'master' });

    expect(response.statusCode, response.body).toBe(200);
    const body = response.json<Json>();
    const services = Object.fromEntries(
      (body['services'] as Json[]).map((service) => [service['name'], service]),
    );
    expect(Object.keys(services)).toEqual([
      'api-gateway',
      'identity-service',
      'org-service',
      'pbx-config-service',
      'callflow-service',
      'voicemail-service',
      'cdr-service',
      'trunk-service',
      'recording-service',
      'call-control',
      'telephony-config',
      'media-worker',
    ]);
    expect(services['api-gateway']).toMatchObject({ status: 'up' });
    expect(services['org-service']).toMatchObject({
      status: 'up',
      outbox: { pending: 3, oldestPendingSeconds: 12, failed: 1 },
    });
    expect(services['pbx-config-service']).toMatchObject({
      status: 'degraded',
      checks: [{ name: 'database', status: 'fail' }],
    });
    expect(services['callflow-service']).toMatchObject({ status: 'down', outbox: null });

    expect(body['nodes']).toMatchObject([
      { nodeId: 'fs1', weight: 3, dispatcher: 'active', uri: 'sip:fs1:5060', cpuIdlePercent: 91.5 },
      { nodeId: 'fs2', weight: 1, dispatcher: 'inactive', draining: true },
      { nodeId: 'fs3', weight: null, dispatcher: 'absent', uri: null },
    ]);
    expect(body['signalling']).toMatchObject({ status: 'up', registrations: 42 });
    // No NATS connection in this test.
    expect(body['events']).toBeNull();

    const stores = Object.fromEntries(
      (body['dataStores'] as Json[]).map((store) => [store['name'], store]),
    );
    expect(stores['mariadb']).toMatchObject({ status: 'up', version: '11.4.8' });
    expect(stores['redis']).toMatchObject({ status: 'up' });
    expect((stores['redis']?.['facts'] as { label: string }[]).map((fact) => fact.label)).toContain(
      'Memory used',
    );
    expect(stores['nats']).toMatchObject({ status: 'down' });
  });

  it('refuses a master user without platform.observe, any reseller or tenant, and no sign-in', async () => {
    expect((await get({ sub: 'someone', org: 'master-1', ot: 'master' })).statusCode).toBe(403);
    expect((await get({ sub: 'admin-1', org: 'r1', ot: 'reseller' })).statusCode).toBe(403);
    expect((await get({ sub: 'admin-1', org: 't1', ot: 'tenant' })).statusCode).toBe(403);
    expect((await get()).statusCode).toBe(401);
  });

  it('reads PLATFORM_STATUS_TARGETS, and refuses a malformed one', () => {
    expect(parseStatusTargets(['uploader-fs1=http://10.0.0.1:8108'])).toEqual([
      { name: 'uploader-fs1', url: 'http://10.0.0.1:8108' },
    ]);
    expect(() => parseStatusTargets(['no-url'])).toThrow(/PLATFORM_STATUS_TARGETS/);
    expect(() => parseStatusTargets(['x=ftp://host'])).toThrow(/PLATFORM_STATUS_TARGETS/);
  });
});

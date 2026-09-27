import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from '@cuc/http';
import { redisOrSkipReason, startTestRedis, type TestRedisHandle } from '@cuc/testing';
import { Redis } from 'ioredis';

import { buildApp } from '../src/app.js';
import { CHARTS } from '../src/platform-history.js';
import { testConfig } from './config.js';
import {
  baseServerOptions,
  mintAccessToken,
  startFakeJwks,
  type FakeIdentityKeys,
} from './helpers.js';

const skipReason = await redisOrSkipReason();

describe.skipIf(skipReason !== undefined)(
  'api-gateway: GET /v1/platform/metrics/:chart (S4-13)',
  () => {
    let redisHandle: TestRedisHandle;
    let redis: Redis;
    let jwks: FakeIdentityKeys;
    let prometheus: HttpServer;
    let asked: URL[] = [];
    let app: Server;
    let bare: Server;

    beforeAll(async () => {
      redisHandle = await startTestRedis();
      redis = new Redis(redisHandle.url);
      jwks = await startFakeJwks();
      prometheus = createHttpServer((request, response) => {
        asked.push(new URL(request.url ?? '/', 'http://prometheus'));
        response.writeHead(200, { 'content-type': 'application/json' });
        response.end(
          JSON.stringify({
            status: 'success',
            data: {
              resultType: 'matrix',
              result: [
                {
                  metric: { node: 'fs2' },
                  values: [
                    [1000, '1'],
                    [1030, 'NaN'],
                    [1060, '2'],
                  ],
                },
                { metric: { node: 'fs1' }, values: [[1000, '4']] },
              ],
            },
          }),
        );
      });
      await new Promise<void>((resolve) => prometheus.listen(0, '127.0.0.1', resolve));
      const port = (prometheus.address() as AddressInfo).port;

      const build = (extra: Record<string, string>) =>
        buildApp({
          config: testConfig({
            INTERNAL_SERVICE_TOKEN: 'test-internal-service-token',
            REDIS_URL: redisHandle.url,
            ...extra,
          }),
          redis,
          jwksUrl: jwks.jwksUrl,
          rateLimitKeyPrefix: redisHandle.keyPrefix,
          platform: {
            permissions: (actor, permission) =>
              Promise.resolve(permission === 'platform.observe' && actor.id === 'observer'),
          },
          ...baseServerOptions(),
        });
      app = await build({ PROMETHEUS_URL: `http://127.0.0.1:${String(port)}` });
      bare = await build({});
      await Promise.all([app.ready(), bare.ready()]);
    });

    afterAll(async () => {
      await app?.close();
      await bare?.close();
      await new Promise((resolve) => prometheus?.close(resolve));
      await jwks?.stop();
      redis?.disconnect();
      await redisHandle?.stop();
    });

    async function get(
      target: Server,
      url: string,
      sub = 'observer',
      ot: 'master' | 'reseller' = 'master',
    ) {
      const token = await mintAccessToken(jwks.privateKey, { sub, org: 'org-1', ot });
      return target.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    }

    it("answers a chart from the catalog's own query, with one line per label and no NaN", async () => {
      asked = [];
      const response = await get(app, '/v1/platform/metrics/calls-by-node?range=6h');

      expect(response.statusCode, response.body).toBe(200);
      expect(response.json()).toEqual({
        chart: 'calls-by-node',
        unit: 'count',
        range: '6h',
        stepSeconds: 180,
        series: [
          { label: 'fs1', points: [[1000, 4]] },
          {
            label: 'fs2',
            points: [
              [1000, 1],
              [1060, 2],
            ],
          },
        ],
      });
      expect(asked[0]?.pathname).toBe('/api/v1/query_range');
      expect(asked[0]?.searchParams.get('query')).toBe(CHARTS['calls-by-node']?.query);
      expect(asked[0]?.searchParams.get('step')).toBe('180');
    });

    it('refuses an unknown chart, a bad range, a master without the permission and a reseller', async () => {
      expect((await get(app, '/v1/platform/metrics/anything-else')).json()).toMatchObject({
        code: 'unknown_chart',
      });
      expect((await get(app, '/v1/platform/metrics/node-cpu?range=1y')).statusCode).toBe(400);
      expect((await get(app, '/v1/platform/metrics/node-cpu', 'someone')).statusCode).toBe(403);
      expect(
        (await get(app, '/v1/platform/metrics/node-cpu', 'observer', 'reseller')).statusCode,
      ).toBe(403);
    });

    it('says history is unavailable without a Prometheus', async () => {
      const response = await get(bare, '/v1/platform/metrics/registrations');
      expect(response.statusCode).toBe(503);
      expect(response.json()).toMatchObject({ code: 'history_unavailable' });
    });

    it("exposes the gateway's own gauges on /metrics", async () => {
      const response = await app.inject({ method: 'GET', url: '/metrics' });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('redis_connected_clients');
    });
  },
);

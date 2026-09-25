import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from '@cuc/http';
import {
  redisOrSkipReason,
  silentLogger,
  startTestRedis,
  type TestRedisHandle,
} from '@cuc/testing';
import { Redis } from 'ioredis';

import type { AffinityManager } from '../src/affinity/manager.js';
import { createCallRegistry, type CallRegistry } from '../src/redis/registry.js';
import { registerInternalRoutes } from '../src/routes/internal.routes.js';

const skipReason = await redisOrSkipReason();
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/tenants/:tenantId/calls (S5-08)',
  () => {
    let redisHandle: TestRedisHandle;
    let redis: Redis;
    let registry: CallRegistry;
    let app: Server;

    beforeAll(async () => {
      redisHandle = await startTestRedis();
      redis = new Redis(redisHandle.url);
      registry = createCallRegistry(redis, redisHandle.keyPrefix);
      app = await createServer({ serviceName: 'call-control-test', logger: silentLogger() });
      // The live-calls route needs no affinity lease; nothing here calls one.
      registerInternalRoutes(app, {} as AffinityManager, TOKEN, registry);
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      redis?.disconnect();
      await redisHandle?.stop();
    });

    async function createCall(tenantId: string | null, from: string): Promise<string> {
      const callUuid = crypto.randomUUID();
      await registry.createCall(
        {
          callUuid,
          nodeId: 'fs-1',
          tenantId,
          direction: 'inbound',
          state: 'ringing',
          startedAt: String(Date.now()),
          from,
          to: '102',
        },
        60_000,
      );
      return callUuid;
    }

    it('returns the tenant live calls and nobody else', async () => {
      const tenantId = crypto.randomUUID();
      const mine = await createCall(tenantId, '101');
      await createCall(crypto.randomUUID(), '201');
      await createCall(null, '+15550001111');

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/calls`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ calls: { callUuid: string; tenantId: string }[] }>();
      expect(body.calls).toEqual([
        expect.objectContaining({
          callUuid: mine,
          tenantId,
          nodeId: 'fs-1',
          direction: 'inbound',
          state: 'ringing',
          from: '101',
          to: '102',
          answeredAt: null,
          bridgedTo: null,
          recording: 'off',
        }),
      ]);
    });

    it('returns an empty list for a tenant with no calls', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/calls`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ calls: [] });
    });

    it('refuses a caller without the internal service token', async () => {
      const tenantId = crypto.randomUUID();
      await createCall(tenantId, '101');
      for (const authorization of [undefined, 'Bearer wrong', `Basic ${TOKEN}`]) {
        const response = await app.inject({
          method: 'GET',
          url: `/internal/v1/tenants/${tenantId}/calls`,
          ...(authorization === undefined ? {} : { headers: { authorization } }),
        });
        expect(response.statusCode, String(authorization)).toBe(401);
      }
    });
  },
);

import { createServer } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { registerProxy } from '../src/routing/proxy.js';
import { startFakeDownstream, type FakeDownstream } from './helpers.js';

const SECRET = 'test-internal-header-secret';

/**
 * S5-09/S5-10: listen, whisper and barge answer only once the supervisor's phone has, so the
 * proxy gives them their own, longer limit, and every other request keeps the usual one.
 */
describe('proxy timeouts', () => {
  let upstream: FakeDownstream;

  beforeAll(async () => {
    upstream = await startFakeDownstream(SECRET, (fake) => {
      const slow = async () => {
        await new Promise((resolve) => setTimeout(resolve, 600));
        return { answered: true };
      };
      fake.post('/v1/tenants/:t/calls/:c/whisper', { config: { public: true } }, slow);
      fake.post('/v1/tenants/:t/calls/:c/recording', { config: { public: true } }, slow);
    });
  });

  afterAll(async () => {
    await upstream?.stop();
  });

  async function gateway() {
    const app = await createServer({ serviceName: 'test-gateway', logger: silentLogger() });
    registerProxy(app, {
      table: [
        {
          prefix: '/v1/tenants/*/calls',
          target: upstream.url,
          segments: ['v1', 'tenants', '*', 'calls'],
        },
      ],
      timeoutMs: 200,
      slowRoutes: [
        {
          method: 'POST',
          path: /^\/v1\/tenants\/[^/]+\/calls\/[^/]+\/(?:listen|whisper|barge)$/,
          timeoutMs: 2_000,
        },
      ],
      internalHeaderSigningSecret: SECRET,
    });
    await app.ready();
    return app;
  }

  it('waits for a monitor route past the usual limit, and not for anything else', async () => {
    const app = await gateway();
    try {
      const whisper = await app.inject({ method: 'POST', url: '/v1/tenants/t1/calls/c1/whisper' });
      expect(whisper.statusCode, whisper.body).toBe(200);
      expect(whisper.json()).toEqual({ answered: true });

      const recording = await app.inject({
        method: 'POST',
        url: '/v1/tenants/t1/calls/c1/recording',
      });
      expect(recording.statusCode).toBe(503);
      expect(recording.json()).toMatchObject({ detail: 'The upstream service did not respond.' });
    } finally {
      await app.close();
    }
  });
});

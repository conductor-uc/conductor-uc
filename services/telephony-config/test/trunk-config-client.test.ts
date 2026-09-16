import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createTrunkConfigClient, TrunkConfigClientError } from '../src/trunk-config-client.js';

const TOKEN = 'test-internal-service-token';

const SAMPLE_TRUNK = {
  id: 'trunk1',
  tenantId: 'tenant1',
  name: 'Primary carrier',
  authMode: 'register',
  host: 'sip.carrier.test',
  port: 5060,
  transport: 'udp',
  username: 'trunkuser',
  secret: 's3cret-password',
  fromDomain: 'acme.platform.test',
  status: 'active',
  ips: [],
};

/**
 * A real HTTP server standing in for trunk-service's internal routes, so
 * this proves the client's wire behavior (path, headers, status handling)
 * rather than mocking `fetch` (`pbx-config-client.test.ts`'s identical
 * pattern).
 */
async function fakeTrunkService(
  handler: (req: IncomingMessage, res: ServerResponse) => void,
): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${String(address.port)}`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('createTrunkConfigClient', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  describe('findTrunk', () => {
    it('GETs the right path with a bearer token', async () => {
      let seenPath: string | undefined;
      let seenAuth: string | undefined;
      const fake = await fakeTrunkService((req, res) => {
        seenPath = req.url;
        seenAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(SAMPLE_TRUNK));
      });
      close = fake.close;

      const client = createTrunkConfigClient({
        baseUrl: fake.baseUrl,
        internalServiceToken: TOKEN,
      });
      const result = await client.findTrunk('tenant1', 'trunk1');

      expect(seenPath).toBe('/internal/v1/tenants/tenant1/trunks/trunk1');
      expect(seenAuth).toBe(`Bearer ${TOKEN}`);
      expect(result).toEqual(SAMPLE_TRUNK);
    });

    it('returns undefined on a 404', async () => {
      const fake = await fakeTrunkService((_req, res) => {
        res.writeHead(404, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Not Found' }));
      });
      close = fake.close;

      const client = createTrunkConfigClient({
        baseUrl: fake.baseUrl,
        internalServiceToken: TOKEN,
      });
      await expect(client.findTrunk('tenant1', 'missing')).resolves.toBeUndefined();
    });

    it('throws TrunkConfigClientError on any other non-2xx status', async () => {
      const fake = await fakeTrunkService((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Internal error' }));
      });
      close = fake.close;

      const client = createTrunkConfigClient({
        baseUrl: fake.baseUrl,
        internalServiceToken: TOKEN,
      });
      await expect(client.findTrunk('tenant1', 'trunk1')).rejects.toThrow(TrunkConfigClientError);
    });

    it('throws TrunkConfigClientError when the server is unreachable', async () => {
      const client = createTrunkConfigClient({
        baseUrl: 'http://127.0.0.1:1',
        internalServiceToken: TOKEN,
      });
      await expect(client.findTrunk('tenant1', 'trunk1')).rejects.toThrow(TrunkConfigClientError);
    });
  });

  describe('listAllTrunks', () => {
    it('GETs /internal/v1/trunks and returns every row', async () => {
      let seenPath: string | undefined;
      const fake = await fakeTrunkService((req, res) => {
        seenPath = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows: [SAMPLE_TRUNK] }));
      });
      close = fake.close;

      const client = createTrunkConfigClient({
        baseUrl: fake.baseUrl,
        internalServiceToken: TOKEN,
      });
      const result = await client.listAllTrunks();

      expect(seenPath).toBe('/internal/v1/trunks');
      expect(result).toEqual([SAMPLE_TRUNK]);
    });

    it('throws TrunkConfigClientError on a non-2xx status', async () => {
      const fake = await fakeTrunkService((_req, res) => {
        res.writeHead(500, { 'content-type': 'application/problem+json' });
        res.end(JSON.stringify({ title: 'Internal error' }));
      });
      close = fake.close;

      const client = createTrunkConfigClient({
        baseUrl: fake.baseUrl,
        internalServiceToken: TOKEN,
      });
      await expect(client.listAllTrunks()).rejects.toThrow(TrunkConfigClientError);
    });
  });

  it('tolerates a trailing slash on baseUrl', async () => {
    let seenPath: string | undefined;
    const fake = await fakeTrunkService((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(SAMPLE_TRUNK));
    });
    close = fake.close;

    const client = createTrunkConfigClient({
      baseUrl: `${fake.baseUrl}/`,
      internalServiceToken: TOKEN,
    });
    await client.findTrunk('tenant1', 'trunk1');
    expect(seenPath).toBe('/internal/v1/tenants/tenant1/trunks/trunk1');
  });
});

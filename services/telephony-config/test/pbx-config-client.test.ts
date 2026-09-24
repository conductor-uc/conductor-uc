import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createPbxConfigClient, PbxConfigClientError } from '../src/pbx-config-client.js';

const TOKEN = 'test-internal-service-token';

/**
 * A real HTTP server standing in for pbx-config-service's
 * `GET /internal/v1/tenants/:tenantId/extensions/:id`, so this proves the
 * client's wire behavior (path, headers, status handling) rather than
 * mocking `fetch`.
 */
async function fakePbxConfigService(
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

describe('createPbxConfigClient', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('GETs the right path with a bearer token', async () => {
    let seenPath: string | undefined;
    let seenAuth: string | undefined;
    const fake = await fakePbxConfigService((req, res) => {
      seenPath = req.url;
      seenAuth = req.headers.authorization;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          extensionId: 'ext1',
          number: '101',
          username: '101',
          ha1: 'a'.repeat(32),
          ha1b: 'b'.repeat(32),
          realm: 'acme.platform.test',
        }),
      );
    });
    close = fake.close;

    const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
    const result = await client.findCredential('tenant1', 'ext1');

    expect(seenPath).toBe('/internal/v1/tenants/tenant1/extensions/ext1');
    expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    expect(result).toEqual({
      extensionId: 'ext1',
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      ha1b: 'b'.repeat(32),
      realm: 'acme.platform.test',
    });
  });

  it('returns undefined on a 404', async () => {
    const fake = await fakePbxConfigService((_req, res) => {
      res.writeHead(404, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Not Found' }));
    });
    close = fake.close;

    const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
    await expect(client.findCredential('tenant1', 'missing')).resolves.toBeUndefined();
  });

  it('throws PbxConfigClientError on any other non-2xx status', async () => {
    const fake = await fakePbxConfigService((_req, res) => {
      res.writeHead(500, { 'content-type': 'application/problem+json' });
      res.end(JSON.stringify({ title: 'Internal error' }));
    });
    close = fake.close;

    const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
    await expect(client.findCredential('tenant1', 'ext1')).rejects.toThrow(PbxConfigClientError);
  });

  it('throws PbxConfigClientError when the server is unreachable', async () => {
    const client = createPbxConfigClient({
      baseUrl: 'http://127.0.0.1:1',
      internalServiceToken: TOKEN,
    });
    await expect(client.findCredential('tenant1', 'ext1')).rejects.toThrow(PbxConfigClientError);
  });

  it('tolerates a trailing slash on baseUrl', async () => {
    let seenPath: string | undefined;
    const fake = await fakePbxConfigService((req, res) => {
      seenPath = req.url;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          extensionId: 'ext1',
          number: '101',
          username: '101',
          ha1: 'a'.repeat(32),
          ha1b: 'b'.repeat(32),
          realm: 'acme.platform.test',
        }),
      );
    });
    close = fake.close;

    const client = createPbxConfigClient({
      baseUrl: `${fake.baseUrl}/`,
      internalServiceToken: TOKEN,
    });
    await client.findCredential('tenant1', 'ext1');
    expect(seenPath).toBe('/internal/v1/tenants/tenant1/extensions/ext1');
  });

  describe('call handling (parity 1a)', () => {
    const doc = {
      dnd: false,
      dndAction: 'voicemail',
      forwardAlways: { type: 'external', e164: '+14155552671' },
      forwardBusy: null,
      forwardNoAnswer: null,
      noAnswerSeconds: 20,
      forwardUnreachable: null,
      simultaneousRing: [],
    };

    it('findCallHandling GETs the extension path with the bearer token and returns the document', async () => {
      let seenPath: string | undefined;
      let seenAuth: string | undefined;
      const fake = await fakePbxConfigService((req, res) => {
        seenPath = req.url;
        seenAuth = req.headers.authorization;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(doc));
      });
      close = fake.close;
      const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

      expect(await client.findCallHandling('tenant1', 'ext1')).toEqual(doc);
      expect(seenPath).toBe('/internal/v1/tenants/tenant1/extensions/ext1/call-handling');
      expect(seenAuth).toBe(`Bearer ${TOKEN}`);
    });

    it('findCallHandling returns undefined on 404 and throws on other errors', async () => {
      let status = 404;
      const fake = await fakePbxConfigService((_req, res) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ title: 'nope' }));
      });
      close = fake.close;
      const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

      expect(await client.findCallHandling('t', 'e')).toBeUndefined();
      status = 500;
      await expect(client.findCallHandling('t', 'e')).rejects.toBeInstanceOf(PbxConfigClientError);
    });

    it('listCallHandling reads the tenant list and keeps the extension id with each document', async () => {
      let seenPath: string | undefined;
      const fake = await fakePbxConfigService((req, res) => {
        seenPath = req.url;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ rows: [{ extensionId: 'ext1', ...doc }] }));
      });
      close = fake.close;
      const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });

      expect(await client.listCallHandling('tenant1')).toEqual([
        { extensionId: 'ext1', settings: doc },
      ]);
      expect(seenPath).toBe('/internal/v1/tenants/tenant1/call-handling');
    });

    it('drops a malformed destination it is handed instead of passing it on', async () => {
      const fake = await fakePbxConfigService((_req, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ...doc, forwardAlways: { type: 'external', e164: '1,2' } }));
      });
      close = fake.close;
      const client = createPbxConfigClient({ baseUrl: fake.baseUrl, internalServiceToken: TOKEN });
      expect((await client.findCallHandling('t', 'e'))?.forwardAlways).toBeNull();
    });
  });
});

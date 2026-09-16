import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import { createOpenSipsMiClient, OpenSipsMiClientError } from '../src/opensips-mi-client.js';

/**
 * A real HTTP server standing in for OpenSIPs' `mi_http` module, so this
 * proves the client sends real JSON-RPC 2.0 over HTTP
 * (docs.opensips.org/docs/modules/3.6.x/mi_http.html) rather than mocking
 * `fetch`.
 */
async function fakeMiHttp(
  handler: (req: IncomingMessage, body: unknown, res: ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      handler(req, raw === '' ? undefined : (JSON.parse(raw) as unknown), res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no address');
  return {
    url: `http://127.0.0.1:${String(address.port)}/mi`,
    close: () =>
      new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve()))),
  };
}

describe('createOpenSipsMiClient', () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  it('POSTs a JSON-RPC 2.0 body with the method name', async () => {
    let seenBody: unknown;
    let seenMethod: string | undefined;
    let seenContentType: string | undefined;
    const fake = await fakeMiHttp((req, body, res) => {
      seenBody = body;
      seenMethod = req.method;
      seenContentType = req.headers['content-type'];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
    });
    close = fake.close;

    const client = createOpenSipsMiClient({ url: fake.url });
    await client.call('domain_reload');

    expect(seenMethod).toBe('POST');
    expect(seenContentType).toBe('application/json');
    expect(seenBody).toEqual({ jsonrpc: '2.0', method: 'domain_reload', id: 1 });
  });

  it('throws OpenSipsMiClientError on a JSON-RPC error response', async () => {
    const fake = await fakeMiHttp((_req, _body, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -1, message: 'no such command' } }));
    });
    close = fake.close;

    const client = createOpenSipsMiClient({ url: fake.url });
    await expect(client.call('bogus_reload')).rejects.toThrow(OpenSipsMiClientError);
  });

  it('throws OpenSipsMiClientError on a non-2xx HTTP status', async () => {
    const fake = await fakeMiHttp((_req, _body, res) => {
      res.writeHead(500);
      res.end('internal error');
    });
    close = fake.close;

    const client = createOpenSipsMiClient({ url: fake.url });
    await expect(client.call('domain_reload')).rejects.toThrow(OpenSipsMiClientError);
  });

  it('throws OpenSipsMiClientError when the server is unreachable', async () => {
    const client = createOpenSipsMiClient({ url: 'http://127.0.0.1:1/mi' });
    await expect(client.call('domain_reload')).rejects.toThrow(OpenSipsMiClientError);
  });

  describe('query', () => {
    it('sends positional params and returns the result field', async () => {
      let seenBody: unknown;
      const fake = await fakeMiHttp((_req, body, res) => {
        seenBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: { Records: [{ State: 3 }] }, id: 1 }));
      });
      close = fake.close;

      const client = createOpenSipsMiClient({ url: fake.url });
      const result = await client.query<{ Records: { State: number }[] }>('reg_list', [
        'sip:alice@opensips.org',
        'sip:opensips-cluster:5060',
        'sip:carrier.example.com',
      ]);

      expect(seenBody).toEqual({
        jsonrpc: '2.0',
        method: 'reg_list',
        id: 1,
        params: ['sip:alice@opensips.org', 'sip:opensips-cluster:5060', 'sip:carrier.example.com'],
      });
      expect(result).toEqual({ Records: [{ State: 3 }] });
    });

    it('omits params entirely when none are given', async () => {
      let seenBody: unknown;
      const fake = await fakeMiHttp((_req, body, res) => {
        seenBody = body;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ jsonrpc: '2.0', result: {}, id: 1 }));
      });
      close = fake.close;

      const client = createOpenSipsMiClient({ url: fake.url });
      await client.query('reg_list');

      expect(seenBody).toEqual({ jsonrpc: '2.0', method: 'reg_list', id: 1 });
    });

    it('throws OpenSipsMiClientError on a JSON-RPC error response', async () => {
      const fake = await fakeMiHttp((_req, _body, res) => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({ jsonrpc: '2.0', error: { code: -1, message: 'no such command' } }),
        );
      });
      close = fake.close;

      const client = createOpenSipsMiClient({ url: fake.url });
      await expect(client.query('bogus_command')).rejects.toThrow(OpenSipsMiClientError);
    });
  });
});

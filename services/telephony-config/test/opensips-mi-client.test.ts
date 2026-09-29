import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';

import {
  createOpenSipsMiClient,
  isTagActive,
  OpenSipsMiClientError,
} from '../src/opensips-mi-client.js';

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

    const client = createOpenSipsMiClient({ urls: [fake.url] });
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

    const client = createOpenSipsMiClient({ urls: [fake.url] });
    await expect(client.call('bogus_reload')).rejects.toThrow(OpenSipsMiClientError);
  });

  it('throws OpenSipsMiClientError on a non-2xx HTTP status', async () => {
    const fake = await fakeMiHttp((_req, _body, res) => {
      res.writeHead(500);
      res.end('internal error');
    });
    close = fake.close;

    const client = createOpenSipsMiClient({ urls: [fake.url] });
    await expect(client.call('domain_reload')).rejects.toThrow(OpenSipsMiClientError);
  });

  it('throws OpenSipsMiClientError when the server is unreachable', async () => {
    const client = createOpenSipsMiClient({ urls: ['http://127.0.0.1:1/mi'] });
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

      const client = createOpenSipsMiClient({ urls: [fake.url] });
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

      const client = createOpenSipsMiClient({ urls: [fake.url] });
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

      const client = createOpenSipsMiClient({ urls: [fake.url] });
      await expect(client.query('bogus_command')).rejects.toThrow(OpenSipsMiClientError);
    });
  });
});

describe('the edge pair (S4-06)', () => {
  const closers: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(closers.splice(0).map((close) => close()));
  });

  /** One edge: records the methods it was sent, and says whether it holds `vip/1`. */
  async function edge(state: { active: boolean }) {
    const seen: string[] = [];
    const fake = await fakeMiHttp((_req, body, res) => {
      const method = (body as { method: string }).method;
      seen.push(method);
      const result =
        method === 'clusterer_list_shtags'
          ? [{ Tag: 'vip', Cluster: 1, State: state.active ? 'active' : 'backup' }]
          : { edge: state.active ? 'active' : 'backup' };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', result, id: 1 }));
    });
    closers.push(fake.close);
    return { url: fake.url, seen, close: fake.close };
  }

  it('reloads every edge, and asks the active one', async () => {
    const one = { active: false };
    const two = { active: true };
    const [a, b] = await Promise.all([edge(one), edge(two)]);
    const client = createOpenSipsMiClient({ urls: [a.url, b.url], activeCacheMs: 0 });

    await client.call('dr_reload');
    expect(a.seen).toContain('dr_reload');
    expect(b.seen).toContain('dr_reload');

    expect(await client.query('reg_list')).toEqual({ edge: 'active' });
    expect(a.seen).not.toContain('reg_list');

    // A failover: the other edge is now the active one.
    one.active = true;
    two.active = false;
    expect(await client.query('reg_list')).toEqual({ edge: 'active' });
    expect(a.seen).toContain('reg_list');
  });

  it('reloads while one edge is down, and fails only when every edge is', async () => {
    const a = await edge({ active: true });
    const unreachable = 'http://127.0.0.1:1/mi';
    await createOpenSipsMiClient({ urls: [a.url, unreachable] }).call('domain_reload');
    expect(a.seen).toContain('domain_reload');
    await expect(
      createOpenSipsMiClient({ urls: [unreachable, 'http://127.0.0.1:2/mi'] }).call(
        'domain_reload',
      ),
    ).rejects.toBeInstanceOf(OpenSipsMiClientError);
  });

  it('asks the first reachable edge when none says it is active', async () => {
    const a = await edge({ active: false });
    const client = createOpenSipsMiClient({ urls: ['http://127.0.0.1:1/mi', a.url] });
    expect(await client.query('ul_dump')).toEqual({ edge: 'backup' });
  });
});

describe('isTagActive', () => {
  it('reads the tag and its state', () => {
    expect(isTagActive([{ Tag: 'vip', Cluster: 1, State: 'active' }], 'vip/1')).toBe(true);
    expect(isTagActive([{ Tag: 'vip', Cluster: 1, State: 'backup' }], 'vip/1')).toBe(false);
    expect(isTagActive({ Tags: [{ tag: 'vip/1', state: 'Active' }] }, 'vip/1')).toBe(true);
    expect(isTagActive([{ Tag: 'vip', Cluster: 2, State: 'active' }], 'vip/1')).toBe(false);
    expect(isTagActive(null, 'vip/1')).toBe(false);
  });
});

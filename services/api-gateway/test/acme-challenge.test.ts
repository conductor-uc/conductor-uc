import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';

import { createServer, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  createChallengeLookup,
  registerAcmeChallengeRoute,
  type ChallengeLookup,
} from '../src/acme-challenge.js';
import { createHttpsRedirect } from '../src/http-redirect.js';

const TOKEN = 'internal-token';

describe('createChallengeLookup', () => {
  function lookupWith(
    handler: (url: string, init: RequestInit | undefined) => Response | Promise<Response>,
    token: string | null = TOKEN,
  ) {
    const calls: { url: string; headers: unknown }[] = [];
    const lookup = createChallengeLookup({
      orgServiceUrl: 'http://org-service:8080/',
      internalServiceToken: token ?? undefined,
      fetchImpl: (input, init) => {
        const url =
          typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        calls.push({ url, headers: init?.headers });
        return Promise.resolve(handler(url, init));
      },
    });
    return { lookup, calls };
  }

  it("asks org-service for the token's answer with the service token, and returns it", async () => {
    const { lookup, calls } = lookupWith(
      () => new Response(JSON.stringify({ keyAuthorization: 'abc.thumb' }), { status: 200 }),
    );
    expect(await lookup('abc')).toBe('abc.thumb');
    expect(calls).toEqual([
      {
        url: 'http://org-service:8080/internal/v1/acme/challenges/abc',
        headers: { authorization: `Bearer ${TOKEN}` },
      },
    ]);
  });

  it('has no answer for an unknown token, a failing org-service, or a reply that is not one', async () => {
    for (const handler of [
      () => new Response('nope', { status: 404 }),
      () => new Response('down', { status: 503 }),
      () => new Response(JSON.stringify({ other: 1 }), { status: 200 }),
      () => new Response('not json', { status: 200 }),
    ]) {
      expect(await lookupWith(handler).lookup('abc')).toBeUndefined();
    }
    const throwing = createChallengeLookup({
      orgServiceUrl: 'http://org-service:8080',
      internalServiceToken: TOKEN,
      fetchImpl: () => Promise.reject(new Error('unreachable')),
    });
    expect(await throwing('abc')).toBeUndefined();
  });

  it('never asks org-service about anything that is not a token, or without the service token', async () => {
    const { lookup, calls } = lookupWith(() => new Response('{}', { status: 200 }));
    for (const bad of ['', '../x', 'a/b', 'a b', 'a?b=1', 'x'.repeat(129), 'a%2fb']) {
      expect(await lookup(bad), bad).toBeUndefined();
    }
    expect(calls).toEqual([]);

    const none = lookupWith(() => new Response('{}', { status: 200 }), null);
    expect(await none.lookup('abc')).toBeUndefined();
    expect(none.calls).toEqual([]);
  });
});

describe('the challenge route on the gateway', () => {
  let app: Server;

  beforeAll(async () => {
    app = await createServer({
      serviceName: 'gateway-acme-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: false },
    });
    registerAcmeChallengeRoute(app, (token) =>
      Promise.resolve(token === 'good' ? 'good.thumb' : undefined),
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('serves the answer as plain text, uncached, with no sign-in', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/acme-challenge/good' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toBe('good.thumb');
    expect(response.headers['content-type']).toBe('text/plain; charset=utf-8');
    expect(response.headers['cache-control']).toBe('no-store');
  });

  it('answers a token it has nothing for with 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/.well-known/acme-challenge/other' });
    expect(response.statusCode).toBe(404);
  });
});

describe('the plain-HTTP listener', () => {
  const lookup: ChallengeLookup = (token) =>
    Promise.resolve(token === 'good' ? 'good.thumb' : undefined);
  const listener = createHttpsRedirect({ httpsPort: 8443, challenge: lookup });
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => listener.listen(0, '127.0.0.1', resolve));
    port = (listener.address() as AddressInfo).port;
  });

  afterAll(() => {
    listener.close();
  });

  function get(path: string, method = 'GET') {
    return new Promise<{ status: number; body: string; location: string | undefined }>(
      (resolve, reject) => {
        httpRequest(
          { host: '127.0.0.1', port, path, method, headers: { host: 'sip.reseller.test' } },
          (response) => {
            let body = '';
            response.setEncoding('utf8');
            response.on('data', (chunk: string) => (body += chunk));
            response.on('end', () =>
              resolve({
                status: response.statusCode ?? 0,
                body,
                location: response.headers.location,
              }),
            );
          },
        )
          .once('error', reject)
          .end();
      },
    );
  }

  it('answers a certificate authority instead of redirecting it, and sends everyone else to HTTPS', async () => {
    const challenge = await get('/.well-known/acme-challenge/good');
    expect(challenge).toMatchObject({ status: 200, body: 'good.thumb', location: undefined });

    const missing = await get('/.well-known/acme-challenge/nope');
    expect(missing.status).toBe(404);
    expect(missing.location).toBeUndefined();

    const page = await get('/anything?x=1');
    expect(page).toMatchObject({
      status: 308,
      location: 'https://sip.reseller.test:8443/anything?x=1',
    });
  });

  it('redirects a challenge path that is not a GET, like any other request', async () => {
    expect((await get('/.well-known/acme-challenge/good', 'POST')).status).toBe(308);
  });
});

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';

import { createServer, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createHttpsRedirect } from '../src/http-redirect.js';
import { registerProvisioningTransport } from '../src/provisioning-transport.js';
import { registerSecurityHeaders } from '../src/security-headers.js';
import { tlsServerOptions } from '../src/tls.js';

/** A short-lived self-signed certificate for [cn], written to [dir] as fullchain.pem and privkey.pem. */
function makeCert(dir: string, cn: string): void {
  mkdirSync(dir, { recursive: true });
  execFileSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'ec',
      '-pkeyopt',
      'ec_paramgen_curve:prime256v1',
      '-nodes',
      '-days',
      '2',
      '-subj',
      `/CN=${cn}`,
      '-addext',
      `subjectAltName=DNS:${cn}`,
      '-keyout',
      join(dir, 'privkey.pem'),
      '-out',
      join(dir, 'fullchain.pem'),
    ],
    { stdio: 'ignore' },
  );
}

/** Which certificate a client is given when it asks for [servername]. */
function commonNameFor(port: number, servername: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect(
      { host: '127.0.0.1', port, servername, rejectUnauthorized: false },
      () => {
        const cn = socket.getPeerCertificate().subject.CN;
        socket.end();
        resolve(String(Array.isArray(cn) ? cn[0] : cn));
      },
    );
    socket.once('error', reject);
  });
}

describe('tlsServerOptions', () => {
  let root: string;
  let certFile: string;
  let keyFile: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'gateway-tls-'));
    makeCert(join(root, 'default'), 'default.example.test');
    certFile = join(root, 'default', 'fullchain.pem');
    keyFile = join(root, 'default', 'privkey.pem');
    makeCert(join(root, 'hosts', 'acme.example.test'), 'acme.example.test');
    makeCert(join(root, 'hosts', '_.reseller.test'), '*.reseller.test');
    makeCert(join(root, 'decoy'), 'decoy.example.test');
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('is off without a certificate, and refuses half a pair', () => {
    expect(tlsServerOptions({})).toBeUndefined();
    expect(() => tlsServerOptions({ certFile })).toThrow(/together/);
    expect(() => tlsServerOptions({ keyFile })).toThrow(/together/);
  });

  it('fails at startup when the certificate cannot be read', () => {
    expect(() => tlsServerOptions({ certFile: join(root, 'nope.pem'), keyFile })).toThrow();
  });

  describe('served over a real connection', () => {
    let app: Server;
    let port: number;

    beforeAll(async () => {
      const https = tlsServerOptions({ certFile, keyFile, certDir: join(root, 'hosts') });
      app = await createServer({
        serviceName: 'gateway-https-test',
        logger: silentLogger(),
        context: { trustInternalHeaders: false },
        trustProxy: true,
        ...(https === undefined ? {} : { https }),
      });
      registerSecurityHeaders(app, { hstsMaxAgeSeconds: 31_536_000 });
      registerProvisioningTransport(app, { requireHttps: true });
      app.get('/v1/thing', { config: { public: true } }, () => ({ ok: true }));
      app.get('/v1/public/provision/yealink/a.cfg', { config: { public: true } }, () => 'config');
      await app.listen({ host: '127.0.0.1', port: 0 });
      port = (app.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await app?.close();
    });

    it('presents the certificate for the hostname the client asks for', async () => {
      expect(await commonNameFor(port, 'acme.example.test')).toBe('acme.example.test');
    });

    it('uses a wildcard directory for a subdomain, and the default for a name it has nothing for', async () => {
      expect(await commonNameFor(port, 'north.reseller.test')).toBe('*.reseller.test');
      expect(await commonNameFor(port, 'nobody.example.test')).toBe('default.example.test');
    });

    it('cannot be steered outside its certificate directory by the name a client sends', async () => {
      for (const name of ['../decoy', '..', 'a/b', 'acme.example.test/../../decoy']) {
        expect(await commonNameFor(port, name)).toBe('default.example.test');
      }
    });

    it('speaks TLS 1.2 or later and refuses TLS 1.1', async () => {
      const protocol = await new Promise<string | null>((resolve, reject) => {
        const socket = connect({ host: '127.0.0.1', port, rejectUnauthorized: false }, () => {
          const negotiated = socket.getProtocol();
          socket.end();
          resolve(negotiated);
        });
        socket.once('error', reject);
      });
      expect(['TLSv1.2', 'TLSv1.3']).toContain(protocol);

      await expect(
        new Promise((resolve, reject) => {
          const socket = connect(
            { host: '127.0.0.1', port, rejectUnauthorized: false, maxVersion: 'TLSv1.1' },
            () => resolve('connected'),
          );
          socket.once('error', reject);
        }),
      ).rejects.toThrow();
    });

    it('sends the security headers and HSTS over HTTPS, and never caches the API', async () => {
      const headers = await new Promise<Record<string, string | string[] | undefined>>(
        (resolve, reject) => {
          httpsRequest(
            { host: '127.0.0.1', port, path: '/v1/thing', rejectUnauthorized: false },
            (response) => {
              response.resume();
              resolve(response.headers);
            },
          )
            .once('error', reject)
            .end();
        },
      );
      expect(headers['strict-transport-security']).toBe('max-age=31536000; includeSubDomains');
      expect(headers['x-content-type-options']).toBe('nosniff');
      expect(headers['x-frame-options']).toBe('DENY');
      expect(headers['referrer-policy']).toBe('no-referrer');
      expect(headers['cache-control']).toBe('no-store');
      expect(headers['server']).toBeUndefined();
      expect(headers['x-powered-by']).toBeUndefined();
    });

    it('serves provisioning over HTTPS', async () => {
      const status = await new Promise<number>((resolve, reject) => {
        httpsRequest(
          {
            host: '127.0.0.1',
            port,
            path: '/v1/public/provision/yealink/a.cfg',
            rejectUnauthorized: false,
          },
          (response) => {
            response.resume();
            resolve(response.statusCode ?? 0);
          },
        )
          .once('error', reject)
          .end();
      });
      expect(status).toBe(200);
    });
  });

  it('picks up a renewed certificate without a restart, once its file has changed', async () => {
    const dir = join(root, 'renew');
    makeCert(join(dir, 'renew.example.test'), 'first.example.test');
    let clock = 1_000_000;
    const options = tlsServerOptions({ certFile, keyFile, certDir: dir }, () => clock);
    const pick = (name: string) =>
      new Promise<unknown>((resolve) => {
        options?.SNICallback?.(name, (_error, context) => {
          resolve(context);
        });
      });

    const first = await pick('renew.example.test');
    expect(await pick('renew.example.test')).toBe(first);

    makeCert(join(dir, 'renew.example.test'), 'second.example.test');
    const later = new Date(Date.now() + 60_000);
    utimesSync(join(dir, 'renew.example.test', 'fullchain.pem'), later, later);
    utimesSync(join(dir, 'renew.example.test', 'privkey.pem'), later, later);
    // Inside the recheck window the old certificate is still what is served.
    clock += 10_000;
    expect(await pick('renew.example.test')).toBe(first);
    clock += 120_000;
    expect(await pick('renew.example.test')).not.toBe(first);
  });
});

describe('security headers and provisioning over plain HTTP', () => {
  let app: Server;

  beforeAll(async () => {
    app = await createServer({
      serviceName: 'gateway-plain-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: false },
      trustProxy: true,
    });
    registerSecurityHeaders(app, { hstsMaxAgeSeconds: 600 });
    registerProvisioningTransport(app, { requireHttps: true });
    app.get('/v1/thing', { config: { public: true } }, () => ({ ok: true }));
    app.get('/v1/public/provision/yealink/a.cfg', { config: { public: true } }, () => 'config');
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
  });

  it('leaves HSTS off a plain connection and turns it on when a proxy says the browser used HTTPS', async () => {
    const plain = await app.inject({ method: 'GET', url: '/v1/thing' });
    expect(plain.headers['strict-transport-security']).toBeUndefined();
    expect(plain.headers['x-content-type-options']).toBe('nosniff');

    const proxied = await app.inject({
      method: 'GET',
      url: '/v1/thing',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(proxied.headers['strict-transport-security']).toBe('max-age=600; includeSubDomains');
  });

  it('refuses provisioning over plain HTTP, with a clear reason, and allows it behind an HTTPS proxy', async () => {
    const plain = await app.inject({ method: 'GET', url: '/v1/public/provision/yealink/a.cfg' });
    expect(plain.statusCode).toBe(403);
    expect(plain.json<{ code: string }>().code).toBe('https_required');
    expect(plain.body).not.toContain('config');

    const proxied = await app.inject({
      method: 'GET',
      url: '/v1/public/provision/yealink/a.cfg',
      headers: { 'x-forwarded-proto': 'https' },
    });
    expect(proxied.statusCode).toBe(200);

    // Nothing else is affected.
    expect((await app.inject({ method: 'GET', url: '/v1/thing' })).statusCode).toBe(200);
  });

  it('is left alone when the requirement is switched off, for development', async () => {
    const dev = await createServer({
      serviceName: 'gateway-dev-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: false },
    });
    registerProvisioningTransport(dev, { requireHttps: false });
    dev.get('/v1/public/provision/yealink/a.cfg', { config: { public: true } }, () => 'config');
    await dev.ready();
    try {
      const response = await dev.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/a.cfg',
      });
      expect(response.statusCode).toBe(200);
    } finally {
      await dev.close();
    }
  });
});

describe('the HTTP to HTTPS redirect', () => {
  const redirect = createHttpsRedirect({ httpsPort: 8443 });
  let port: number;

  beforeAll(async () => {
    await new Promise<void>((resolve) => redirect.listen(0, '127.0.0.1', resolve));
    port = (redirect.address() as AddressInfo).port;
  });

  afterAll(() => {
    redirect.close();
  });

  function get(path: string, host: string) {
    return new Promise<{ status: number; location: string | undefined }>((resolve, reject) => {
      httpRequest(
        { host: '127.0.0.1', port, path, headers: { host }, method: 'POST' },
        (response) => {
          response.resume();
          resolve({ status: response.statusCode ?? 0, location: response.headers.location });
        },
      )
        .once('error', reject)
        .end();
    });
  }

  it('sends the same page to HTTPS with a 308, which keeps the method', async () => {
    expect(await get('/a/b?c=1', 'console.example.test:8080')).toEqual({
      status: 308,
      location: 'https://console.example.test:8443/a/b?c=1',
    });
  });

  it('will not redirect to, or echo, anything but a plausible hostname', async () => {
    for (const host of ['evil.test/@x', 'a b', 'x.test\r\nSet-Cookie: a=b']) {
      const result = await get('/', host).catch(() => ({ status: 0, location: undefined }));
      expect(
        result.status === 400 || result.status === 0,
        `${host} -> ${String(result.status)}`,
      ).toBe(true);
      expect(result.location).toBeUndefined();
    }
  });
});

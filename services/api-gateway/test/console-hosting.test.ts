import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createServer, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { consoleContentSecurityPolicy, registerConsoleHosting } from '../src/console-hosting.js';
import { registerSecurityHeaders } from '../src/security-headers.js';

describe('console hosting', () => {
  let root: string;
  let app: Server;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), 'console-host-'));
    const site = join(root, 'site');
    mkdirSync(join(site, 'assets'), { recursive: true });
    writeFileSync(join(site, 'index.html'), '<!DOCTYPE html><title>Loading…</title>');
    writeFileSync(join(site, 'main.dart.js'), 'console.log(1);');
    writeFileSync(join(site, 'canvaskit.wasm'), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(site, 'assets', 'FontManifest.json'), '[]');
    // Outside the directory, and a link inside it that points there.
    writeFileSync(join(root, 'secret.txt'), 'do not serve');
    symlinkSync(join(root, 'secret.txt'), join(site, 'link.txt'));

    app = await createServer({
      serviceName: 'console-hosting-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: false },
    });
    registerSecurityHeaders(app, { hstsMaxAgeSeconds: 0 });
    app.get('/v1/thing', { config: { public: true } }, () => ({ from: 'the api' }));
    registerConsoleHosting(app, {
      dir: site,
      extraConnectSources: ['https://storage.example.test'],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    rmSync(root, { recursive: true, force: true });
  });

  it('serves the app at the root, under a strict policy that lets nothing frame it', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });
    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toBe('text/html; charset=utf-8');
    expect(response.body).toContain('<title>Loading…</title>');
    const policy = String(response.headers['content-security-policy']);
    expect(policy).toContain("default-src 'self'");
    expect(policy).toContain("script-src 'self' 'wasm-unsafe-eval'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("object-src 'none'");
    expect(policy).toContain("connect-src 'self' https://storage.example.test");
    expect(policy).not.toContain("'unsafe-eval'");
    expect(response.headers['cache-control']).toBe('no-cache');
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['server']).toBeUndefined();
  });

  it("gives the app's own routes the app, and a missing file a 404", async () => {
    const route = await app.inject({ method: 'GET', url: '/users/42' });
    expect(route.statusCode).toBe(200);
    expect(route.body).toContain('Loading');

    const missing = await app.inject({ method: 'GET', url: '/nothing.js' });
    expect(missing.statusCode).toBe(404);
    expect(missing.body).not.toContain('Loading');
  });

  it('serves each file with its own type', async () => {
    const js = await app.inject({ method: 'GET', url: '/main.dart.js' });
    expect(js.headers['content-type']).toBe('text/javascript; charset=utf-8');
    const wasm = await app.inject({ method: 'GET', url: '/canvaskit.wasm' });
    expect(wasm.headers['content-type']).toBe('application/wasm');
    const manifest = await app.inject({ method: 'GET', url: '/assets/FontManifest.json' });
    expect(manifest.statusCode).toBe(200);
    expect(manifest.headers['content-type']).toContain('application/json');
  });

  it('answers a repeat request with 304 when nothing has changed', async () => {
    const first = await app.inject({ method: 'GET', url: '/main.dart.js' });
    const etag = String(first.headers['etag']);
    expect(etag).toMatch(/^W\//);
    const again = await app.inject({
      method: 'GET',
      url: '/main.dart.js',
      headers: { 'if-none-match': etag },
    });
    expect(again.statusCode).toBe(304);
    expect(again.body).toBe('');
  });

  it('cannot be led outside the directory by the path, an encoded path, or a link', async () => {
    for (const url of [
      '/../secret.txt',
      '/%2e%2e/secret.txt',
      '/..%2fsecret.txt',
      '/assets/../../secret.txt',
      '/link.txt',
      '/%00',
    ]) {
      const response = await app.inject({ method: 'GET', url });
      expect(response.body, url).not.toContain('do not serve');
      expect([200, 400, 404], url).toContain(response.statusCode);
    }
  });

  it('never shadows the API', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/thing' });
    expect(response.json()).toEqual({ from: 'the api' });
  });
});

describe('consoleContentSecurityPolicy', () => {
  it('allows only its own origin unless told otherwise', () => {
    expect(consoleContentSecurityPolicy()).toContain("connect-src 'self';");
  });

  it('names the live connection origin (the page host, ws/wss) when the realtime hub is on', async () => {
    const withRealtime = await createServer({
      serviceName: 'console-hosting-realtime-test',
      logger: silentLogger(),
      context: { trustInternalHeaders: false },
    });
    const site = mkdtempSync(join(tmpdir(), 'console-host-rt-'));
    writeFileSync(join(site, 'index.html'), '<!DOCTYPE html>');
    registerConsoleHosting(withRealtime, { dir: site, realtime: true });
    await withRealtime.ready();
    try {
      const response = await withRealtime.inject({
        method: 'GET',
        url: '/',
        headers: { host: 'console.brand.test' },
      });
      expect(String(response.headers['content-security-policy'])).toContain(
        "connect-src 'self' ws://console.brand.test;",
      );
      const odd = await withRealtime.inject({
        method: 'GET',
        url: '/',
        headers: { host: 'bad host;script-src *' },
      });
      expect(String(odd.headers['content-security-policy'])).toContain("connect-src 'self';");
    } finally {
      await withRealtime.close();
      rmSync(site, { recursive: true, force: true });
    }
  });
});

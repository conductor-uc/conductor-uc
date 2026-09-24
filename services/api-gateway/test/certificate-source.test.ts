import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { connect } from 'node:tls';
import type { AddressInfo } from 'node:net';

import { createServer, type Server } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOrgCertificateSource } from '../src/certificate-source.js';
import { tlsServerOptions } from '../src/tls.js';

let root: string;
const material: Record<string, { certificate: string; privateKey: string }> = {};

function issue(cn: string): { certificate: string; privateKey: string } {
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
      join(root, `${cn}.key`),
      '-out',
      join(root, `${cn}.crt`),
    ],
    { stdio: 'ignore' },
  );
  return {
    certificate: readFileSync(join(root, `${cn}.crt`), 'utf8'),
    privateKey: readFileSync(join(root, `${cn}.key`), 'utf8'),
  };
}

function commonName(port: number, servername: string): Promise<string> {
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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'gateway-orgcert-'));
  material['portal.reseller.test'] = issue('portal.reseller.test');
  material['sip.reseller.test'] = issue('sip.reseller.test');
  material['fallback.example.test'] = issue('fallback.example.test');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

function fakeOrg(state: {
  calls: string[];
  down?: boolean;
  purposes?: Record<string, string>;
}): typeof fetch {
  return (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const fqdn = decodeURIComponent(url.split('/').pop() ?? '');
    state.calls.push(fqdn);
    expect((init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
    if (state.down === true) return Promise.reject(new Error('connection refused'));
    const held = material[fqdn];
    if (held === undefined) return Promise.resolve(new Response('{}', { status: 404 }));
    const purpose = state.purposes?.[fqdn] ?? (fqdn.startsWith('sip.') ? 'sip' : 'console');
    return Promise.resolve(Response.json({ fqdn, purpose, ...held }));
  };
}

describe('createOrgCertificateSource', () => {
  it('fetches a console certificate once a minute at most, and refetches after', async () => {
    const state = { calls: [] as string[] };
    let at = 0;
    const source = createOrgCertificateSource({
      orgServiceUrl: 'http://org',
      internalServiceToken: 'tok',
      fetchImpl: fakeOrg(state),
      now: () => at,
    });
    expect(await source('Portal.Reseller.Test')).toBeDefined();
    expect(await source('portal.reseller.test')).toBeDefined();
    expect(state.calls).toEqual(['portal.reseller.test']);
    at = 61_000;
    await source('portal.reseller.test');
    expect(state.calls).toHaveLength(2);
  });

  it('never presents a SIP certificate, and remembers a name with nothing for it', async () => {
    const state = { calls: [] as string[] };
    const source = createOrgCertificateSource({
      orgServiceUrl: 'http://org',
      internalServiceToken: 'tok',
      fetchImpl: fakeOrg(state),
      now: () => 0,
    });
    expect(await source('sip.reseller.test')).toBeUndefined();
    expect(await source('nobody.test')).toBeUndefined();
    expect(await source('nobody.test')).toBeUndefined();
    expect(state.calls).toEqual(['sip.reseller.test', 'nobody.test']);
  });

  it('keeps using the certificate it holds while org-service is down', async () => {
    const state = { calls: [] as string[], down: false };
    let at = 0;
    const source = createOrgCertificateSource({
      orgServiceUrl: 'http://org',
      internalServiceToken: 'tok',
      fetchImpl: fakeOrg(state),
      now: () => at,
    });
    const held = await source('portal.reseller.test');
    state.down = true;
    at = 120_000;
    expect(await source('portal.reseller.test')).toBe(held);
  });

  it('asks nothing without a token, or for a name that is not a hostname', async () => {
    const state = { calls: [] as string[] };
    const withoutToken = createOrgCertificateSource({
      orgServiceUrl: 'http://org',
      internalServiceToken: undefined,
      fetchImpl: fakeOrg(state),
    });
    const source = createOrgCertificateSource({
      orgServiceUrl: 'http://org',
      internalServiceToken: 'tok',
      fetchImpl: fakeOrg(state),
    });
    expect(await withoutToken('portal.reseller.test')).toBeUndefined();
    for (const name of ['../x', 'a/b', '', 'a..b']) expect(await source(name)).toBeUndefined();
    expect(state.calls).toEqual([]);
  });

  describe('on a real TLS server', () => {
    let app: Server;
    let port: number;

    beforeAll(async () => {
      const source = createOrgCertificateSource({
        orgServiceUrl: 'http://org',
        internalServiceToken: 'tok',
        fetchImpl: fakeOrg({ calls: [] }),
      });
      const https = tlsServerOptions({
        certFile: join(root, 'fallback.example.test.crt'),
        keyFile: join(root, 'fallback.example.test.key'),
        source,
      });
      app = await createServer({
        serviceName: 'gateway-orgcert-test',
        logger: silentLogger(),
        context: { trustInternalHeaders: false },
        ...(https === undefined ? {} : { https }),
      });
      await app.listen({ host: '127.0.0.1', port: 0 });
      port = (app.server.address() as AddressInfo).port;
    });

    afterAll(async () => {
      await app?.close();
    });

    it("presents org-service's certificate for a console name and the default otherwise", async () => {
      expect(await commonName(port, 'portal.reseller.test')).toBe('portal.reseller.test');
      expect(await commonName(port, 'sip.reseller.test')).toBe('fallback.example.test');
      expect(await commonName(port, 'unknown.test')).toBe('fallback.example.test');
    });

    it('turns HTTPS on from the source alone', () => {
      const source = createOrgCertificateSource({
        orgServiceUrl: 'http://org',
        internalServiceToken: 'tok',
      });
      expect(tlsServerOptions({ source })).toBeDefined();
    });
  });
});

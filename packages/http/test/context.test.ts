import { describe, expect, it } from 'vitest';

import {
  INTERNAL_CONTEXT_HEADERS,
  INTERNAL_SIGNATURE_HEADER,
  parseTraceparent,
  signInternalHeaders,
} from '../src/context.js';
import type { RequestContext } from '../src/context.js';
import { signedHeaders, testServer, TEST_INTERNAL_SECRET } from './helpers.js';

const contract = { permission: 'p', dataClass: 'config' } as const;

/** Runs one request and returns the raw response — some tests need the status, not just a parsed context. */
async function requestWith(headers: Record<string, string>, trustInternalHeaders?: boolean) {
  const app = await testServer(
    trustInternalHeaders === undefined ? {} : { context: { trustInternalHeaders } },
  );
  app.get('/v1/x', { config: contract }, (request) => request.context);
  await app.ready();

  return app.inject({ method: 'GET', url: '/v1/x', headers });
}

/** Runs one request and returns the context the handler saw. Only for requests expected to succeed. */
async function contextFor(
  headers: Record<string, string>,
  trustInternalHeaders?: boolean,
): Promise<RequestContext> {
  const response = await requestWith(headers, trustInternalHeaders);
  return response.json<RequestContext>();
}

describe('parseTraceparent', () => {
  it('extracts the trace and span ids from a W3C header', () => {
    const result = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');

    expect(result).toEqual({
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
      spanId: '00f067aa0ba902b7',
    });
  });

  it('generates a trace id when the header is absent', () => {
    expect(parseTraceparent(undefined).traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('generates a trace id rather than failing on a malformed header', () => {
    for (const malformed of ['garbage', '00-short-00f067aa0ba902b7-01', '']) {
      const result = parseTraceparent(malformed);
      expect(result.traceId).toMatch(/^[0-9a-f]{32}$/);
      expect(result.spanId).toBeUndefined();
    }
  });
});

describe('request context', () => {
  it('always carries a request id and a trace id', async () => {
    const context = await contextFor({});

    expect(context.requestId).toBeTruthy();
    expect(context.traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('continues an inbound trace', async () => {
    const context = await contextFor({
      traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
    });

    expect(context.traceId).toBe('4bf92f3577b34da6a3ce929d0e0e4736');
    expect(context.spanId).toBe('00f067aa0ba902b7');
  });

  it('ignores internal identity headers by default — trustInternalHeaders is off', async () => {
    // Deliberately raw, unsigned headers: with trust off, no verification is
    // attempted at all, and the request succeeds with an anonymous context.
    const context = await contextFor({
      'x-internal-tenant-id': 'tenant-a',
      'x-internal-org-type': 'tenant',
      'x-internal-actor-id': 'user-1',
    });

    expect(context.tenantId).toBeUndefined();
    expect(context.orgType).toBeUndefined();
    expect(context.actorId).toBeUndefined();
  });

  it('reads internal identity headers when the service opts in and the signature is valid', async () => {
    const context = await contextFor(
      signedHeaders({
        actorId: 'user-1',
        actorType: 'user',
        orgId: 'org-1',
        orgType: 'tenant',
        resellerId: 'res-1',
        tenantId: 'tenant-a',
      }),
      true,
    );

    expect(context).toMatchObject({
      actorId: 'user-1',
      actorType: 'user',
      orgId: 'org-1',
      orgType: 'tenant',
      resellerId: 'res-1',
      tenantId: 'tenant-a',
    });
  });

  it('drops an actor or org type it does not recognise, but still trusts a validly signed request', async () => {
    const context = await contextFor(
      signedHeaders({ actorType: 'robot' as never, orgType: 'partner' as never }),
      true,
    );

    expect(context.actorType).toBeUndefined();
    expect(context.orgType).toBeUndefined();
  });

  it('uses header names that name no product, operator, or codebase', () => {
    // Header names are network-visible, so they are a brand-leak surface (02 §5.5).
    for (const header of [...Object.values(INTERNAL_CONTEXT_HEADERS), INTERNAL_SIGNATURE_HEADER]) {
      expect(header).toMatch(/^x-internal-[a-z-]+$/);
      for (const forbidden of ['cuc', 'conductor']) {
        expect(header).not.toContain(forbidden);
      }
    }
  });

  describe('signature verification (S1-08)', () => {
    it('rejects an internal header with no signature at all', async () => {
      const response = await requestWith({ 'x-internal-org-type': 'master' }, true);

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ code: 'internal_headers_forged' });
    });

    it('rejects an internal header signed with the wrong secret', async () => {
      // Deliberately not `signedHeaders` — signed with a secret no server in
      // this file was configured with, the same shape a compromised or
      // misconfigured caller's signature would take.
      const forged = signInternalHeaders('a-completely-different-secret', { orgType: 'master' });

      const response = await requestWith(forged, true);

      expect(response.statusCode).toBe(401);
    });

    it('rejects a signature whose payload was tampered with after signing', async () => {
      const headers = signedHeaders({ orgType: 'tenant' });
      // The signature was computed over 'tenant' — swapping the value without
      // re-signing is exactly what a forged header looks like.
      headers['x-internal-org-type'] = 'master';

      const response = await requestWith(headers, true);

      expect(response.statusCode).toBe(401);
    });

    it('rejects a stale signature past the max age', async () => {
      const stale = signedHeaders({ orgType: 'master' });
      const [, signature] = stale[INTERNAL_SIGNATURE_HEADER]!.split('.');
      const oldTimestamp = String(Date.now() - 5 * 60 * 1000);
      stale[INTERNAL_SIGNATURE_HEADER] = `${oldTimestamp}.${signature}`;

      const response = await requestWith(stale, true);

      expect(response.statusCode).toBe(401);
    });

    it('does not reject a request with no internal headers at all — that is not a forgery attempt', async () => {
      const response = await requestWith({}, true);

      expect(response.statusCode).toBe(200);
    });

    it('createServer refuses to start with trustInternalHeaders on and no signing secret configured', async () => {
      const { createServer } = await import('../src/server.js');
      const { captureLogger } = await import('./helpers.js');

      await expect(
        createServer({
          serviceName: 'x',
          logger: captureLogger().logger,
          context: { trustInternalHeaders: true },
        }),
      ).rejects.toThrow(/internalHeaderSigningSecret/);
    });
  });
});

describe('log correlation', () => {
  it('binds the request id and trace id onto request logs', async () => {
    const { captureLogger } = await import('./helpers.js');
    const { lines, logger } = captureLogger();
    const app = await testServer({ logger });
    app.get('/v1/x', { config: contract }, (request) => {
      request.log.info('handling');
      return {};
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: {
        'x-request-id': 'r-9',
        traceparent: '00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01',
      },
    });

    const line = lines.find((entry) => entry['msg'] === 'handling');
    expect(line).toMatchObject({
      requestId: 'r-9',
      traceId: '4bf92f3577b34da6a3ce929d0e0e4736',
    });
  });

  it('binds the tenant id when identity headers are trusted', async () => {
    const { captureLogger } = await import('./helpers.js');
    const { lines, logger } = captureLogger();
    const app = await testServer({
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    app.get('/v1/x', { config: contract }, (request) => {
      request.log.info('handling');
      return {};
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: signedHeaders({ tenantId: 'tenant-a', actorId: 'user-1' }),
    });

    expect(lines.find((entry) => entry['msg'] === 'handling')).toMatchObject({
      tenantId: 'tenant-a',
      actorId: 'user-1',
    });
  });
});

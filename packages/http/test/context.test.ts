import { describe, expect, it } from 'vitest';

import { INTERNAL_CONTEXT_HEADERS, parseTraceparent } from '../src/context.js';
import type { RequestContext } from '../src/context.js';
import { testServer } from './helpers.js';

const contract = { permission: 'p', dataClass: 'config' } as const;

/** Runs one request and returns the context the handler saw. */
async function contextFor(
  headers: Record<string, string>,
  trustInternalHeaders?: boolean,
): Promise<RequestContext> {
  const app = await testServer(
    trustInternalHeaders === undefined ? {} : { context: { trustInternalHeaders } },
  );
  app.get('/v1/x', { config: contract }, (request) => request.context);
  await app.ready();

  const response = await app.inject({ method: 'GET', url: '/v1/x', headers });
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

  it('ignores internal identity headers by default', async () => {
    const context = await contextFor({
      'x-internal-tenant-id': 'tenant-a',
      'x-internal-org-type': 'tenant',
      'x-internal-actor-id': 'user-1',
    });

    expect(context.tenantId).toBeUndefined();
    expect(context.orgType).toBeUndefined();
    expect(context.actorId).toBeUndefined();
  });

  it('reads internal identity headers when the service opts in', async () => {
    const context = await contextFor(
      {
        'x-internal-actor-id': 'user-1',
        'x-internal-actor-type': 'user',
        'x-internal-org-id': 'org-1',
        'x-internal-org-type': 'tenant',
        'x-internal-reseller-id': 'res-1',
        'x-internal-tenant-id': 'tenant-a',
      },
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

  it('drops an actor or org type it does not recognise', async () => {
    const context = await contextFor(
      { 'x-internal-actor-type': 'robot', 'x-internal-org-type': 'partner' },
      true,
    );

    expect(context.actorType).toBeUndefined();
    expect(context.orgType).toBeUndefined();
  });

  it('uses header names that name no product, operator, or codebase', () => {
    // Header names are network-visible, so they are a brand-leak surface (02 §5.5).
    for (const header of Object.values(INTERNAL_CONTEXT_HEADERS)) {
      expect(header).toMatch(/^x-internal-[a-z-]+$/);
      for (const forbidden of ['cuc', 'conductor']) {
        expect(header).not.toContain(forbidden);
      }
    }
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
    const app = await testServer({ logger, context: { trustInternalHeaders: true } });
    app.get('/v1/x', { config: contract }, (request) => {
      request.log.info('handling');
      return {};
    });
    await app.ready();

    await app.inject({
      method: 'GET',
      url: '/v1/x',
      headers: { 'x-internal-tenant-id': 'tenant-a', 'x-internal-actor-id': 'user-1' },
    });

    expect(lines.find((entry) => entry['msg'] === 'handling')).toMatchObject({
      tenantId: 'tenant-a',
      actorId: 'user-1',
    });
  });
});

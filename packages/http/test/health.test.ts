import { describe, expect, it } from 'vitest';

import { testServer } from './helpers.js';

interface ReadyzBody {
  status: string;
  checks: Record<string, { status: string; detail?: string }>;
}

describe('GET /healthz', () => {
  it('reports liveness without touching a dependency', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => {
      throw new Error('database is down');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/healthz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ok',
      service: 'test-service',
      version: '1.2.3',
    });
  });
});

describe('GET /readyz', () => {
  it('is ready when a service registers no checks', async () => {
    const app = await testServer();
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'ok', checks: {} });
  });

  it('is ready when every check passes', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => ({ status: 'pass' }));
    app.addReadinessCheck('bus', () => Promise.resolve({ status: 'pass', detail: 'lag 0s' }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(200);
    expect(response.json<ReadyzBody>().checks).toEqual({
      db: { status: 'pass' },
      bus: { status: 'pass', detail: 'lag 0s' },
    });
  });

  it('returns 503 when any check fails, so the instance leaves the pool', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => ({ status: 'pass' }));
    app.addReadinessCheck('bus', () => ({ status: 'fail', detail: 'no connection' }));
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { db: { status: 'pass' }, bus: { status: 'fail', detail: 'no connection' } },
    });
  });

  it('S4-11: fails a check that never settles, instead of hanging, and still reports the rest', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => ({ status: 'pass' }));
    // A dependency whose connection hangs: the promise never settles.
    app.addReadinessCheck('redis', () => new Promise(() => undefined));
    await app.ready();

    const started = Date.now();
    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(Date.now() - started).toBeLessThan(5_000);
    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'unavailable',
      checks: { db: { status: 'pass' }, redis: { status: 'fail', detail: 'timed out' } },
    });
  });

  it('treats a thrown check as a failure without echoing the message', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => {
      throw new Error('connect ECONNREFUSED user=root password=hunter2');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/readyz' });

    expect(response.statusCode).toBe(503);
    expect(response.json<ReadyzBody>().checks).toEqual({ db: { status: 'fail' } });
    expect(response.body).not.toContain('hunter2');
  });

  it('logs the thrown check so an operator can still diagnose it', async () => {
    const { captureLogger } = await import('./helpers.js');
    const { lines, logger } = captureLogger();
    const app = await testServer({ logger });
    app.addReadinessCheck('db', () => {
      throw new Error('the real cause');
    });
    await app.ready();

    await app.inject({ method: 'GET', url: '/readyz' });

    const line = lines.find((entry) => entry['msg'] === 'readiness check threw');
    expect(line).toBeDefined();
    expect(JSON.stringify(line)).toContain('the real cause');
  });
});

describe('GET /statusz (S4-12)', () => {
  it('reports checks by name, uptime, memory and every section, without failing on one', async () => {
    const app = await testServer();
    app.addReadinessCheck('db', () => ({ status: 'pass', detail: 'not shown here' }));
    app.addReadinessCheck('bus', () => ({ status: 'fail' }));
    app.addStatusSection('outbox', () => Promise.resolve({ pending: 2 }));
    app.addStatusSection('broken', () => {
      throw new Error('mysql://user:secret@db');
    });
    await app.ready();

    const response = await app.inject({ method: 'GET', url: '/statusz' });

    expect(response.statusCode).toBe(200);
    const body = response.json<Record<string, unknown>>();
    expect(body).toMatchObject({
      service: 'test-service',
      version: '1.2.3',
      ready: false,
      checks: [
        { name: 'db', status: 'pass' },
        { name: 'bus', status: 'fail' },
      ],
      sections: { outbox: { pending: 2 }, broken: null },
    });
    expect(typeof body['uptimeSeconds']).toBe('number');
    expect((body['memory'] as { rssBytes: number }).rssBytes).toBeGreaterThan(0);
    expect(response.body).not.toContain('secret');
    expect(response.body).not.toContain('not shown here');
  });
});

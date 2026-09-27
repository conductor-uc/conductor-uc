import { describe, expect, it } from 'vitest';

import { observeOutbox } from '../src/index.js';
import { testServer } from './helpers.js';

describe('GET /metrics (S4-13)', () => {
  it('reports request timings by route pattern, never the concrete path, and skips the probes', async () => {
    const app = await testServer();
    app.get('/v1/tenants/:tenantId/things', { config: { public: true } }, () => ({ ok: true }));
    await app.ready();

    await app.inject({ method: 'GET', url: '/v1/tenants/acme-tenant-id/things' });
    await app.inject({ method: 'GET', url: '/readyz' });
    const response = await app.inject({ method: 'GET', url: '/metrics' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.body).toMatch(
      /http_server_request_duration_seconds_count\{[^}]*http_route="\/v1\/tenants\/:tenantId\/things"[^}]*\} 1/,
    );
    expect(response.body).not.toContain('acme-tenant-id');
    expect(response.body).not.toContain('http_route="/readyz"');
  });

  it('reads gauges at each scrape, with labels, and survives one that throws', async () => {
    const app = await testServer();
    let calls = 3;
    app.addGauge('fs_node_calls', { description: 'Calls on a node.' }, () => [
      { value: calls, attributes: { node: 'fs1' } },
      { value: 0, attributes: { node: 'fs2' } },
    ]);
    app.addGauge('broken_gauge', { description: 'Always fails.' }, () => {
      throw new Error('no');
    });
    await app.ready();

    expect((await app.inject({ method: 'GET', url: '/metrics' })).body).toContain(
      'fs_node_calls{node="fs1"} 3',
    );
    calls = 5;
    const second = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(second).toContain('fs_node_calls{node="fs1"} 5');
    expect(second).toContain('fs_node_calls{node="fs2"} 0');
  });

  it('publishes an outbox as gauges and as its /statusz section', async () => {
    const app = await testServer();
    observeOutbox(app, {
      status: () => Promise.resolve({ pending: 4, oldestPendingSeconds: 30, failed: 1 }),
    });
    await app.ready();

    const metrics = (await app.inject({ method: 'GET', url: '/metrics' })).body;
    expect(metrics).toContain('outbox_pending 4');
    expect(metrics).toContain('outbox_oldest_pending_seconds 30');
    expect(metrics).toContain('outbox_failed 1');
    const status = (await app.inject({ method: 'GET', url: '/statusz' })).json<{
      sections: Record<string, unknown>;
    }>();
    expect(status.sections['outbox']).toEqual({ pending: 4, oldestPendingSeconds: 30, failed: 1 });
  });
});

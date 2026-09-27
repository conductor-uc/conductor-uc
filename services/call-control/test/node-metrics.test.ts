import { createServer } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { describe, expect, it } from 'vitest';

import { registerNodeMetrics } from '../src/node-metrics.js';
import type { NodeState } from '../src/redis/registry.js';

const node = (overrides: Partial<NodeState>): NodeState => ({
  nodeId: 'fs1',
  status: 'up',
  draining: false,
  calls: 0,
  sessions: null,
  maxSessions: null,
  cpuIdlePercent: null,
  sessionsPerSecond: null,
  uptimeSeconds: null,
  heartbeatAt: null,
  ...overrides,
});

describe('media node gauges (S4-13)', () => {
  it("exports each node's state and load, leaving out figures not reported yet", async () => {
    const app = await createServer({ serviceName: 'call-control-test', logger: silentLogger() });
    let reads = 0;
    registerNodeMetrics(app, () => {
      reads += 1;
      return Promise.resolve([
        node({ nodeId: 'fs1', calls: 3, sessions: 6, maxSessions: 1000, cpuIdlePercent: 92.5 }),
        node({ nodeId: 'fs2', status: 'draining', draining: true, calls: 1 }),
        node({ nodeId: 'fs3', status: 'down' }),
      ]);
    });
    await app.ready();

    const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;

    expect(body).toContain('fs_node_calls{node="fs1"} 3');
    expect(body).toContain('fs_node_calls{node="fs2"} 1');
    expect(body).toContain('fs_node_draining{node="fs2"} 1');
    expect(body).toContain('fs_node_up{node="fs3"} 0');
    expect(body).toContain('fs_node_cpu_idle_percent{node="fs1"} 92.5');
    expect(body).not.toContain('fs_node_sessions{node="fs2"}');
    // One registry read per scrape, whatever the number of gauges.
    expect(reads).toBe(1);
    await app.close();
  });
});

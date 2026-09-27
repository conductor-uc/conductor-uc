import { sharedReading, type Server } from '@cuc/http';

import type { NodeState } from './redis/registry.js';

/**
 * S4-13 (G-124): each FS node's state and load as Prometheus gauges, labelled `node`, for the
 * operations console's history (`GET /v1/platform/metrics/...` on the gateway). Read from the
 * registry once per scrape. A figure a node has not reported yet (no HEARTBEAT since it came up)
 * is left out rather than shown as 0.
 */
export function registerNodeMetrics(
  app: Server,
  states: () => Promise<readonly NodeState[]>,
): void {
  const read = sharedReading(states);
  const gauge = (
    name: string,
    description: string,
    value: (node: NodeState) => number | null,
    unit?: string,
  ): void => {
    app.addGauge(name, { description, ...(unit === undefined ? {} : { unit }) }, async () =>
      (await read()).flatMap((node) => {
        const reading = value(node);
        return reading === null ? [] : [{ value: reading, attributes: { node: node.nodeId } }];
      }),
    );
  };

  gauge('fs_node_up', 'Whether the node is heartbeating (1) or not (0).', (n) =>
    n.status === 'down' ? 0 : 1,
  );
  gauge('fs_node_draining', 'Whether the node is drained (1) or in service (0).', (n) =>
    n.draining ? 1 : 0,
  );
  gauge('fs_node_calls', 'Calls the registry has on the node.', (n) => n.calls);
  gauge('fs_node_sessions', 'Sessions the node reported in its last heartbeat.', (n) => n.sessions);
  gauge('fs_node_max_sessions', 'The most sessions the node allows.', (n) => n.maxSessions);
  gauge(
    'fs_node_cpu_idle_percent',
    'Idle CPU the node reported in its last heartbeat.',
    (n) => n.cpuIdlePercent,
    '%',
  );
}

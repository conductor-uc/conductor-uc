import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';

import { telephonyEvents } from '../events.js';
import type { OpenSipsMiClient } from '../opensips-mi-client.js';
import {
  FS_DISPATCHER_SET,
  type OpenSipsProjectionRepo,
} from '../repo/opensips-projection.repo.js';
import type { TelephonyConfigDb } from '../schema.js';

interface DrainChangedData {
  readonly nodeId: string;
  readonly draining: boolean;
}

export interface NodeConsumerOptions {
  readonly pullTimeoutMs?: number;
}

/**
 * The `CALL` stream's `call.node.drain_changed` (S4-02, G-123): an operator drained an FS node in
 * call-control, or returned it to service. The node's dispatcher rows are set inactive (or
 * active), and OpenSIPs is told at once with MI `ds_set_state`: `i` keeps the destination out of
 * `ds_select_dst` even while its probes are answered, where `p` (probing) would bring it back by
 * itself. `ds_is_in_list` still matches it, so the calls already on the node keep working.
 *
 * The table is written first, so an OpenSIPs that restarts before the MI call still loads the
 * node inactive (`seed-dispatcher.py` keeps `state`). An MI failure throws, and the event is
 * redelivered; both steps are idempotent.
 */
export function createNodeConsumer(
  db: Database<TelephonyConfigDb>,
  bus: Bus,
  logger: Logger,
  opensips: OpenSipsProjectionRepo,
  mi: OpenSipsMiClient,
  options: NodeConsumerOptions = {},
): EventConsumer {
  return createConsumer<TelephonyConfigDb>({
    db: db.kysely,
    bus,
    logger,
    registry: telephonyEvents,
    durable: 'telephony-config-nodes',
    subjects: ['call.node.drain_changed'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const { nodeId, draining } = envelope.data as DrainChangedData;
      const destinations = await opensips.setDispatcherNodeState(nodeId, !draining);
      if (destinations.length === 0) {
        logger.warn(
          { nodeId, draining },
          'no dispatcher destination carries this node id; OpenSIPs keeps routing to it as before',
        );
        return;
      }
      for (const address of destinations) {
        await mi.query('ds_set_state', [draining ? 'i' : 'a', FS_DISPATCHER_SET, address]);
      }
      logger.info({ nodeId, draining, destinations }, 'fs node dispatcher state changed');
    },
  });
}

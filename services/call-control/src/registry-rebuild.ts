import { randomUUID } from 'node:crypto';

import type { Logger } from '@cuc/logger';

import type { AffinityManager } from './affinity/manager.js';
import type { EslApiResult } from './esl/client.js';
import { normalizeEslEvent } from './normalize.js';
import type { CallRegistry } from './redis/registry.js';

/** The event socket calls the rebuild makes of a node. */
export interface RebuildEsl {
  sendApi(command: string): Promise<EslApiResult>;
}

export interface RegistryRebuildOptions {
  readonly registry: CallRegistry;
  readonly affinity: Pick<AffinityManager, 'restore'>;
  /** The nodes this replica is connected to now, by id. */
  readonly nodes: () => ReadonlyMap<string, RebuildEsl>;
  readonly callSafetyTtlMs: number;
  readonly logger: Logger;
}

/** How often each replica checks whether Redis lost the registry. */
export const REBUILD_CHECK_INTERVAL_MS = 2_000;

/** Microseconds (FreeSWITCH's `*-Time` fields) to the registry's milliseconds; undefined for 0 or none. */
function microsToMs(value: string | undefined): string | undefined {
  if (value === undefined || value === '' || value === '0') return undefined;
  const micros = Number(value);
  return Number.isFinite(micros) && micros > 0 ? String(Math.floor(micros / 1000)) : undefined;
}

function parseJson<T>(body: string): T | undefined {
  try {
    return JSON.parse(body) as T;
  } catch {
    return undefined;
  }
}

/**
 * S4-04 (04 §5): Redis is not the system of record, so losing its data must
 * not lose the live view of the platform. The registry carries an epoch, a
 * marker with no TTL that only goes missing with the data. Every
 * `REBUILD_CHECK_INTERVAL_MS` each replica looks:
 *
 * - **Missing:** one replica claims a new epoch and rebuilds every live call
 *   from the nodes it is connected to: `show channels as json` lists them,
 *   and `uuid_dump <uuid> json` gives each channel's fields, the same ones a
 *   channel event carries, so the event normalizer makes the record; then
 *   its answer, hold and bridge. A call live events have already recreated
 *   meanwhile is left as it is, so the rebuild is idempotent.
 * - **Changed since last seen:** every replica sets again the leases it was
 *   renewing (`restore`). A lease whose replica also restarted is not
 *   restored; the next call to that queue, parking lot or conference acquires
 *   it again, as after a drain.
 *
 * The nodes announce themselves on their own: each connected replica writes
 * `fsnode:{id}` every 3 s.
 */
export function createRegistryRebuild(options: RegistryRebuildOptions) {
  const { registry, affinity, logger } = options;
  let lastEpoch: string | null | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<number> | undefined;

  async function rebuildNode(nodeId: string, esl: RebuildEsl): Promise<number> {
    const listed = await esl.sendApi('show channels as json');
    if (!listed.ok) throw new Error(`${nodeId}: show channels failed: ${listed.body}`);
    const rows = parseJson<{ rows?: { uuid?: string }[] }>(listed.body)?.rows ?? [];
    let rebuilt = 0;
    for (const row of rows) {
      const callUuid = row.uuid;
      if (callUuid === undefined || callUuid === '' || (await registry.hasCall(callUuid))) continue;
      const dumped = await esl.sendApi(`uuid_dump ${callUuid} json`);
      const fields = dumped.ok ? parseJson<Record<string, string>>(dumped.body) : undefined;
      if (fields === undefined) continue; // Hung up between the list and the dump.
      const created = microsToMs(fields['Caller-Channel-Created-Time']);
      const action = normalizeEslEvent(nodeId, {
        ...fields,
        'Event-Name': 'CHANNEL_CREATE',
        'Unique-ID': callUuid,
        ...(created === undefined ? {} : { 'Event-Date-Timestamp': `${created}000` }),
      });
      if (action.kind !== 'created') continue;
      await registry.createCall(action.call, options.callSafetyTtlMs);
      const answeredAt = microsToMs(fields['Caller-Channel-Answered-Time']);
      const bridgedTo = fields['Other-Leg-Unique-ID'] ?? fields['variable_bridge_uuid'];
      const held = fields['Channel-Call-State'] === 'HELD';
      const changes: Record<string, string> = {
        ...(answeredAt === undefined ? {} : { state: 'answered', answeredAt }),
        ...(held ? { state: 'held' } : {}),
        ...(bridgedTo === undefined || bridgedTo === '' ? {} : { bridgedTo }),
      };
      if (Object.keys(changes).length > 0) await registry.updateCall(callUuid, changes);
      rebuilt += 1;
    }
    return rebuilt;
  }

  async function rebuildCalls(): Promise<number> {
    const started = Date.now();
    const results = await Promise.allSettled(
      [...options.nodes()].map(
        async ([nodeId, esl]) => [nodeId, await rebuildNode(nodeId, esl)] as const,
      ),
    );
    let total = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') total += result.value[1];
      else
        logger.error(
          { err: result.reason as unknown },
          'registry rebuild: a node could not be read',
        );
    }
    logger.warn(
      { calls: total, nodes: results.length, ms: Date.now() - started },
      `registry rebuilt after Redis lost it: ${String(total)} live calls`,
    );
    return total;
  }

  async function check(): Promise<number> {
    let epoch = await registry.getEpoch();
    let rebuilt = 0;
    if (epoch === null) {
      if (await registry.claimEpoch(randomUUID())) rebuilt = await rebuildCalls();
      epoch = await registry.getEpoch();
    }
    if (lastEpoch !== undefined && epoch !== lastEpoch) await affinity.restore();
    lastEpoch = epoch;
    return rebuilt;
  }

  /** One check. Concurrent calls in this process share one. Answers the calls rebuilt, if any. */
  function runOnce(): Promise<number> {
    running ??= check().finally(() => {
      running = undefined;
    });
    return running;
  }

  return {
    runOnce,
    start(intervalMs: number = REBUILD_CHECK_INTERVAL_MS): void {
      timer = setInterval(() => {
        runOnce().catch((error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'registry rebuild: check failed; will retry',
          );
        });
      }, intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}

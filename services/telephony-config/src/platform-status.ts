import type { Database } from '@cuc/db';
import type { Logger } from '@cuc/logger';
import { sql } from 'kysely';

import type { OpenSipsMiClient } from './opensips-mi-client.js';
import type { OpenSipsDb } from './opensips-schema.js';
import { FS_DISPATCHER_SET } from './repo/opensips-projection.repo.js';
import type { TelephonyConfigDb } from './schema.js';

export interface SignallingStatus {
  readonly status: 'up' | 'down';
  readonly version: string | null;
  readonly uptimeSeconds: number | null;
  /** Registered phone contacts (`usrloc:location-contacts`). */
  readonly registrations: number | null;
  readonly activeDialogs: number | null;
  readonly earlyDialogs: number | null;
  readonly transactions: number | null;
  readonly shmUsedBytes: number | null;
  readonly shmTotalBytes: number | null;
}

export interface DispatcherDestinationStatus {
  readonly uri: string;
  /** The FS node id `seed-dispatcher.py` stored with it; null for an entry without one. */
  readonly nodeId: string | null;
  readonly state: 'active' | 'inactive' | 'probing';
  readonly weight: number;
}

export interface Fact {
  readonly label: string;
  readonly value: number;
  readonly unit: 'bytes' | 'count' | 'perSecond' | 'seconds' | 'percent';
}

export interface DataStoreStatus {
  readonly name: string;
  readonly status: 'up' | 'down';
  readonly version: string | null;
  readonly uptimeSeconds: number | null;
  readonly facts: readonly Fact[];
}

export interface PlatformStatus {
  readonly signalling: SignallingStatus;
  /** From OpenSIPs' memory when it answers, otherwise the `dispatcher` table; null if neither. */
  readonly dispatcher: readonly DispatcherDestinationStatus[] | null;
  readonly mariadb: DataStoreStatus;
}

interface DsListResult {
  readonly PARTITIONS?: readonly {
    readonly SETS?: readonly {
      readonly id: number;
      readonly Destinations?: readonly {
        readonly URI: string;
        readonly state: string;
        readonly attr?: string;
        readonly weight?: number | string;
      }[];
    }[];
  }[];
}

function stateOf(value: string | number): DispatcherDestinationStatus['state'] {
  const text = String(value).toLowerCase();
  if (text === 'active' || text === '0') return 'active';
  if (text === 'probing' || text === '2') return 'probing';
  return 'inactive';
}

/**
 * S4-12: what telephony-config can see that no other service can, for the operations console:
 * the SIP edge (OpenSIPs over MI), the FS pool as OpenSIPs holds it, and MariaDB (this service
 * already holds a connection). api-gateway asks for it once per overview. Every part degrades on
 * its own: OpenSIPs down still lists the pool from the table, and MariaDB down still answers.
 */
export function createPlatformStatus(deps: {
  readonly mi: OpenSipsMiClient;
  readonly opensipsDb: Database<OpenSipsDb>;
  readonly db: Database<TelephonyConfigDb>;
  readonly logger: Logger;
}): { read(): Promise<PlatformStatus> } {
  const { mi, opensipsDb, db, logger } = deps;
  /** The last `Questions` reading, for a per-second rate between two overviews. */
  let lastQuestions: { value: number; at: number } | undefined;

  async function signalling(): Promise<SignallingStatus> {
    try {
      const [uptime, stats, version] = await Promise.all([
        mi.query<Record<string, string>>('uptime'),
        mi.query<Record<string, number>>('get_statistics', {
          statistics: ['usrloc:', 'dialog:', 'tm:', 'shmem:'],
        }),
        mi.query<{ Server?: string }>('version'),
      ]);
      const stat = (name: string): number | null =>
        typeof stats[name] === 'number' ? stats[name] : null;
      const seconds = /^(\d+)/.exec(uptime['Up time'] ?? '');
      const server = /\(([\d.]+)/.exec(version.Server ?? '');
      return {
        status: 'up',
        version: server?.[1] ?? null,
        uptimeSeconds: seconds === null ? null : Number(seconds[1]),
        registrations: stat('usrloc:location-contacts'),
        activeDialogs: stat('dialog:active_dialogs'),
        earlyDialogs: stat('dialog:early_dialogs'),
        transactions: stat('tm:inuse_transactions'),
        shmUsedBytes: stat('shmem:real_used_size') ?? stat('shmem:used_size'),
        shmTotalBytes: stat('shmem:total_size'),
      };
    } catch (error) {
      logger.warn({ err: error }, 'platform status: OpenSIPs did not answer');
      return {
        status: 'down',
        version: null,
        uptimeSeconds: null,
        registrations: null,
        activeDialogs: null,
        earlyDialogs: null,
        transactions: null,
        shmUsedBytes: null,
        shmTotalBytes: null,
      };
    }
  }

  async function dispatcher(): Promise<DispatcherDestinationStatus[] | null> {
    try {
      const listed = await mi.query<DsListResult>('ds_list', { full: 1 });
      const set = listed.PARTITIONS?.[0]?.SETS?.find((s) => s.id === FS_DISPATCHER_SET);
      return (set?.Destinations ?? []).map((destination) => ({
        uri: destination.URI,
        nodeId: destination.attr === undefined || destination.attr === '' ? null : destination.attr,
        state: stateOf(destination.state),
        weight: Number(destination.weight ?? 1),
      }));
    } catch {
      // OpenSIPs is down: the table is what it will load when it comes back.
      try {
        const rows = await opensipsDb.kysely
          .selectFrom('dispatcher')
          .select(['destination', 'attrs', 'state', 'weight'])
          .where('setid', '=', FS_DISPATCHER_SET)
          .orderBy('id')
          .execute();
        return rows.map((row) => ({
          uri: row.destination,
          nodeId: row.attrs === null || row.attrs === '' ? null : row.attrs,
          state: stateOf(row.state),
          weight: Number(row.weight),
        }));
      } catch (error) {
        logger.warn({ err: error }, 'platform status: the dispatcher table could not be read');
        return null;
      }
    }
  }

  async function mariadb(): Promise<DataStoreStatus> {
    try {
      const [version, status] = await Promise.all([
        sql<{ version: string }>`SELECT VERSION() AS version`.execute(db.kysely),
        sql<{ Variable_name: string; Value: string }>`SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime', 'Threads_connected', 'Questions', 'Slow_queries', 'Max_used_connections')`.execute(
          db.kysely,
        ),
      ]);
      const value = (name: string): number =>
        Number(status.rows.find((row) => row.Variable_name === name)?.Value ?? 0);
      const now = Date.now();
      const questions = value('Questions');
      const facts: Fact[] = [
        { label: 'Connections', value: value('Threads_connected'), unit: 'count' },
        { label: 'Most connections', value: value('Max_used_connections'), unit: 'count' },
        { label: 'Slow queries', value: value('Slow_queries'), unit: 'count' },
      ];
      if (lastQuestions !== undefined && now > lastQuestions.at) {
        facts.unshift({
          label: 'Queries per second',
          value:
            Math.round(
              (Math.max(0, questions - lastQuestions.value) / ((now - lastQuestions.at) / 1000)) *
                10,
            ) / 10,
          unit: 'perSecond',
        });
      }
      lastQuestions = { value: questions, at: now };
      return {
        name: 'mariadb',
        status: 'up',
        version: (version.rows[0]?.version ?? '').split('-')[0] || null,
        uptimeSeconds: value('Uptime'),
        facts,
      };
    } catch (error) {
      logger.warn({ err: error }, 'platform status: MariaDB did not answer');
      return { name: 'mariadb', status: 'down', version: null, uptimeSeconds: null, facts: [] };
    }
  }

  return {
    async read() {
      const [s, d, m] = await Promise.all([signalling(), dispatcher(), mariadb()]);
      return { signalling: s, dispatcher: d, mariadb: m };
    },
  };
}

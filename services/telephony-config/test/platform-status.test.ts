import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import type { MiParams, OpenSipsMiClient } from '../src/opensips-mi-client.js';
import { createPlatformStatus } from '../src/platform-status.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

/** OpenSIPs' MI answers, as captured from 3.6.9. `down` makes every call fail. */
function fakeMi(down: () => boolean): OpenSipsMiClient {
  const answers: Record<string, unknown> = {
    uptime: { Now: 'Sun Sep 27 22:20:24 2026', 'Up time': '2078 [sec]' },
    version: { Server: 'OpenSIPS (3.6.9 (x86_64/linux))' },
    get_statistics: {
      'usrloc:location-contacts': 42,
      'dialog:active_dialogs': 5,
      'dialog:early_dialogs': 1,
      'tm:inuse_transactions': 6,
      'shmem:total_size': 33554432,
      'shmem:real_used_size': 7198664,
    },
    ds_list: {
      PARTITIONS: [
        {
          name: 'default',
          SETS: [
            {
              id: 1,
              Destinations: [
                { URI: 'sip:fs1:5060', state: 'Active', attr: 'fs1', weight: 3 },
                { URI: 'sip:fs2:5060', state: 'Inactive', attr: 'fs2', weight: 1 },
              ],
            },
          ],
        },
      ],
    },
  };
  return {
    call: () => (down() ? Promise.reject(new Error('down')) : Promise.resolve()),
    query<T>(method: string, _params?: MiParams): Promise<T> {
      if (down()) return Promise.reject(new Error('Could not reach OpenSIPs MI'));
      return Promise.resolve(answers[method] as T);
    },
  };
}

describe.skipIf(skipReason !== undefined)(
  'platform status for the operations console (S4-12)',
  () => {
    let h: Harness;
    let opensipsDown = false;

    beforeAll(async () => {
      h = await startHarness();
    });

    afterAll(async () => {
      await h?.close();
    });

    beforeEach(async () => {
      opensipsDown = false;
      await h.opensipsDb.kysely.deleteFrom('dispatcher').execute();
    });

    function status() {
      return createPlatformStatus({
        mi: fakeMi(() => opensipsDown),
        opensipsDb: h.opensipsDb,
        db: h.db,
        logger: h.logger,
      });
    }

    it('reads the SIP edge, the pool with weights, and MariaDB', async () => {
      const reader = status();
      const first = await reader.read();

      expect(first.signalling).toEqual({
        status: 'up',
        version: '3.6.9',
        uptimeSeconds: 2078,
        registrations: 42,
        activeDialogs: 5,
        earlyDialogs: 1,
        transactions: 6,
        shmUsedBytes: 7198664,
        shmTotalBytes: 33554432,
      });
      expect(first.dispatcher).toEqual([
        { uri: 'sip:fs1:5060', nodeId: 'fs1', state: 'active', weight: 3 },
        { uri: 'sip:fs2:5060', nodeId: 'fs2', state: 'inactive', weight: 1 },
      ]);
      expect(first.mariadb).toMatchObject({ name: 'mariadb', status: 'up' });
      expect(first.mariadb.version).toMatch(/^\d+\.\d+/);
      expect(first.mariadb.facts.map((fact) => fact.label)).toContain('Connections');

      // A rate needs two readings.
      const second = await reader.read();
      expect(second.mariadb.facts[0]?.label).toBe('Queries per second');
    });

    it('with OpenSIPs down, says so and lists the pool from the table', async () => {
      await h.opensipsDb.kysely
        .insertInto('dispatcher')
        .values({
          setid: 1,
          destination: 'sip:fs1:5060',
          state: 1,
          probe_mode: 0,
          weight: '2',
          priority: 0,
          attrs: 'fs1',
        })
        .execute();
      opensipsDown = true;

      const read = await status().read();

      expect(read.signalling).toMatchObject({ status: 'down', registrations: null });
      expect(read.dispatcher).toEqual([
        { uri: 'sip:fs1:5060', nodeId: 'fs1', state: 'inactive', weight: 2 },
      ]);
      expect(read.mariadb.status).toBe('up');
    });
  },
);

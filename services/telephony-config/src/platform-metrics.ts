import { sharedReading, type Server } from '@cuc/http';

import type { PlatformStatus } from './platform-status.js';

/**
 * S4-13 (G-124): the SIP edge, the FS pool as OpenSIPs holds it, and MariaDB as Prometheus gauges,
 * for the operations console's history. OpenSIPs' own `prometheus` module is not in its image;
 * this service already reads the same statistics over MI, and alone talks to OpenSIPs. Read once
 * per scrape. A figure OpenSIPs did not give (it is down) is left out, and `opensips_up` says so.
 */
export function registerPlatformMetrics(
  app: Server,
  status: { read(): Promise<PlatformStatus> },
): void {
  const read = sharedReading(() => status.read());
  const signalling = (
    name: string,
    description: string,
    pick: (s: PlatformStatus['signalling']) => number | null,
    unit?: string,
  ): void => {
    app.addGauge(name, { description, ...(unit === undefined ? {} : { unit }) }, async () => {
      const value = pick((await read()).signalling);
      return value === null ? [] : [{ value }];
    });
  };

  app.addGauge(
    'opensips_up',
    { description: 'Whether OpenSIPs answers over MI (1) or not (0).' },
    async () => ((await read()).signalling.status === 'up' ? 1 : 0),
  );
  signalling('opensips_registrations', 'Registered phone contacts.', (s) => s.registrations);
  signalling('opensips_active_dialogs', 'Calls OpenSIPs has set up.', (s) => s.activeDialogs);
  signalling('opensips_early_dialogs', 'Calls ringing through OpenSIPs.', (s) => s.earlyDialogs);
  signalling('opensips_transactions', 'SIP transactions in progress.', (s) => s.transactions);
  signalling(
    'opensips_shm_used_bytes',
    'Shared memory OpenSIPs uses.',
    (s) => s.shmUsedBytes,
    'By',
  );

  app.addGauge(
    'fs_dispatcher_weight',
    { description: "An FS node's weight in OpenSIPs' dispatcher." },
    async () =>
      ((await read()).dispatcher ?? []).flatMap((d) =>
        d.nodeId === null ? [] : [{ value: d.weight, attributes: { node: d.nodeId } }],
      ),
  );
  app.addGauge(
    'fs_dispatcher_active',
    { description: 'Whether OpenSIPs sends the FS node new calls (1) or not (0).' },
    async () =>
      ((await read()).dispatcher ?? []).flatMap((d) =>
        d.nodeId === null
          ? []
          : [{ value: d.state === 'active' ? 1 : 0, attributes: { node: d.nodeId } }],
      ),
  );

  app.addGauge(
    'mariadb_up',
    { description: 'Whether MariaDB answers (1) or not (0).' },
    async () => ((await read()).mariadb.status === 'up' ? 1 : 0),
  );
  app.addGauge('mariadb_connections', { description: 'Open MariaDB connections.' }, async () => {
    const fact = (await read()).mariadb.facts.find((f) => f.label === 'Connections');
    return fact === undefined ? [] : [{ value: fact.value }];
  });
}

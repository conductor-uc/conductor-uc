import { createServer } from '@cuc/http';
import { silentLogger } from '@cuc/testing';
import { describe, expect, it } from 'vitest';

import { registerPlatformMetrics } from '../src/platform-metrics.js';
import type { PlatformStatus } from '../src/platform-status.js';

const up: PlatformStatus = {
  signalling: {
    status: 'up',
    version: '3.6.9',
    uptimeSeconds: 100,
    registrations: 42,
    activeDialogs: 5,
    earlyDialogs: 1,
    transactions: 6,
    shmUsedBytes: 7198664,
    shmTotalBytes: 33554432,
  },
  dispatcher: [
    { uri: 'sip:fs1:5060', nodeId: 'fs1', state: 'active', weight: 3 },
    { uri: 'sip:fs2:5060', nodeId: 'fs2', state: 'inactive', weight: 1 },
    { uri: 'sip:x:5060', nodeId: null, state: 'active', weight: 1 },
  ],
  mariadb: {
    name: 'mariadb',
    status: 'up',
    version: '11.4.8',
    uptimeSeconds: 100,
    facts: [{ label: 'Connections', value: 9, unit: 'count' }],
  },
};

async function scrape(status: PlatformStatus): Promise<string> {
  const app = await createServer({ serviceName: 'telephony-config-test', logger: silentLogger() });
  registerPlatformMetrics(app, { read: () => Promise.resolve(status) });
  await app.ready();
  const body = (await app.inject({ method: 'GET', url: '/metrics' })).body;
  await app.close();
  return body;
}

describe('SIP edge, dispatcher and MariaDB gauges (S4-13)', () => {
  it('exports what OpenSIPs and MariaDB report, and each named node in the pool', async () => {
    const body = await scrape(up);
    expect(body).toContain('opensips_up 1');
    expect(body).toContain('opensips_registrations 42');
    expect(body).toContain('opensips_active_dialogs 5');
    expect(body).toContain('fs_dispatcher_weight{node="fs1"} 3');
    expect(body).toContain('fs_dispatcher_active{node="fs2"} 0');
    expect(body).toContain('mariadb_connections 9');
    expect(body).not.toContain('node="null"');
  });

  it('says OpenSIPs is down and leaves its figures out', async () => {
    const body = await scrape({
      ...up,
      signalling: {
        ...up.signalling,
        status: 'down',
        registrations: null,
        activeDialogs: null,
        earlyDialogs: null,
        transactions: null,
        shmUsedBytes: null,
        shmTotalBytes: null,
      },
    });
    expect(body).toContain('opensips_up 0');
    expect(body).not.toContain('opensips_registrations ');
  });
});

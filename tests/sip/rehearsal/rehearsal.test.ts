import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  seedFixtures,
  startDelayedCaller,
  startUas,
  stopContainer,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);

const EDGE_VIP = '10.10.0.100';
const APP_VIP = '10.10.0.102';

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

/** Polls `check` until it answers true; how long that took, in seconds. */
async function secondsUntil(check: () => Promise<boolean>, timeoutMs: number): Promise<number> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return (Date.now() - started) / 1000;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`not within ${String(timeoutMs / 1000)} s`);
}

/** Asks the surviving app server's load balancer: the MariaDB writer and the Redis role behind it. */
async function throughBalancer(app: string): Promise<{ writer: string; redis: string }> {
  const lb = ['exec', app, 'docker', 'exec', 'voice-app-lb-1'];
  const writer = await docker(
    ...lb,
    'mariadb',
    '--defaults-extra-file=/tmp/galera-check.cnf',
    '-h',
    APP_VIP,
    '-N',
    '-e',
    'SELECT @@hostname',
  ).catch(() => '');
  const redis = await docker(...lb, 'redis-cli', '-h', APP_VIP, 'role').catch(() => '');
  return { writer, redis: redis.split('\n')[0] ?? '' };
}

/** Which of `servers` holds `address` now (its keepalived). */
async function holder(servers: readonly string[], address: string): Promise<string | undefined> {
  for (const server of servers) {
    const addresses = await docker('exec', server, 'ip', '-4', '-o', 'addr', 'show').catch(
      () => '',
    );
    if (addresses.includes(` ${address}/`)) return server;
  }
  return undefined;
}

/**
 * S4-11, the deployment rehearsal: `infra/deploy`'s role files on eight Docker-in-Docker
 * servers (`rehearse.sh up`), each running its role as a real server would. A call goes through
 * the edge's floating address to the media server and back; then a whole edge, a whole app
 * server and a whole data server are killed in turn, and a call succeeds after each.
 */
describe('S4-11 the deployment rehearsal (live)', () => {
  let seed: SeedResult;
  let fqdn: string;
  let attempt = 0;

  beforeAll(async () => {
    seed = await seedFixtures();
    fqdn = seed.tenantCalls.fqdn;
  });

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  /** 802 registers and answers; 801 registers and calls it. True when both completed. */
  async function call(): Promise<boolean> {
    attempt += 1;
    const person = `rh-test-802-${String(attempt)}`;
    const caller = `rh-test-801-${String(attempt)}`;
    try {
      const uas = startUas({
        au: '802',
        ap: password('802'),
        authUri: fqdn,
        csvLine: `802;${fqdn}`,
        containerName: person,
      });
      await uas.ready();
      const uac = await startDelayedCaller({
        scenario: 'uac_call.xml',
        csvLine: `801;${fqdn};802`,
        au: '801',
        ap: password('801'),
        authUri: fqdn,
        containerName: caller,
      });
      // A failed call fails fast: the answering phone would otherwise wait its full minute for
      // an INVITE that never comes, and the measurement would include it.
      const callerResult = await uac.result();
      if (callerResult.successfulCalls !== 1) return false;
      return (await uas.result()).successfulCalls === 1;
    } catch {
      return false;
    } finally {
      await Promise.all([person, caller].map((name) => stopContainer(name)));
    }
  }

  /** Calls until one succeeds; answers how long that took, in seconds. */
  async function callSucceedsWithin(timeoutMs: number): Promise<number> {
    const started = Date.now();
    while (Date.now() - started < timeoutMs) {
      if (await call()) return (Date.now() - started) / 1000;
      await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    throw new Error(`no call succeeded within ${String(timeoutMs / 1000)} s`);
  }

  it('carries a call through the edge, the app servers, the data tier and the media server', async () => {
    const seconds = await callSucceedsWithin(120_000);
    // eslint-disable-next-line no-console
    console.log(`S4-11: first call through the rehearsal in ${seconds.toFixed(1)} s`);
  });

  it('keeps taking calls when the edge holding the floating address dies', async () => {
    const edges = ['rh-edge1', 'rh-edge2'];
    const active = await holder(edges, EDGE_VIP);
    expect(active).toBeDefined();
    const survivor = edges.find((edge) => edge !== active)!;
    await docker('kill', active!);
    const moved = await secondsUntil(
      async () => (await holder(edges, EDGE_VIP)) === survivor,
      30_000,
    );
    const seconds = await callSucceedsWithin(120_000);
    // eslint-disable-next-line no-console
    console.log(
      `S4-11: ${active!} died; ${survivor} held the floating address ${moved.toFixed(1)} s later, and the next call succeeded ${seconds.toFixed(1)} s after that`,
    );
  });

  it('keeps taking calls when the app server holding the load balancer address dies', async () => {
    const apps = ['rh-app1', 'rh-app2'];
    const active = await holder(apps, APP_VIP);
    expect(active).toBeDefined();
    const survivor = apps.find((app) => app !== active)!;
    await docker('kill', active!);
    const moved = await secondsUntil(
      async () => (await holder(apps, APP_VIP)) === survivor,
      30_000,
    );
    const seconds = await callSucceedsWithin(180_000);
    // eslint-disable-next-line no-console
    console.log(
      `S4-11: ${active!} died; ${survivor} held the balancer's address ${moved.toFixed(1)} s later, and the next call succeeded ${seconds.toFixed(1)} s after that`,
    );
  });

  it('keeps taking calls when the data server holding the writer and the Redis primary dies', async () => {
    const app = (await holder(['rh-app1', 'rh-app2'], APP_VIP))!;
    const before = await throughBalancer(app);
    expect(before.writer).toBe('data1');
    expect(before.redis).toBe('master');
    await docker('kill', 'rh-data1');
    // Another member writes, and the balancer reaches a new Redis primary.
    const moved = await secondsUntil(async () => {
      const now = await throughBalancer(app);
      return now.writer !== '' && now.writer !== 'data1' && now.redis === 'master';
    }, 60_000);
    const seconds = await callSucceedsWithin(180_000);
    // eslint-disable-next-line no-console
    console.log(
      `S4-11: rh-data1 died; a new writer and Redis primary ${moved.toFixed(1)} s later, and the next call succeeded ${seconds.toFixed(1)} s after that`,
    );
  });
});

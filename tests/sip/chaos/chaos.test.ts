import { execFile } from 'node:child_process';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeOpensipsContainer,
  clearRegistration,
  dispatcherStates,
  dockerCurlJson,
  internalServiceHeaders,
  opensipsMi,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  type SeedResult,
} from '../src/run-scenario.js';
import { impact, startLoad, type Phone } from './load.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const CALL_CONTROL_URL = 'http://call-control:8080';
const KEY_PREFIX = 'cuc:dev:';
const VIP = '172.18.255.10';
const RESULTS_DIR = path.resolve(new URL('..', import.meta.url).pathname, 'chaos-results');
/** How long each failure is watched once caused. */
const WATCH_MS = 40_000;

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args);
  return stdout.trim();
}

async function healthy(container: string): Promise<boolean> {
  return (
    (await docker('inspect', '-f', '{{.State.Health.Status}}', container).catch(() => '')) ===
    'healthy'
  );
}

async function waitFor(check: () => Promise<boolean>, timeoutMs: number): Promise<number | null> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await check().catch(() => false)) return Date.now();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** One failure the suite causes, and what it is measured against (04 §4, 10 §5). */
interface Failure {
  readonly name: string;
  /** Kills the member and answers its container, for the restore. */
  kill(): Promise<string>;
  /** True once the platform has noticed and moved on (the failover has happened). */
  detected(killed: string): Promise<boolean>;
  /** Brings the member back and waits until it has rejoined. */
  restore(killed: string): Promise<void>;
  /** Seconds, from the kill: until the failover, and until calls succeed again. */
  readonly detectionTarget: number;
  readonly outageTarget: number;
}

interface Result {
  readonly failure: string;
  readonly killed: string;
  readonly detectionSeconds: number | null;
  readonly detectionTarget: number;
  readonly outageSeconds: number;
  readonly outageTarget: number;
  readonly failedCalls: number;
  readonly succeededCalls: number;
  readonly met: boolean;
}

/**
 * S4-08 (the plan's "Done when"): under steady call load, each failure 10 §5 plans for is caused
 * in turn: a media node, an edge, a telephony-config, a call-control, the Redis primary and the
 * MariaDB writer. Each run records how long the platform took to notice and fail over, and how
 * long new calls failed, against the targets, in `chaos-results/` and the job summary.
 *
 * Needs the chaos environment (`infra/compose/docker-compose.chaos.yml`: the data tier of S4-07
 * and a second telephony-config) and runs only with `pnpm chaos` (its own vitest config).
 */
describe.skipIf(skipReason !== undefined)('S4-08 chaos under call load', () => {
  let seed: SeedResult;
  let fqdn: string;
  let caller: Phone;
  let callee: Phone;
  const results: Result[] = [];

  beforeAll(async () => {
    seed = await seedFixtures();
    fqdn = seed.tenantCalls.fqdn;
    const phone = (number: string): Phone => {
      const entry = seed.extensions[`${fqdn}/${number}`];
      if (entry === undefined) throw new Error(`no seeded extension ${number}`);
      return { number, password: entry.password };
    };
    caller = phone('801');
    callee = phone('802');
  }, 180_000);

  afterAll(async () => {
    await mkdir(RESULTS_DIR, { recursive: true });
    const stamp = new Date().toISOString().replaceAll(':', '-');
    await writeFile(
      path.join(RESULTS_DIR, `chaos-${stamp}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    );
    const lines = [
      '| Failure | Failover (s) | Target | Calls failing (s) | Target | Calls failed / succeeded | Met |',
      '|---|---|---|---|---|---|---|',
      ...results.map(
        (r) =>
          `| ${r.failure} (${r.killed}) | ${r.detectionSeconds?.toFixed(1) ?? 'never'} | ≤ ${String(r.detectionTarget)} | ${r.outageSeconds.toFixed(1)} | ≤ ${String(r.outageTarget)} | ${String(r.failedCalls)} / ${String(r.succeededCalls)} | ${r.met ? 'yes' : '**no**'} |`,
      ),
    ];
    // eslint-disable-next-line no-console
    console.log(`\nS4-08 chaos results\n${lines.join('\n')}\n`);
    const summary = process.env['GITHUB_STEP_SUMMARY'];
    if (summary !== undefined) await appendFile(summary, `## Chaos\n\n${lines.join('\n')}\n`);
  });

  async function run(failure: Failure): Promise<void> {
    for (const phone of [caller, callee]) await clearRegistration(`${phone.number}@${fqdn}`);
    const load = await startLoad({ fqdn, caller, callee, name: 'chaos-load' });
    let killed: string | undefined;
    let result: Result | undefined;
    try {
      // Calls flow before anything fails.
      await new Promise((resolve) => setTimeout(resolve, 10_000));
      killed = await failure.kill();
      const killedAt = Date.now();
      const detectedAt = await waitFor(() => failure.detected(killed!), WATCH_MS);
      const until = killedAt + WATCH_MS;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, until - Date.now())));
      const seconds = await load.stop();
      const measured = impact(seconds, killedAt, until);
      const detectionSeconds = detectedAt === null ? null : (detectedAt - killedAt) / 1000;
      result = {
        failure: failure.name,
        killed,
        detectionSeconds,
        detectionTarget: failure.detectionTarget,
        outageSeconds: measured.outageSeconds,
        outageTarget: failure.outageTarget,
        failedCalls: measured.failed,
        succeededCalls: measured.succeeded,
        met:
          detectionSeconds !== null &&
          detectionSeconds <= failure.detectionTarget &&
          measured.outageSeconds <= failure.outageTarget &&
          measured.succeeded > 0,
      };
      results.push(result);
    } finally {
      await load.stop().catch(() => undefined);
      if (killed !== undefined) await failure.restore(killed);
    }
    expect(result?.succeededCalls, 'calls succeeded after the failure').toBeGreaterThan(0);
    expect(result?.detectionSeconds, 'failover').not.toBeNull();
    expect(result.detectionSeconds!).toBeLessThanOrEqual(failure.detectionTarget);
    expect(result.outageSeconds).toBeLessThanOrEqual(failure.outageTarget);
  }

  /** Restarts a killed container and waits until it reports healthy. */
  async function restart(container: string): Promise<void> {
    await docker('start', container);
    await waitFor(() => healthy(container), 180_000);
  }

  async function nodes(): Promise<{ nodeId: string; status: string }[]> {
    const response = await dockerCurlJson(
      'GET',
      `${CALL_CONTROL_URL}/internal/v1/nodes`,
      undefined,
      internalServiceHeaders(),
    );
    return (response.json as { nodes?: { nodeId: string; status: string }[] }).nodes ?? [];
  }

  async function redisGet(key: string): Promise<string> {
    return docker('exec', 'conductor-uc-redis-1-1', 'redis-cli', '--raw', 'GET', key).catch(
      () => '',
    );
  }

  it('a media node dies', async () => {
    await run({
      name: 'media node',
      detectionTarget: 10,
      outageTarget: 10,
      kill: async () => {
        await docker('kill', 'conductor-uc-freeswitch-2-1');
        return 'conductor-uc-freeswitch-2-1';
      },
      // call-control has declared it down, and OpenSIPs no longer sends it calls.
      detected: async () =>
        (await nodes()).find((node) => node.nodeId === 'freeswitch-2')?.status === 'down' &&
        (await dispatcherStates()).find((d) => d.uri === 'sip:freeswitch-2:5060')?.state !==
          'Active',
      restore: async (container) => {
        await restart(container);
        await waitFor(
          async () =>
            (await dispatcherStates()).find((d) => d.uri === 'sip:freeswitch-2:5060')?.state ===
              'Active' &&
            (await nodes()).find((node) => node.nodeId === 'freeswitch-2')?.status === 'up',
          120_000,
        );
      },
    });
  }, 400_000);

  it('the active edge dies', async () => {
    await run({
      name: 'edge (OpenSIPs)',
      detectionTarget: 10,
      outageTarget: 10,
      kill: async () => {
        const active = await activeOpensipsContainer();
        await docker('kill', active);
        return active;
      },
      detected: async (killed) => {
        const survivor = sipTestEnv().opensipsContainers.find((c) => c !== killed)!;
        const addresses = await docker('exec', survivor, 'ip', '-4', '-o', 'addr', 'show');
        return addresses.includes(` ${VIP}/`) && (await activeOpensipsContainer()) === survivor;
      },
      restore: restart,
    });
  }, 400_000);

  it('a telephony-config replica dies', async () => {
    await run({
      name: 'telephony-config replica',
      detectionTarget: 10,
      outageTarget: 10,
      kill: async () => {
        await docker('kill', 'conductor-uc-telephony-config-1');
        return 'conductor-uc-telephony-config-1';
      },
      // Nothing to fail over: the other replica answers the same name.
      detected: async () => healthy('conductor-uc-telephony-config-2-1'),
      restore: restart,
    });
  }, 400_000);

  it('a call-control replica dies', async () => {
    await run({
      name: 'call-control replica',
      detectionTarget: 10,
      outageTarget: 10,
      kill: async () => {
        // The replica owning the first node (S4-03).
        const owner = await redisGet(`${KEY_PREFIX}nodeowner:freeswitch`);
        for (const container of ['conductor-uc-call-control-1', 'conductor-uc-call-control-2-1']) {
          const host = await docker('inspect', '-f', '{{.Config.Hostname}}', container);
          if (owner.startsWith(`${host}:`)) {
            await docker('kill', container);
            return container;
          }
        }
        throw new Error(`no replica owns freeswitch (${owner})`);
      },
      // Every node owned by the surviving replica.
      detected: async (killed) => {
        const host = await docker('inspect', '-f', '{{.Config.Hostname}}', killed);
        const owners = await Promise.all(
          ['freeswitch', 'freeswitch-2'].map((node) => redisGet(`${KEY_PREFIX}nodeowner:${node}`)),
        );
        return owners.every((owner) => owner !== '' && !owner.startsWith(`${host}:`));
      },
      restore: restart,
    });
  }, 400_000);

  it('the Redis primary dies', async () => {
    const members = ['conductor-uc-redis-1-1', 'conductor-uc-redis-2-1', 'conductor-uc-redis-3-1'];
    const role = (container: string) => docker('exec', container, 'redis-cli', 'role');
    await run({
      name: 'Redis primary',
      detectionTarget: 15,
      outageTarget: 15,
      kill: async () => {
        for (const container of members) {
          if ((await role(container)).startsWith('master')) {
            await docker('kill', container);
            return container;
          }
        }
        throw new Error('no Redis primary');
      },
      // Another member promoted, and the load balancer reaching it.
      detected: async (killed) => {
        const promoted = await Promise.all(
          members
            .filter((c) => c !== killed)
            .map(async (c) => (await role(c).catch(() => '')).startsWith('master')),
        );
        const balanced = await docker(
          'exec',
          'conductor-uc-redis-1',
          'redis-cli',
          '-h',
          '127.0.0.1',
          'role',
        );
        return promoted.some(Boolean) && balanced.startsWith('master');
      },
      restore: async (container) => {
        await docker('start', container);
        await waitFor(async () => (await role(container)).startsWith('slave'), 60_000);
      },
    });
  }, 400_000);

  it('the MariaDB writer dies', async () => {
    const writer = () =>
      docker(
        'exec',
        'conductor-uc-mariadb-1',
        'mariadb',
        '--defaults-extra-file=/tmp/galera-check.cnf',
        '-h',
        '127.0.0.1',
        '-N',
        '-e',
        'SELECT @@hostname',
      );
    await run({
      name: 'MariaDB writer',
      detectionTarget: 10,
      outageTarget: 15,
      kill: async () => {
        const member = await writer();
        await docker('kill', `conductor-uc-${member}-1`);
        return `conductor-uc-${member}-1`;
      },
      detected: async (killed) => {
        const member = await writer();
        return member !== '' && killed !== `conductor-uc-${member}-1`;
      },
      restore: restart,
    });
  }, 400_000);

  // Every member is back before the next run (or the everyday suite).
  afterAll(async () => {
    for (const destination of await dispatcherStates()) {
      await opensipsMi('ds_set_state', 'a', '1', destination.uri);
    }
  });
});

import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  activeOpensipsContainer,
  buildSippCommand,
  clearRegistration,
  fsCliOn,
  SCENARIOS_DIR,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  tenantAdminCurlJson,
  waitForProjected,
  type SeedResult,
} from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

const PBX_CONFIG_SERVICE_URL = 'http://pbx-config-service:8080';
const RECORDING_SERVICE_URL = 'http://recording-service:8080';
const RESULTS_DIR = path.resolve(new URL('..', import.meta.url).pathname, 'bench-results');
/** A node is sized to run at most this share of each vCPU, leaving headroom for bursts. */
const TARGET_CPU_PERCENT = 80;
const CALL_SECONDS = 30;
/** Diagnosis: keep the SIPp containers and their error logs (`BENCH_KEEP=1`). */
const KEEP = process.env['BENCH_KEEP'] === '1';
/**
 * New calls a second. Every call comes from one address, and each starts with four requests
 * (INVITE, the 407's ACK, the INVITE again, the 200's ACK): 3 a second is 24 per pike's 2 s
 * window, under its 30 (opensips.cfg.template), where real phones would each have their own.
 */
const CALLS_PER_SECOND = 3;
/** CPU readings per container while every call is up; each takes about 2 s. */
const SAMPLES = 5;

interface Measured {
  readonly workload: string;
  readonly concurrent: number;
  readonly succeeded: number;
  readonly failed: number;
  /** The legs on the media nodes while every call was up, as `direction codec`: how many. */
  readonly legs: Readonly<Record<string, number>>;
  /** Percent of one CPU core, above idle, over every media node, averaged over the steady part. */
  readonly nodeCpuPercent: number;
  readonly perCallPercent: number;
  readonly callsPerVcpu: number;
  /** The active edge's OpenSIPs and media relay (S4-10), for the same calls. */
  readonly edgeCpuPercent: number;
  readonly edgeCallsPerVcpu: number | null;
}

async function docker(...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  return stdout.trim();
}

/** The containers' CPU use together (percent of one core), averaged over `samples` readings. */
async function cpuPercent(containers: readonly string[], samples: number): Promise<number> {
  let total = 0;
  for (let i = 0; i < samples; i += 1) {
    const values = await docker('stats', '--no-stream', '--format', '{{.CPUPerc}}', ...containers);
    for (const value of values.split('\n')) total += Number(value.trim().replace('%', ''));
  }
  return total / samples;
}

/** Every leg on the media nodes now, counted as `direction codec` (`inbound PCMU`). */
async function legsNow(): Promise<Record<string, number>> {
  const legs: Record<string, number> = {};
  for (const node of sipTestEnv().freeswitchContainers) {
    const shown = JSON.parse(await fsCliOn(node, 'show channels as json')) as {
      rows?: { direction: string; read_codec: string }[];
    };
    for (const row of shown.rows ?? []) {
      const key = `${row.direction} ${row.read_codec}`;
      legs[key] = (legs[key] ?? 0) + 1;
    }
  }
  return legs;
}

/** SIPp's final statistics from a finished container's log. */
function parseTotals(log: string): { succeeded: number; failed: number } {
  const last = (label: string) => {
    const matches = [...log.matchAll(new RegExp(`${label}\\s+\\|\\s+\\d+\\s+\\|\\s+(\\d+)`, 'g'))];
    return Number(matches.at(-1)?.[1] ?? 0);
  };
  return { succeeded: last('Successful call'), failed: last('Failed call') };
}

/**
 * S4-09 (the plan's "Done when": the concurrent-call ceiling per vCPU for G.711 bridged, G.711
 * recorded, Opus↔G.711 transcoded, and audio conference participants; published in
 * docs/operations/sizing.md). Each workload runs a fixed number of calls at once, streaming real
 * audio both ways for 30 s, and the media nodes' CPU is sampled while all of them are up. The
 * calls go wherever the edge sends them, so the CPU of every media node is added up. What one
 * call costs, above the nodes' idle use, gives how many one vCPU carries at
 * {@link TARGET_CPU_PERCENT}. The active edge's share (OpenSIPs and the S4-10 media relay) is
 * measured too, since every call's media crosses it.
 *
 * Each workload also says which legs it expects on the nodes, by codec, and fails when they are
 * not there: a number for a load that was not the one named is worse than none. (The first
 * "transcoded" figure was for calls that were Opus on both legs, G-134.)
 *
 * Runs only with `pnpm bench` (its own vitest config), on the development stack. The figures
 * depend on the machine; they are written to `bench-results/` and printed, and sizing.md records
 * the ones measured for this release with the machine they came from.
 */
describe.skipIf(skipReason !== undefined)('S4-09 capacity per media node', () => {
  let seed: SeedResult;
  let tenantId: string;
  let fqdn: string;
  const results: Measured[] = [];

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    fqdn = seed.tenantCalls.fqdn;
  }, 180_000);

  afterAll(async () => {
    await mkdir(RESULTS_DIR, { recursive: true });
    await writeFile(
      path.join(RESULTS_DIR, `bench-${new Date().toISOString().replaceAll(':', '-')}.json`),
      `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`,
    );
    const lines = [
      '| Workload | Calls at once | Media node CPU (% of a core) | Per call | Calls per vCPU at 80% | Edge CPU | Edge calls per vCPU |',
      '|---|---|---|---|---|---|---|',
      ...results.map(
        (r) =>
          `| ${r.workload} | ${String(r.concurrent)} (${String(r.failed)} failed) | ${r.nodeCpuPercent.toFixed(1)} | ${r.perCallPercent.toFixed(3)} | ${String(r.callsPerVcpu)} | ${r.edgeCpuPercent.toFixed(1)} | ${r.edgeCallsPerVcpu === null ? '—' : String(r.edgeCallsPerVcpu)} |`,
      ),
    ];
    // eslint-disable-next-line no-console
    console.log(`\nS4-09 capacity\n${lines.join('\n')}\n`);
  }, 120_000);

  function password(number: string): string {
    const entry = seed.extensions[`${fqdn}/${number}`];
    if (entry === undefined) throw new Error(`no seeded extension ${number}`);
    return entry.password;
  }

  /** Runs one SIPp container; answers its name. */
  async function sipp(name: string, dir: string, command: string): Promise<string> {
    const env = sipTestEnv();
    await docker('rm', '-f', name).catch(() => '');
    await docker(
      'run',
      '-d',
      '--name',
      name,
      '--network',
      env.network,
      '--entrypoint',
      'sh',
      '-w',
      '/data',
      '-v',
      `${SCENARIOS_DIR}:/scenarios:ro`,
      '-v',
      `${dir}:/data`,
      env.sippImage,
      '-c',
      command,
    );
    return name;
  }

  async function waitForLog(container: string, text: string, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { stdout, stderr } = await execFileAsync('docker', ['logs', container]).catch(() => ({
        stdout: '',
        stderr: '',
      }));
      if (`${stdout}${stderr}`.includes(text)) return;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`${container} never logged "${text}"`);
  }

  async function waitForExit(container: string, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if ((await docker('inspect', '-f', '{{.State.Running}}', container)) === 'false') {
        const { stdout } = await execFileAsync('docker', ['logs', container], {
          maxBuffer: 16 * 1024 * 1024,
        });
        return stdout;
      }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new Error(`${container} did not finish`);
  }

  /** Registers `number` and answers every call it is sent with `scenario`, until removed. */
  async function phone(
    name: string,
    dir: string,
    number: string,
    scenario: string,
  ): Promise<string> {
    const env = sipTestEnv();
    await clearRegistration(`${number}@${fqdn}`);
    await writeFile(path.join(dir, `${number}.csv`), `SEQUENTIAL\n${number};${fqdn}\n`);
    const register = buildSippCommand({
      scenarioPath: '/scenarios/register.xml',
      csvPath: `/data/${number}.csv`,
      au: number,
      ap: password(number),
      authUri: fqdn,
      localPort: 6000,
      remoteHost: env.opensipsTarget,
      logPrefix: `${name}_reg`,
    });
    const answer = buildSippCommand({
      scenarioPath: `/scenarios/${scenario}`,
      csvPath: `/data/${number}.csv`,
      localPort: 6000,
      logPrefix: name,
      maxCalls: null,
      extraArgs: ['-mp', '7000'],
    });
    await sipp(name, dir, `${register} && ${answer}`);
    await waitForLog(name, 'Sipp Server Mode', 45_000);
    return name;
  }

  /**
   * One workload: `place` starts `concurrent` calls, {@link CALLS_PER_SECOND} a second, and
   * answers how to wait for them to end and count them. While all are up, the CPU of every media
   * node and of the active edge is sampled, and the legs on the nodes are counted by codec and
   * checked against `legs`.
   */
  async function measure(
    workload: string,
    options: {
      readonly concurrent: number;
      /** Legs the media nodes must be carrying, as `direction codec`: how many. Others may be. */
      readonly legs: Readonly<Record<string, number>>;
      readonly place: (
        dir: string,
        containers: string[],
      ) => Promise<() => Promise<{ succeeded: number; failed: number }>>;
    },
  ): Promise<Measured> {
    const dir = await mkdtemp(path.join(tmpdir(), 'bench-'));
    const containers: string[] = [];
    try {
      const nodes = sipTestEnv().freeswitchContainers;
      const edge = [await activeOpensipsContainer()];
      const nodeIdle = await cpuPercent(nodes, 3);
      const edgeIdle = await cpuPercent(edge, 3);

      const finish = await options.place(dir, containers);

      // Every call up (the ramp, and a margin), then sample while they all still are.
      const ramp = options.concurrent / CALLS_PER_SECOND;
      await new Promise((resolve) => setTimeout(resolve, (ramp + 3) * 1000));
      const [legs, node, edgeLoad] = await Promise.all([
        legsNow(),
        cpuPercent(nodes, SAMPLES),
        cpuPercent(edge, SAMPLES),
      ]);
      const totals = await finish();

      const nodeCpuPercent = Math.max(0, node - nodeIdle);
      const perCallPercent = nodeCpuPercent / options.concurrent;
      const edgeCpuPercent = Math.max(0, edgeLoad - edgeIdle);
      const result: Measured = {
        workload,
        concurrent: options.concurrent,
        succeeded: totals.succeeded,
        failed: totals.failed,
        legs,
        nodeCpuPercent,
        perCallPercent,
        callsPerVcpu: Math.floor(TARGET_CPU_PERCENT / perCallPercent),
        edgeCpuPercent,
        edgeCallsPerVcpu:
          edgeCpuPercent > 0
            ? Math.floor(TARGET_CPU_PERCENT / (edgeCpuPercent / options.concurrent))
            : null,
      };
      results.push(result);
      expect(result.failed, workload).toBe(0);
      expect(result.succeeded, workload).toBe(options.concurrent);
      expect(result.legs, workload).toMatchObject(options.legs);
      return result;
    } finally {
      if (KEEP) {
        // eslint-disable-next-line no-console
        console.log(`kept ${containers.join(', ')} and ${dir}`);
      } else {
        await Promise.all(containers.map((name) => docker('rm', '-f', name).catch(() => '')));
        await rm(dir, { recursive: true, force: true });
      }
    }
  }

  /**
   * `concurrent` calls from 801 to `destination` through the platform, as a phone places them:
   * G.711 (`uac_bench_pcmu.xml`), or `opus`, preferring Opus (`uac_bench_opus.xml`). 802 answers
   * with G.711 alone when `answered` (a conference answers its own).
   */
  function dialed(options: {
    readonly concurrent: number;
    readonly destination: string;
    readonly answered: boolean;
    readonly opus?: boolean;
  }) {
    return async (dir: string, containers: string[]) => {
      const env = sipTestEnv();
      await clearRegistration(`801@${fqdn}`);
      await writeFile(
        path.join(dir, 'caller.csv'),
        `SEQUENTIAL\n801;${fqdn};${options.destination}\n`,
      );
      if (options.answered) {
        containers.push('bench-callee');
        await phone('bench-callee', dir, '802', 'answer_bench_pcmu.xml');
      }
      const calls = buildSippCommand({
        scenarioPath: `/scenarios/${options.opus === true ? 'uac_bench_opus.xml' : 'uac_bench_pcmu.xml'}`,
        csvPath: '/data/caller.csv',
        au: '801',
        ap: password('801'),
        authUri: fqdn,
        remoteHost: env.opensipsTarget,
        logPrefix: 'caller',
        maxCalls: options.concurrent,
        extraArgs: [
          '-l',
          String(options.concurrent),
          '-r',
          String(CALLS_PER_SECOND),
          '-rp',
          '1000',
          '-mp',
          '7000',
          '-recv_timeout',
          '10000',
          '-trace_err',
        ],
      });
      containers.push('bench-caller');
      await sipp('bench-caller', dir, calls);
      const ramp = options.concurrent / CALLS_PER_SECOND;
      return async () =>
        parseTotals(await waitForExit('bench-caller', (CALL_SECONDS + ramp + 60) * 1000));
    };
  }

  it('G.711 bridged', async () => {
    await measure('G.711 bridged', {
      concurrent: 40,
      legs: { 'inbound PCMU': 40, 'outbound PCMU': 40 },
      place: dialed({ concurrent: 40, destination: '802', answered: true }),
    });
  }, 300_000);

  it('G.711 recorded', async () => {
    const extensions = await tenantAdminCurlJson(
      seed.resellerId,
      'GET',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/extensions`,
    );
    const callee = (extensions.json as { rows: { id: string; number: string }[] }).rows.find(
      (row) => row.number === '802',
    );
    const policy = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies`,
      {
        scopeType: 'extension',
        scopeId: callee!.id,
        direction: 'any',
        action: 'record',
        announce: false,
      },
    );
    expect(policy.status, JSON.stringify(policy.json)).toBe(201);
    const policyId = (policy.json as { id: string }).id;
    try {
      await measure('G.711 recorded', {
        concurrent: 40,
        legs: { 'inbound PCMU': 40, 'outbound PCMU': 40 },
        place: dialed({ concurrent: 40, destination: '802', answered: true }),
      });
    } finally {
      await tenantAdminCurlJson(
        seed.resellerId,
        'DELETE',
        `${RECORDING_SERVICE_URL}/v1/tenants/${tenantId}/recording-policies/${policyId}`,
      );
    }
  }, 300_000);

  it('Opus ↔ G.711 transcoded', async () => {
    // The caller's phone prefers Opus and the one called speaks only G.711: the called leg is
    // offered G.711 after the caller's Opus (G-134), and the node converts every packet.
    await measure('Opus ↔ G.711 transcoded', {
      concurrent: 30,
      legs: { 'inbound opus': 30, 'outbound PCMU': 30 },
      place: dialed({ concurrent: 30, destination: '802', answered: true, opus: true }),
    });
  }, 300_000);

  it('audio conference participants', async () => {
    const created = await tenantAdminCurlJson(
      seed.resellerId,
      'POST',
      `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms`,
      { label: 'S4-09 bench room', number: '907', maxMembers: 100 },
    );
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const roomId = (created.json as { id: string }).id;
    try {
      await waitForProjected('conference_rooms', 'id', roomId);
      await measure('Audio conference participant', {
        concurrent: 30,
        // Every participant is in the room, which is on one node, as the conference's own
        // format. One whose call the edge sent to the other node is bridged across from it
        // (S4-05), which adds a G.711 leg in and a leg out there.
        legs: { 'inbound L16': 30 },
        place: dialed({ concurrent: 30, destination: '907', answered: false }),
      });
    } finally {
      await tenantAdminCurlJson(
        seed.resellerId,
        'DELETE',
        `${PBX_CONFIG_SERVICE_URL}/v1/tenants/${tenantId}/conference-rooms/${roomId}`,
      );
    }
  }, 300_000);
});

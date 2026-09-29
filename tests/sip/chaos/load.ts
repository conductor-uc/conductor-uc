import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { buildSippCommand, SCENARIOS_DIR, sipTestEnv } from '../src/run-scenario.js';

const execFileAsync = promisify(execFile);

/** One second of the load's statistics: calls that ended in it, and how. */
export interface LoadSecond {
  /** Unix milliseconds. */
  readonly at: number;
  readonly succeeded: number;
  readonly failed: number;
}

export interface Phone {
  readonly number: string;
  readonly password: string;
}

/**
 * S4-08: steady call load through the whole platform for the chaos suite. `caller` calls
 * `callee` once a second (register, call, half a second of talk, hang up), at most five at once;
 * `callee` answers every call. SIPp writes its statistics every second, so the suite can see when
 * calls failed and when they succeeded again. A call that gets no answer fails after 6 s.
 */
export async function startLoad(opts: {
  readonly fqdn: string;
  readonly caller: Phone;
  readonly callee: Phone;
  readonly name: string;
}) {
  const env = sipTestEnv();
  const dir = await mkdtemp(path.join(tmpdir(), 'chaos-load-'));
  await writeFile(path.join(dir, 'callee.csv'), `SEQUENTIAL\n${opts.callee.number};${opts.fqdn}\n`);
  await writeFile(
    path.join(dir, 'caller.csv'),
    `SEQUENTIAL\n${opts.caller.number};${opts.fqdn};${opts.callee.number}\n`,
  );
  const callee = `${opts.name}-callee`;
  const caller = `${opts.name}-caller`;

  async function run(name: string, command: string): Promise<void> {
    await execFileAsync('docker', ['rm', '-f', name]).catch(() => undefined);
    await execFileAsync('docker', [
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
    ]);
  }

  const register = buildSippCommand({
    scenarioPath: '/scenarios/register.xml',
    csvPath: '/data/callee.csv',
    au: opts.callee.number,
    ap: opts.callee.password,
    authUri: opts.fqdn,
    localPort: 6000,
    remoteHost: env.opensipsTarget,
    logPrefix: 'callee_reg',
  });
  const answer = buildSippCommand({
    scenarioPath: '/scenarios/answer_call.xml',
    csvPath: '/data/callee.csv',
    localPort: 6000,
    logPrefix: 'callee',
    maxCalls: null,
  });
  await run(callee, `${register} && ${answer}`);
  await waitForLog(callee, 'Sipp Server Mode', 45_000);

  const calls = buildSippCommand({
    scenarioPath: '/scenarios/uac_call.xml',
    csvPath: '/data/caller.csv',
    au: opts.caller.number,
    ap: opts.caller.password,
    authUri: opts.fqdn,
    remoteHost: env.opensipsTarget,
    logPrefix: 'caller',
    maxCalls: null,
    extraArgs: [
      '-r',
      '1',
      '-rp',
      '1000',
      '-l',
      '5',
      '-recv_timeout',
      '6000',
      '-trace_stat',
      '-stf',
      '/data/stats.csv',
      '-fd',
      '1',
    ],
  });
  await run(caller, calls);

  return {
    /** Stops the load and answers its statistics, one row per second. */
    async stop(): Promise<LoadSecond[]> {
      await execFileAsync('docker', ['stop', '-t', '5', caller]).catch(() => undefined);
      const raw = await readFile(path.join(dir, 'stats.csv'), 'utf8').catch(() => '');
      await Promise.all(
        [caller, callee].map((name) =>
          execFileAsync('docker', ['rm', '-f', name]).catch(() => undefined),
        ),
      );
      await rm(dir, { recursive: true, force: true });
      return parseStats(raw);
    },
  };
}

/** SIPp's `-trace_stat` file: `;`-separated, a header row, then one row per period. */
export function parseStats(raw: string): LoadSecond[] {
  const [header, ...rows] = raw.split('\n').filter((line) => line.trim() !== '');
  if (header === undefined) return [];
  const columns = header.split(';');
  const at = columns.indexOf('CurrentTime');
  const succeeded = columns.indexOf('SuccessfulCall(P)');
  const failed = columns.indexOf('FailedCall(P)');
  if (at < 0 || succeeded < 0 || failed < 0) return [];
  return rows.flatMap((row) => {
    const fields = row.split(';');
    const epoch = /(\d{9,}\.\d+)\s*$/.exec(fields[at] ?? '')?.[1];
    if (epoch === undefined) return [];
    return [
      {
        at: Math.round(Number(epoch) * 1000),
        succeeded: Number(fields[succeeded] ?? 0),
        failed: Number(fields[failed] ?? 0),
      },
    ];
  });
}

/**
 * The longest time without a successfully completed call across `killedAt` (seconds, less the
 * load's own second between calls), and the calls that failed from then until `until`.
 */
export function impact(
  seconds: readonly LoadSecond[],
  killedAt: number,
  until: number,
): { readonly outageSeconds: number; readonly failed: number; readonly succeeded: number } {
  const window = seconds.filter((second) => second.at >= killedAt - 2_000 && second.at <= until);
  const successes = window.filter((second) => second.succeeded > 0).map((second) => second.at);
  let longest = 0;
  let previous = successes.filter((at) => at <= killedAt).at(-1) ?? killedAt;
  for (const at of successes.filter((at) => at > killedAt)) {
    longest = Math.max(longest, at - previous);
    previous = at;
  }
  if (successes.every((at) => at <= killedAt)) longest = until - previous;
  return {
    outageSeconds: Math.max(0, longest / 1000 - 1),
    failed: window
      .filter((second) => second.at >= killedAt)
      .reduce((sum, second) => sum + second.failed, 0),
    succeeded: window
      .filter((second) => second.at >= killedAt)
      .reduce((sum, second) => sum + second.succeeded, 0),
  };
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

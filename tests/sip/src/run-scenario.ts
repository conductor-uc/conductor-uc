/**
 * S1-14: spawns `ctaloi/sipp` (3.5.1) containers against the real compose
 * stack and reports pass/fail, for `test/scenarios.test.ts`. Everything
 * here reflects hard-won, live-verified quirks of that image/version — see
 * each function's own comment before "simplifying" it.
 *
 * A `docker run ...` invoked from the *host* shell still joins the compose
 * network fine (Docker resolves the network by name regardless of where the
 * CLI command itself runs) — only a *host-side* HTTP/DB call would hit
 * org-service's deliberately-unpublished port (`seedFixtures` below routes
 * around that by running `seed.js` inside a container on the network too,
 * not by calling it in-process).
 */
import { execFile } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TESTS_SIP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(TESTS_SIP_DIR, '../..');
const SCENARIOS_DIR = path.resolve(TESTS_SIP_DIR, 'scenarios');

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export interface SipTestEnv {
  readonly network: string;
  readonly opensipsContainer: string;
  readonly opensipsTarget: string;
  readonly sippImage: string;
}

/** Same variable names/defaults `infra/compose/.env(.example)` itself uses. */
export function sipTestEnv(): SipTestEnv {
  return {
    network: envOr('SIP_TEST_NETWORK', 'conductor-uc_default'),
    opensipsContainer: envOr('SIP_TEST_OPENSIPS_CONTAINER', 'conductor-uc-opensips-1'),
    // The compose *service* name, not the container name — resolvable from
    // any container on the network regardless of compose project prefix.
    opensipsTarget: envOr('SIP_TEST_OPENSIPS_TARGET', 'opensips:5060'),
    sippImage: envOr('SIP_TEST_SIPP_IMAGE', 'ctaloi/sipp'),
  };
}

/** Set to `1` in the `sip-smoke` CI job so a missing compose stack fails the
 * run instead of skipping it — same pattern as `@cuc/testing`'s
 * `REQUIRE_DB_TESTS` (`packages/testing/src/mariadb.ts`). The main `check`
 * job deliberately does *not* set this: it has no compose stack (only
 * MariaDB/Redis service containers), and turbo's `--affected` picks up
 * `@cuc/tests-sip` whenever these files change, so this suite must skip
 * cleanly there rather than fail — confirmed directly, it did fail there
 * first (`docker: network conductor-uc_default not found`) before this
 * check existed. */
export const REQUIRE_SIP_ENV = 'REQUIRE_SIP_TESTS';

function sipTestsRequired(): boolean {
  return process.env[REQUIRE_SIP_ENV] === '1';
}

/**
 * The reason the SIP scenario suite cannot run here, or `undefined` when it
 * can — pass to `describe.skipIf` in `test/scenarios.test.ts`:
 * ```ts
 * const skipReason = await sipInfraOrSkipReason();
 * describe.skipIf(skipReason !== undefined)('S1-14 SIP scenarios', () => { ... });
 * ```
 */
export async function sipInfraOrSkipReason(): Promise<string | undefined> {
  const env = sipTestEnv();
  try {
    await execFileAsync('docker', ['network', 'inspect', env.network], { timeout: 5_000 });
    return undefined;
  } catch {
    const reason = `the "${env.network}" Docker network is not reachable (the compose stack, "infra/compose", must be up)`;
    if (sipTestsRequired()) {
      throw new Error(`${REQUIRE_SIP_ENV} is set, but ${reason}.`);
    }
    return reason;
  }
}

export interface SeedExtension {
  readonly password: string;
  readonly realm: string;
}

export interface SeedResult {
  readonly resellerId: string;
  readonly tenantA: { readonly id: string; readonly fqdn: string };
  readonly tenantB: { readonly id: string; readonly fqdn: string };
  readonly tenantSuspended: { readonly id: string; readonly fqdn: string };
  readonly extensions: Record<string, SeedExtension>;
}

/**
 * Runs `tests/sip/dist/src/seed.js` (must be built first — `pnpm build`)
 * inside a throwaway `node:22` container on the compose network, since
 * `seed.ts` itself calls org-service over HTTP and org-service has no
 * published host port by design (S1-14: "the first Node service to
 * actually run in this stack", deliberately unreachable from outside the
 * network). Idempotent — safe to call from every test file's `beforeAll`.
 */
export async function seedFixtures(): Promise<SeedResult> {
  const env = sipTestEnv();
  const dbHost = envOr('SIP_TEST_DB_HOST', 'mariadb');
  const dbPort = envOr('SIP_TEST_DB_PORT', '3306');
  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      env.network,
      '-v',
      `${REPO_ROOT}:/repo`,
      '-w',
      '/repo/tests/sip',
      '-e',
      `ORG_DB_HOST=${dbHost}`,
      '-e',
      `ORG_DB_PORT=${dbPort}`,
      '-e',
      'ORG_DB_USER=org_service',
      '-e',
      `ORG_DB_PASSWORD=${envOr('ORG_SERVICE_DB_PASSWORD', 'dev-org-password')}`,
      '-e',
      'ORG_DB_NAME=org_service',
      '-e',
      `PBX_DB_HOST=${dbHost}`,
      '-e',
      `PBX_DB_PORT=${dbPort}`,
      '-e',
      'PBX_DB_USER=pbx_config_service',
      '-e',
      `PBX_DB_PASSWORD=${envOr('PBX_CONFIG_SERVICE_DB_PASSWORD', 'dev-pbx-config-password')}`,
      '-e',
      'PBX_DB_NAME=pbx_config_service',
      '-e',
      'ORG_SERVICE_URL=http://org-service:8080',
      '-e',
      `INTERNAL_SERVICE_TOKEN=${envOr('INTERNAL_SERVICE_TOKEN', 'dev-internal-service-token')}`,
      '-e',
      `CRYPTO_KEKS=${envOr('CRYPTO_KEKS', '1:u4SpMlDTAL6cVMC2rzCxhoKCRAJxpgoc7h+hX3OfdfY=')}`,
      '-e',
      'CRYPTO_KEK_CURRENT=1',
      '-e',
      `PLATFORM_BASE_DOMAIN=${envOr('PLATFORM_BASE_DOMAIN', 'platform.test')}`,
      'node:22',
      'node',
      'dist/src/seed.js',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  // seed.ts's own `if (import.meta.url === ...)` block prints one final
  // pretty-printed JSON object after all its (expected, idempotent) pino
  // "already exists" log lines — the JSON is the last `{...}` in stdout.
  const start = stdout.lastIndexOf('\n{');
  const jsonText = start === -1 ? stdout : stdout.slice(start + 1);
  return JSON.parse(jsonText) as SeedResult;
}

/** `docker exec`s the real MI command — see `project_s1_14_checkpoint.md`:
 * `usrloc`/`subscriber` are DB-persisted, so a stale registration from a
 * prior run (same AOR) can make a fresh REGISTER fail with "Invalid CSeq
 * number". Call this before registering an AOR a test is about to use. */
export async function clearRegistration(aor: string): Promise<void> {
  const env = sipTestEnv();
  await execFileAsync('docker', [
    'exec',
    env.opensipsContainer,
    'opensips-cli',
    '-o',
    'communication_type=http',
    '-o',
    'url=http://127.0.0.1:8888/mi',
    '-x',
    'mi',
    'ul_rm',
    'location',
    aor,
  ]);
}

export interface SippStats {
  readonly successfulCalls: number;
  readonly failedCalls: number;
  readonly exitCode: number;
  readonly stdout: string;
}

/** The *last* "Successful call"/"Failed call" pair in stdout is the final
 * Statistics Screen SIPp prints on exit — earlier occurrences are periodic
 * screen refreshes mid-run and would under-count a call still in flight. */
function parseSippStats(stdout: string, exitCode: number): SippStats {
  const successMatches = [...stdout.matchAll(/Successful call\s*\|\s*\d+\s*\|\s*(\d+)/g)];
  const failMatches = [...stdout.matchAll(/Failed call\s*\|\s*\d+\s*\|\s*(\d+)/g)];
  const successfulCalls = successMatches.length > 0 ? Number(successMatches.at(-1)![1]) : 0;
  const failedCalls = failMatches.length > 0 ? Number(failMatches.at(-1)![1]) : 0;
  return { successfulCalls, failedCalls, exitCode, stdout };
}

async function withCsv<T>(line: string, fn: (hostCsvDir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(path.join(tmpdir(), 'sip-test-'));
  try {
    await writeFile(path.join(dir, 'fields.csv'), `SEQUENTIAL\n${line}\n`);
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export interface RunForegroundOptions {
  readonly scenario: string;
  readonly csvLine: string;
  readonly au?: string;
  readonly ap?: string;
  readonly authUri?: string;
  /** Never pass `''` here — see `uac_call.xml`'s own doc comment: an empty
   * `[extraheader]` expansion leaves a blank line that ends the SIP header
   * section early (RFC 3261) and corrupts the message. */
  readonly extraHeader?: string;
  readonly containerName: string;
}

/** Runs one SIPp scenario to completion in the foreground (`docker run
 * --rm`, no `-d`) — for a scenario that sends the first message itself
 * (the caller role, or a standalone REGISTER). For the UAS role, use
 * `startUas` instead (see its own comment for why). */
export async function runForeground(opts: RunForegroundOptions): Promise<SippStats> {
  const env = sipTestEnv();
  // Same defensive cleanup as `startUas` — a killed (not just failed)
  // prior run can leave a same-named container behind despite `--rm`.
  await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
  return withCsv(opts.csvLine, async (hostCsvDir) => {
    const args = [
      'run',
      '--rm',
      '--name',
      opts.containerName,
      '--network',
      env.network,
      '--entrypoint',
      'sh',
      '-w',
      '/data',
      '-v',
      `${SCENARIOS_DIR}:/scenarios:ro`,
      '-v',
      `${hostCsvDir}:/data`,
      env.sippImage,
      '-c',
      buildSippCommand({
        scenarioPath: `/scenarios/${opts.scenario}`,
        csvPath: '/data/fields.csv',
        au: opts.au,
        ap: opts.ap,
        authUri: opts.authUri,
        extraHeader: opts.extraHeader,
        remoteHost: env.opensipsTarget,
      }),
    ];
    const result = await execFileAsync('docker', args, {
      maxBuffer: 16 * 1024 * 1024,
    }).catch((error: NodeJS.ErrnoException & { stdout?: string; code?: number }) => ({
      stdout: error.stdout ?? '',
      code: typeof error.code === 'number' ? error.code : 1,
    }));
    const stdout = 'stdout' in result ? result.stdout : '';
    const exitCode = 'code' in result && typeof result.code === 'number' ? result.code : 0;
    return parseSippStats(stdout, exitCode);
  });
}

function buildSippCommand(opts: {
  scenarioPath: string;
  csvPath: string;
  au?: string | undefined;
  ap?: string | undefined;
  authUri?: string | undefined;
  extraHeader?: string | undefined;
  localPort?: number | undefined;
  remoteHost?: string | undefined;
  logPrefix?: string | undefined;
}): string {
  const parts = [
    'sipp',
    '-sf',
    opts.scenarioPath,
    '-inf',
    opts.csvPath,
    '-i',
    '$(hostname -i)',
    '-m',
    '1',
  ];
  if (opts.au !== undefined) parts.push('-au', opts.au);
  if (opts.ap !== undefined) parts.push('-ap', opts.ap);
  if (opts.authUri !== undefined) parts.push('-auth_uri', opts.authUri);
  // Fix 5 (checkpoint memory): default to a harmless real header, never ''.
  parts.push('-key', 'extraheader', `"${opts.extraHeader ?? 'X-Sip-Test: 1'}"`);
  if (opts.localPort !== undefined) parts.push('-p', String(opts.localPort));
  const prefix = opts.logPrefix ?? 'run';
  parts.push(
    '-message_file',
    `/data/${prefix}_messages.log`,
    '-error_file',
    `/data/${prefix}_errors.log`,
  );
  if (opts.remoteHost !== undefined) parts.push(opts.remoteHost);
  return parts.join(' ');
}

export interface UasHandle {
  readonly containerName: string;
  /** Resolves once the UAS has finished registering and is actively
   * waiting for the INVITE (the `answer_call.xml` half is live). */
  ready(): Promise<void>;
  /** Resolves once the UAS has answered and completed (or timed out on) a
   * call. Call after driving the caller side. */
  result(): Promise<SippStats>;
  /** Force-stops the container and its temp CSV dir — call this for a UAS
   * that's expected to stay idle (e.g. the "wrong tenant" UAS in the
   * isolation/spoofed-header scenarios) once the test is done with it. */
  stop(): Promise<void>;
}

export interface StartUasOptions {
  readonly au: string;
  readonly ap: string;
  readonly authUri: string;
  readonly csvLine: string;
  readonly containerName: string;
  readonly localPort?: number;
}

/**
 * Starts the UAS role as **two sequential SIPp processes in one background
 * container** (`register.xml` then `answer_call.xml`, `sh -c "sipp ... &&
 * sipp ..."`), bound to the same local port throughout — not one combined
 * "register, then wait for INVITE" scenario. That single-process form hits
 * an unresolved upstream SIPp 3.5.1 bug (SIPp/sipp#412): a process that did
 * REGISTER first discards the real, later, unsolicited INVITE as "can't be
 * mapped to a known SIPp call". A fresh second process whose only
 * transaction is receiving the INVITE (the standard "pure UAS" pattern)
 * does not hit it. See `answer_call.xml`'s own doc comment.
 */
export function startUas(opts: StartUasOptions): UasHandle {
  const env = sipTestEnv();
  let hostCsvDir: string | undefined;
  const ready = (async (): Promise<void> => {
    hostCsvDir = await mkdtemp(path.join(tmpdir(), 'sip-test-'));
    await writeFile(path.join(hostCsvDir, 'fields.csv'), `SEQUENTIAL\n${opts.csvLine}\n`);
    const registerCmd = buildSippCommand({
      scenarioPath: '/scenarios/register.xml',
      csvPath: '/data/fields.csv',
      au: opts.au,
      ap: opts.ap,
      authUri: opts.authUri,
      localPort: opts.localPort ?? 6000,
      remoteHost: env.opensipsTarget,
      logPrefix: 'uas_reg',
    });
    const answerCmd = buildSippCommand({
      scenarioPath: '/scenarios/answer_call.xml',
      csvPath: '/data/fields.csv',
      localPort: opts.localPort ?? 6000,
      logPrefix: 'uas_ans',
    });
    // A container from a prior run that exited naturally is never removed
    // by `docker run -d` alone (unlike `--rm` in the foreground case) —
    // confirmed directly this makes the next same-named `docker run -d`
    // fail with "Conflict. The container name ... is already in use".
    // Defensive even under normal operation (a crashed prior run, a killed
    // CI job) — `afterEach` cleanup only covers the common case.
    await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
    // Not `--rm`: `result()` below reads the container's final stats via
    // `docker logs` *after* it exits — auto-removal would delete those
    // logs out from under it. `stop()` and the pre-start `rm -f` above are
    // what actually clean these up.
    await execFileAsync('docker', [
      'run',
      '-d',
      '--name',
      opts.containerName,
      '--network',
      env.network,
      '--entrypoint',
      'sh',
      '-w',
      '/data',
      '-v',
      `${SCENARIOS_DIR}:/scenarios:ro`,
      '-v',
      `${hostCsvDir}:/data`,
      env.sippImage,
      '-c',
      `${registerCmd} && ${answerCmd}`,
    ]);
    await waitForLog(opts.containerName, 'Sipp Server Mode', 10_000);
  })();

  return {
    containerName: opts.containerName,
    ready: () => ready,
    result: async () => {
      await ready;
      await waitForContainerExit(opts.containerName, 20_000);
      const { stdout } = await execFileAsync('docker', ['logs', opts.containerName], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseSippStats(stdout, 0);
    },
    stop: async () => {
      await ready.catch(() => undefined);
      await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
      if (hostCsvDir !== undefined) await rm(hostCsvDir, { recursive: true, force: true });
    },
  };
}

async function waitForLog(containerName: string, needle: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await execFileAsync('docker', ['logs', containerName], {
      maxBuffer: 16 * 1024 * 1024,
    }).catch(() => ({ stdout: '' }));
    if (stdout.includes(needle)) return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for "${needle}" in ${containerName}'s logs`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

async function waitForContainerExit(containerName: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      containerName,
      '--format',
      '{{.State.Status}}',
    ]).catch(() => ({ stdout: 'unknown' }));
    if (stdout.trim() === 'exited') return;
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${containerName} to exit`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/** Force-removes any leftover named container — call in `afterEach` so one
 * failed test's container doesn't collide with the next test's `docker run
 * --name`. */
export async function stopContainer(containerName: string): Promise<void> {
  await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined);
}

/**
 * Point-in-time check for a `startUas` container that's expected to stay
 * idle (the "wrong tenant"/isolation-losing UAS): true once it has ever
 * accepted an INVITE. Does **not** wait for the container to exit — an
 * idle UAS by definition never will (it's still parked in
 * `answer_call.xml`'s own `<recv request="INVITE">`), so waiting would
 * just be a guaranteed timeout on every passing isolation test.
 */
export async function uasReceivedCall(containerName: string): Promise<boolean> {
  const { stdout } = await execFileAsync('docker', ['logs', containerName], {
    maxBuffer: 16 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const matches = [...stdout.matchAll(/Incoming call created\s*\|\s*\d+\s*\|\s*(\d+)/g)];
  const last = matches.at(-1);
  return last !== undefined && Number(last[1]) > 0;
}

export interface UasScenarioHandle {
  /** Resolves once the container is up and the scenario is listening ("Sipp Server Mode" in its logs). */
  ready(): Promise<void>;
  /** Force-stops the container. */
  stop(): Promise<void>;
}

/**
 * S2-02: a single, persistent SIPp UAS running one scenario in the
 * background — for a scenario like `carrier_registrar.xml` that never
 * itself sends the first message and is not part of the register/answer
 * two-step pattern `startUas` exists for. Not `-m 1`/short-lived: SIPp's
 * own idle-timeout default would let the container exit before a slow,
 * timer-driven caller (`uac_registrant`'s own periodic REGISTER cycle)
 * ever reaches it — confirmed live, an early attempt at this exact scenario
 * exited (code 99, "no traffic") seconds before OpenSIPs' own registration
 * timer fired. No `-m` (unlimited calls — `-m 0` means the opposite, see
 * below) plus a long `-timeout` keep the process alive for the whole test
 * regardless of how long the real timer takes.
 */
export function startBackgroundUas(
  scenario: string,
  containerName: string,
  port: number,
): UasScenarioHandle {
  const env = sipTestEnv();
  const ready = (async (): Promise<void> => {
    await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined);
    await execFileAsync('docker', [
      'run',
      '-d',
      '--name',
      containerName,
      '--network',
      env.network,
      '-v',
      `${SCENARIOS_DIR}:/scenarios:ro`,
      env.sippImage,
      '-sf',
      `/scenarios/${scenario}`,
      '-p',
      String(port),
      // No `-m`: SIPp's call-limit flag, not a "run forever" one — `-m 0`
      // means "0 calls allowed" and exits immediately (confirmed live,
      // "Call limit reached (-m 0)" in its own log). Omitting it entirely
      // is what actually means unlimited.
      '-timeout',
      '180s',
      '-i',
      '0.0.0.0',
    ]);
    await waitForLog(containerName, 'Sipp Server Mode', 10_000);
  })();

  return {
    ready: () => ready,
    stop: async () => {
      await ready.catch(() => undefined);
      await execFileAsync('docker', ['rm', '-f', containerName]).catch(() => undefined);
    },
  };
}

export interface DelayedCallerHandle {
  readonly containerName: string;
  /** The container's own IP on the compose network — what a trunk's `ips` CIDR must whitelist to be recognized as this "carrier". */
  readonly ip: string;
  /** Resolves once the container (and the scenario's own leading pause + INVITE exchange) has finished. */
  result(): Promise<SippStats>;
  stop(): Promise<void>;
}

/**
 * S2-03: starts a *caller*-role SIPp scenario (an unregistered "trunk"
 * sending an unsolicited INVITE — `trunk_invite*.xml`'s own doc comments)
 * detached (`-d`), so this function can read back the container's real
 * compose-network IP (`docker inspect`) before the scenario's first message
 * ever goes out. Every `trunk_invite*.xml` scenario starts with a
 * `<pause milliseconds="…">` for exactly this reason: it gives the caller
 * (provision a trunk/DID whitelisting this IP, wait for telephony-config's
 * event-driven projection) a real window to run *after* the IP is known but
 * *before* the INVITE that depends on it fires. `runForeground`'s "bind to
 * `$(hostname -i)`" trick alone cannot do this — that command only resolves
 * inside the already-started container, is inlined into the same shell
 * invocation that immediately sends traffic, and is never visible to the
 * host process launching it.
 */
export async function startDelayedCaller(opts: {
  readonly scenario: string;
  readonly csvLine: string;
  readonly containerName: string;
}): Promise<DelayedCallerHandle> {
  const env = sipTestEnv();
  await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
  const hostCsvDir = await mkdtemp(path.join(tmpdir(), 'sip-test-'));
  await writeFile(path.join(hostCsvDir, 'fields.csv'), `SEQUENTIAL\n${opts.csvLine}\n`);

  await execFileAsync('docker', [
    'run',
    '-d',
    '--name',
    opts.containerName,
    '--network',
    env.network,
    '--entrypoint',
    'sh',
    '-w',
    '/data',
    '-v',
    `${SCENARIOS_DIR}:/scenarios:ro`,
    '-v',
    `${hostCsvDir}:/data`,
    env.sippImage,
    '-c',
    buildSippCommand({
      scenarioPath: `/scenarios/${opts.scenario}`,
      csvPath: '/data/fields.csv',
      remoteHost: env.opensipsTarget,
      logPrefix: 'delayed',
    }),
  ]);

  const { stdout } = await execFileAsync('docker', [
    'inspect',
    opts.containerName,
    '--format',
    `{{ (index .NetworkSettings.Networks "${env.network}").IPAddress }}`,
  ]);
  const ip = stdout.trim();
  if (ip === '')
    throw new Error(`could not determine ${opts.containerName}'s IP on ${env.network}`);

  return {
    containerName: opts.containerName,
    ip,
    result: async () => {
      await waitForContainerExit(opts.containerName, 30_000);
      const { stdout: logs } = await execFileAsync('docker', ['logs', opts.containerName], {
        maxBuffer: 16 * 1024 * 1024,
      });
      return parseSippStats(logs, 0);
    },
    stop: async () => {
      await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
      await rm(hostCsvDir, { recursive: true, force: true });
    },
  };
}

/**
 * Runs a JSON HTTP request against a service reachable only on the compose
 * network (trunk-service, telephony-config — deliberately unpublished, the
 * same reasoning `seedFixtures`'s own comment gives for org-service) from a
 * throwaway `curlimages/curl` container, since a host-side `fetch` cannot
 * reach it. `-w` appends the HTTP status code after a literal newline,
 * parsed back out below.
 */
export async function dockerCurlJson(
  method: 'GET' | 'POST' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const env = sipTestEnv();
  const args = [
    'run',
    '--rm',
    '--network',
    env.network,
    'curlimages/curl:latest',
    '-s',
    '-X',
    method,
    url,
    '-w',
    '\n%{http_code}',
  ];
  if (body !== undefined) {
    args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  }
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  const lastNewline = stdout.lastIndexOf('\n');
  const bodyText = stdout.slice(0, lastNewline);
  const status = Number(stdout.slice(lastNewline + 1).trim());
  return { status, json: bodyText === '' ? undefined : (JSON.parse(bodyText) as unknown) };
}

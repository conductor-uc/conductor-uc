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
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

import { signInternalHeaders } from '@cuc/http';

const execFileAsync = promisify(execFile);

const SRC_DIR = path.dirname(fileURLToPath(import.meta.url));
const TESTS_SIP_DIR = path.resolve(SRC_DIR, '..');
const REPO_ROOT = path.resolve(TESTS_SIP_DIR, '../..');
const SCENARIOS_DIR = path.resolve(TESTS_SIP_DIR, 'scenarios');

/**
 * How long `waitForLog` waits for a background SIPp server container to
 * print "Sipp Server Mode" before giving up, and how long `waitForContainerExit`
 * waits for one to actually exit. Both were 10s/20s through S2-05 — widened
 * once (S2-06) after three consecutive PR #128 CI runs each hit one or the
 * other timing out in a *different*, unrelated, pre-existing test file
 * (never the same file twice, and never anything touching application
 * logic): `docker run -d`/`docker inspect` occasionally taking longer than
 * that under this CI runner's own load is apparently a real, if infrequent,
 * condition on its own, not something any one task's test can fix by being
 * lighter-weight. See docs/decisions.md G-34.
 *
 * `CONTAINER_EXIT_TIMEOUT_MS` widened again 2026-09-22: `sip-test-happy-uas`
 * (`scenarios.test.ts`'s own "completes a real call end to end") failed
 * this exact wait four consecutive times on the self-hosted runner, every
 * time with the identical signature — a departure from G-34's original
 * "never the same file twice" pattern, so this was checked rather than
 * assumed to be the same flake class. Reproduced the *entire* suite
 * locally, same order, same code, against a real compose stack: 13/13
 * passed cleanly in under 90s total. That rules out application logic and
 * this harness's own scenario/assertion code — whatever is different is
 * specific to the self-hosted runner's own environment for this one
 * container's shutdown, not visible in `docker compose logs` (a standalone
 * `docker run`, not a compose service) and not reproducible off that
 * machine. A mechanical widening only, same as G-34's own remediation,
 * not a root-cause fix for whatever makes this one container slow to exit
 * there specifically.
 */
const CONTAINER_LOG_TIMEOUT_MS = 45_000;
const CONTAINER_EXIT_TIMEOUT_MS = 90_000;
/** Same reasoning, for `startDelayedCaller`'s own `docker inspect` IP-lookup retry (200ms apiece) — 10 attempts (~2s) through S2-05, widened alongside the two above. */
const CONTAINER_IP_LOOKUP_ATTEMPTS = 25;

function envOr(name: string, fallback: string): string {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
}

export interface SipTestEnv {
  readonly network: string;
  readonly opensipsContainer: string;
  readonly opensipsTarget: string;
  readonly sippImage: string;
  readonly freeswitchContainer: string;
  /**
   * S2-19: every FS node in the dev stack, not just the first —
   * `fsCliAll`'s own list. `media_playback.test.ts`'s direct ESL
   * `originate` still deliberately targets one specific node
   * (`freeswitchContainer` above), since it bypasses the dispatcher
   * entirely; this list is for the setup hooks that must not miss
   * whichever node a round-robin-dispatched call actually landed on.
   */
  readonly freeswitchContainers: readonly string[];
  readonly eventSocketPassword: string;
}

/** Same variable names/defaults `infra/compose/.env(.example)` itself uses. */
export function sipTestEnv(): SipTestEnv {
  const freeswitchContainer = envOr('SIP_TEST_FREESWITCH_CONTAINER', 'conductor-uc-freeswitch-1');
  return {
    network: envOr('SIP_TEST_NETWORK', 'conductor-uc_default'),
    opensipsContainer: envOr('SIP_TEST_OPENSIPS_CONTAINER', 'conductor-uc-opensips-1'),
    // The compose *service* name, not the container name — resolvable from
    // any container on the network regardless of compose project prefix.
    opensipsTarget: envOr('SIP_TEST_OPENSIPS_TARGET', 'opensips:5060'),
    sippImage: envOr('SIP_TEST_SIPP_IMAGE', 'ctaloi/sipp'),
    freeswitchContainer,
    freeswitchContainers: envOr(
      'SIP_TEST_FREESWITCH_CONTAINERS',
      `${freeswitchContainer},${envOr('SIP_TEST_FREESWITCH_2_CONTAINER', 'conductor-uc-freeswitch-2-1')}`,
    )
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name !== ''),
    // Matches `FS_EVENT_SOCKET_PASSWORD`'s own default in
    // infra/compose/docker-compose.yml's `freeswitch`/`call-control`
    // service blocks.
    eventSocketPassword: envOr('FS_EVENT_SOCKET_PASSWORD', 'dev-event-socket-password'),
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
  readonly tenantOutbound: { readonly id: string; readonly fqdn: string };
  readonly tenantFraud: { readonly id: string; readonly fqdn: string };
  readonly tenantEmergency: { readonly id: string; readonly fqdn: string };
  readonly tenantConference: { readonly id: string; readonly fqdn: string };
  readonly tenantQueue: { readonly id: string; readonly fqdn: string };
  readonly tenantVoicemail: { readonly id: string; readonly fqdn: string };
  readonly tenantFlow: { readonly id: string; readonly fqdn: string };
  readonly tenantPresence: { readonly id: string; readonly fqdn: string };
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

/**
 * S2-05: sets a tenant's `orgs.limits` (`seed.ts`'s own `setLimits`) —
 * the one piece of mutable per-test fixture state a toll-fraud-control
 * test needs to change between cases. Same throwaway-container rationale
 * as `seedFixtures` (org-service has no published host port).
 */
export async function setTenantLimits(
  tenantId: string,
  limits: Record<string, unknown>,
): Promise<void> {
  const env = sipTestEnv();
  const dbHost = envOr('SIP_TEST_DB_HOST', 'mariadb');
  const dbPort = envOr('SIP_TEST_DB_PORT', '3306');
  await execFileAsync(
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
      `PLATFORM_BASE_DOMAIN=${envOr('PLATFORM_BASE_DOMAIN', 'platform.test')}`,
      'node:22',
      'node',
      'dist/src/seed.js',
      'set-limits',
      tenantId,
      JSON.stringify(limits),
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
}

/**
 * Resets an extension's SIP password (`seed.ts`'s own `resetExtensionPassword`)
 * and returns the new one. The same throwaway-container rationale as
 * `seedFixtures`: the databases have no published host port.
 */
export async function resetExtensionPassword(
  tenantId: string,
  number: string,
): Promise<{ password: string; realm: string }> {
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
      'node:22',
      'node',
      'dist/src/seed.js',
      'reset-password',
      tenantId,
      number,
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const start = stdout.lastIndexOf('\n{');
  return JSON.parse(start === -1 ? stdout : stdout.slice(start + 1)) as {
    password: string;
    realm: string;
  };
}

const tenantAdmins = new Map<string, string>();

/**
 * Signed request-context headers for a real `tenant_admin` of `tenantId`
 * (`seed.ts`'s `ensureTenantAdmin`), as api-gateway would send them. Every
 * user-facing service checks what the signed-in person holds (07 §3.1), so an
 * administrator's call has to name a person identity-service knows. The
 * person is created once per tenant and reused.
 */
export async function tenantAdminHeaders(
  tenantId: string,
  resellerId: string,
): Promise<Record<string, string>> {
  let userId = tenantAdmins.get(tenantId);
  if (userId === undefined) {
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
        `IDENTITY_DB_HOST=${dbHost}`,
        '-e',
        `IDENTITY_DB_PORT=${dbPort}`,
        '-e',
        'IDENTITY_DB_USER=identity_service',
        '-e',
        `IDENTITY_DB_PASSWORD=${envOr('IDENTITY_SERVICE_DB_PASSWORD', 'dev-identity-password')}`,
        '-e',
        'IDENTITY_DB_NAME=identity_service',
        'node:22',
        'node',
        'dist/src/seed.js',
        'tenant-admin',
        tenantId,
        resellerId,
      ],
      { maxBuffer: 16 * 1024 * 1024 },
    );
    const start = stdout.lastIndexOf('\n{');
    userId = (JSON.parse(start === -1 ? stdout : stdout.slice(start + 1)) as { userId: string })
      .userId;
    tenantAdmins.set(tenantId, userId);
  }
  return signInternalHeaders(
    process.env['INTERNAL_HEADER_SIGNING_SECRET'] ?? 'dev-internal-header-signing-secret',
    {
      actorId: userId,
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      resellerId,
      tenantId,
    },
  );
}

/**
 * {@link dockerCurlJson} as the administrator of the tenant the
 * `/v1/tenants/{tenantId}/…` URL names ({@link tenantAdminHeaders}). A service
 * refuses a protected route to a caller with no identity (G-112), so every
 * administrative call a test makes is signed as a real person, the way
 * api-gateway would send it. The headers are signed afresh for each call: a
 * signature is only good for a minute.
 */
export async function tenantAdminCurlJson(
  resellerId: string,
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
): Promise<{ status: number; json: unknown }> {
  const tenantId = /^\/v1\/tenants\/([^/]+)\//.exec(new URL(url).pathname)?.[1];
  if (tenantId === undefined) throw new Error(`not a tenant route: ${url}`);
  return dockerCurlJson(method, url, body, await tenantAdminHeaders(tenantId, resellerId));
}

/**
 * `Authorization` for a call that is not one tenant's, or that needs more than
 * a tenant administrator holds: the shared internal service token, which a
 * service accepts as a trusted machine caller (G-112).
 */
export function internalServiceHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${envOr('INTERNAL_SERVICE_TOKEN', 'dev-internal-service-token')}`,
  };
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

/** `docker exec`s a real MI command — the same `opensips-cli -x mi` shape {@link clearRegistration} already establishes. */
async function opensipsMi(command: string, ...args: readonly string[]): Promise<void> {
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
    command,
    ...args,
  ]);
}

/** The compose stack's MariaDB container, named like the others so a stack under another project name works too. */
function mariadbContainer(): string {
  return envOr('SIP_TEST_MARIADB_CONTAINER', 'conductor-uc-mariadb-1');
}

/** `docker exec`s the real `mariadb` client against the `opensips` schema, as the `opensips` DB user — same rationale as `opensipsMi`: a real CLI already inside an already-running container, not a new throwaway one. */
async function opensipsSql(sql: string): Promise<void> {
  await execFileAsync('docker', [
    'exec',
    mariadbContainer(),
    'mariadb',
    '-u',
    'opensips',
    `-p${envOr('OPENSIPS_DB_PASSWORD', 'dev-opensips-password')}`,
    'opensips',
    '-e',
    sql,
  ]);
}

/**
 * G-46 (docs/decisions.md): OpenSIPs does not yet act on `X-Affinity-Node`
 * (deferred to S4-05), so once S2-19's round-robin dispatch is real, a
 * *second*, separate call into an already-pinned queue/parking-lot/
 * conference-room can genuinely land on the node that does not hold its
 * affinity lease and get a real dialplan miss — not a test bug, an actual
 * gap this platform has today. Rather than either accept that flakiness or
 * pull S4-05 forward, S2-20's own scenarios for those three resource kinds
 * temporarily narrow dispatcher set 1 down to one destination (direct SQL
 * against the `dispatcher` table, then `ds_reload` — the same table
 * `telephony/opensips/seed-dispatcher.py` seeds, so this is exercising a
 * real, already-proven mechanism, not a new one) so every call in the test
 * lands on the same node, restoring the full pool afterward. This tests
 * "the resource itself works," which is what these scenarios exist to
 * prove — it does not test "and it survives round-robin," which is exactly
 * G-46's own open gap.
 */
export async function withSingleFsNode<T>(fn: () => Promise<T>): Promise<T> {
  await opensipsSql(
    "DELETE FROM dispatcher WHERE setid = 1 AND destination != 'sip:freeswitch:5060'",
  );
  await opensipsMi('ds_reload');
  try {
    return await fn();
  } finally {
    await opensipsSql(
      'INSERT IGNORE INTO dispatcher (setid, destination, state, weight, description) ' +
        "VALUES (1, 'sip:freeswitch-2:5060', 0, '1', 'S2-20 withSingleFsNode: restored')",
    );
    await opensipsMi('ds_reload');
  }
}

/**
 * `docker exec`s a real `fs_cli -x` command against the FreeSWITCH
 * container — the same "verify the raw capability directly, not through
 * the full routing stack yet" precedent G-19 (docs/decisions.md) already
 * established for this exact CLI, back when no dialplan wiring existed for
 * an outbound call either. S2-07's own media-asset playback has the same
 * shape: no callflow/IVR feature exists yet to trigger it through a real
 * call flow (S2-10's own future job, per the plan's dependency graph), so
 * this is how its own acceptance test exercises FS's `http_cache://`
 * resolution directly instead.
 *
 * `fs_cli` with no `-H`/`-P`/`-p` falls back to its own compiled-in
 * defaults (127.0.0.1:8021, password "ClueCon") when no `fs_cli.conf`
 * exists in the image — none does here, and this stack's event socket
 * password is `FS_EVENT_SOCKET_PASSWORD` (event_socket.conf.xml), not
 * "ClueCon". Confirmed live: bare `fs_cli -x status` fails with
 * `Error Connecting`; the same command with explicit `-H 127.0.0.1 -P 8021
 * -p <the real password>` connects fine — the ACL (acl.conf.xml's
 * `cluster` list) already allows loopback, so this was never a network/ACL
 * problem, just fs_cli never being told the right password.
 */
export async function fsCliOn(container: string, command: string): Promise<string> {
  const env = sipTestEnv();
  const { stdout } = await execFileAsync('docker', [
    'exec',
    container,
    'fs_cli',
    '-H',
    '127.0.0.1',
    '-P',
    '8021',
    '-p',
    env.eventSocketPassword,
    '-x',
    command,
  ]);
  return stdout;
}

export async function fsCli(command: string): Promise<string> {
  return fsCliOn(sipTestEnv().freeswitchContainer, command);
}

/**
 * S2-19: runs `command` on every FS node in the dev stack
 * (`freeswitchContainers`), not just the first — what `setup.ts`'s
 * `beforeEach`/`afterEach` hooks need now that round-robin dispatch means a
 * test's own channels could be on either node, not always
 * `freeswitchContainer`. Returns one labelled block per node so a failure
 * dump reads unambiguously.
 */
export async function fsCliAll(command: string): Promise<string> {
  const env = sipTestEnv();
  const results = await Promise.all(
    env.freeswitchContainers.map(async (container) => {
      try {
        return `[${container}]\n${await fsCliOn(container, command)}`;
      } catch (error) {
        return `[${container}] <unavailable: ${error instanceof Error ? error.message : String(error)}>`;
      }
    }),
  );
  return results.join('\n');
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
    // SIPp's default Call-ID is `%u-%p@%s` — call number, process number,
    // local IP. Every one of those repeats across our containers: `-m 1`
    // fixes the call number at 1, the process number inside a
    // single-purpose container is always the same (8, observed), and
    // Docker reuses IPs from its pool. Two consecutive scenarios landing
    // on the same IP therefore produce the *identical* Call-ID.
    //
    // That is not cosmetic, and it is worse than the Call-ID alone: SIPp's
    // From-tag (`tag=1`) and CSeq (`1 INVITE`) are just as deterministic,
    // so consecutive containers emit a byte-identical *dialog identity* —
    // exactly the triple RFC 3261 matches requests on. Both failure
    // symptoms seen live come from that one fact:
    //
    //   481 Call is being terminated — a previous call's BYE was still
    //   being retransmitted (awaiting its 200 through OpenSIPs) when the
    //   next scenario's INVITE arrived reusing its Call-ID, so FS matched
    //   the new INVITE to the dialog still tearing down.
    //
    //   482 Request merged — the same identity arriving while the earlier
    //   INVITE transaction was still live reads as a forked duplicate:
    //     From: <sip:101@acme.platform.test>;tag=1
    //     Call-ID: 1-8@172.18.0.18
    //     CSeq: 1 INVITE
    //
    // FreeSWITCH is right in both cases; the scenarios are the ones lying
    // about being distinct calls. Whichever test happened to run while a
    // previous call was still settling failed, which is why the failure
    // kept moving between files (docs/decisions.md G-34/G-39) and why it
    // reproduced only under repeated/loaded runs. Making the Call-ID
    // unique breaks the match for both, since both need all three fields.
    //
    // `-cid_str` takes literal text alongside its `%` specifiers, so a
    // token unique to this container makes a collision impossible
    // regardless of IP or PID reuse.
    '-cid_str',
    `%u-%p-${randomUUID().slice(0, 8)}@%s`,
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
  /** The second chained scenario, run after `register.xml` completes.
   * Defaults to `answer_call.xml` (the ordinary "answer, hold, wait for
   * BYE" UAS). A caller needing a *different* reaction to the INVITE —
   * S2-20's own `busy_call.xml` for triggering `continue_on_fail`'s
   * `USER_BUSY` case, for instance — passes its own scenario file here
   * instead, reusing this function's own register-then-listen chaining
   * rather than duplicating it. */
  readonly answerScenario?: string;
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
      scenarioPath: `/scenarios/${opts.answerScenario ?? 'answer_call.xml'}`,
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
    await waitForLog(opts.containerName, 'Sipp Server Mode', CONTAINER_LOG_TIMEOUT_MS);
  })();

  return {
    containerName: opts.containerName,
    ready: () => ready,
    result: async () => {
      await ready;
      await waitForContainerExit(opts.containerName, CONTAINER_EXIT_TIMEOUT_MS);
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

export interface StartAgentUasOptions {
  readonly au: string;
  readonly ap: string;
  readonly authUri: string;
  /** The agent's own SIP username/extension number — `[field0]` for all
   * three chained scenarios below. */
  readonly agentNumber: string;
  /** `AGENT_LOGIN_FEATURE_CODE` or `AGENT_LOGOUT_FEATURE_CODE`
   * (`services/telephony-config/src/xml.ts`). */
  readonly featureCode: string;
  readonly containerName: string;
  readonly localPort?: number;
}

/**
 * S2-20 (G-47): the agent role for a `mod_callcenter` queue scenario —
 * `startUas`'s own two-step register-then-wait-for-INVITE shape, with one
 * more step spliced in between: dialing an agent status feature code
 * (`login_feature_code.xml`) to go `Available` before the queue can ever
 * distribute a call here. All three SIPp processes (`register.xml`, the
 * feature-code dial, `answer_call.xml`) stay bound to the same local port
 * throughout, same reasoning `startUas`'s own doc comment gives for why
 * that has to be three separate processes rather than one combined
 * scenario (SIPp/sipp#412).
 */
export function startAgentUas(opts: StartAgentUasOptions): UasHandle {
  const env = sipTestEnv();
  let hostCsvDir: string | undefined;
  const ready = (async (): Promise<void> => {
    hostCsvDir = await mkdtemp(path.join(tmpdir(), 'sip-test-'));
    await writeFile(
      path.join(hostCsvDir, 'fields.csv'),
      `SEQUENTIAL\n${opts.agentNumber};${opts.authUri};${opts.featureCode}\n`,
    );
    const registerCmd = buildSippCommand({
      scenarioPath: '/scenarios/register.xml',
      csvPath: '/data/fields.csv',
      au: opts.au,
      ap: opts.ap,
      authUri: opts.authUri,
      localPort: opts.localPort ?? 6000,
      remoteHost: env.opensipsTarget,
      logPrefix: 'agent_reg',
    });
    const loginCmd = buildSippCommand({
      scenarioPath: '/scenarios/login_feature_code.xml',
      csvPath: '/data/fields.csv',
      localPort: opts.localPort ?? 6000,
      remoteHost: env.opensipsTarget,
      logPrefix: 'agent_login',
    });
    const answerCmd = buildSippCommand({
      scenarioPath: '/scenarios/answer_call.xml',
      csvPath: '/data/fields.csv',
      localPort: opts.localPort ?? 6000,
      logPrefix: 'agent_ans',
    });
    // Same defensive cleanup as `startUas` — a killed (not just failed)
    // prior run can leave a same-named container behind despite this not
    // being `--rm`.
    await execFileAsync('docker', ['rm', '-f', opts.containerName]).catch(() => undefined);
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
      `${registerCmd} && ${loginCmd} && ${answerCmd}`,
    ]);
    // Only `answer_call.xml` (the third, final process) ever prints this —
    // the first two are ordinary client-mode scenarios with a known
    // target, not a true "server mode" listener — so this correctly means
    // "registered AND logged in AND now actually waiting for the queue's
    // own distributed call", not just "the container started".
    await waitForLog(opts.containerName, 'Sipp Server Mode', CONTAINER_LOG_TIMEOUT_MS);
  })();

  return {
    containerName: opts.containerName,
    ready: () => ready,
    result: async () => {
      await ready;
      await waitForContainerExit(opts.containerName, CONTAINER_EXIT_TIMEOUT_MS);
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
 * Point-in-time check for a `startUas`/`startBackgroundUas` container that
 * may or may not have handled a call yet: true once it ever has. Does
 * **not** wait for the container to exit — an idle UAS (the "wrong
 * tenant"/isolation-losing case) by definition never will, so waiting
 * would just be a guaranteed timeout on every passing isolation test.
 *
 * Matches "Scenario Screen" 's own `Peak was N calls` line, not
 * "Statistics Screen" 's `Incoming call created | periodic | cumulative`
 * row (tried first — S2-04, confirmed live): a container that never exits
 * or is signaled to reset (every `startUas`/`startBackgroundUas` one, by
 * design) only ever prints the periodic Scenario Screen, never the
 * Statistics one, so the original pattern silently never matched *anything*
 * — always `false`, regardless of real call activity. Every existing
 * caller of this function only ever asserted `false` before this fix, so
 * the bug was invisible: a call that never happened and one whose evidence
 * this function couldn't see were indistinguishable. `Peak was` is
 * monotonic for the container's lifetime (never decreases), so this is
 * robust regardless of how many polling intervals have elapsed since.
 */
export async function uasReceivedCall(containerName: string): Promise<boolean> {
  const { stdout } = await execFileAsync('docker', ['logs', containerName], {
    maxBuffer: 16 * 1024 * 1024,
  }).catch(() => ({ stdout: '' }));
  const matches = [...stdout.matchAll(/Peak was (\d+) calls?/g)];
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
    await waitForLog(containerName, 'Sipp Server Mode', CONTAINER_LOG_TIMEOUT_MS);
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
 *
 * Also reused, as of S2-05, for the general "detached caller, read the
 * result back later" shape alone (`au`/`ap`/`authUri`, for a *registered*
 * caller like `uac_call.xml`/`uac_call_hold.xml`) — a toll-fraud
 * concurrent-channel test needs one call held open while a second is
 * attempted, which means the first cannot be started with
 * `runForeground` (blocks until it completes). The `ip` field is simply
 * unused by that caller; nothing about the detached-container mechanics
 * below is trunk-specific.
 */
export async function startDelayedCaller(opts: {
  readonly scenario: string;
  readonly csvLine: string;
  readonly containerName: string;
  readonly au?: string;
  readonly ap?: string;
  readonly authUri?: string;
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
      au: opts.au,
      ap: opts.ap,
      authUri: opts.authUri,
      remoteHost: env.opensipsTarget,
      logPrefix: 'delayed',
    }),
  ]);

  // `docker run -d` returning is not always synchronous with the network
  // attachment being visible to `docker inspect` yet — never observed
  // across this function's original `trunk_invite*.xml` callers (S2-03),
  // each of which happens to start with its own multi-second `<pause>`
  // (long enough to never race this), but a scenario with no leading
  // pause (S2-05's `uac_call_hold.xml`) can ask before it's ready. A short
  // poll is cheap and only ever taken on the rare empty-IP case.
  let ip = '';
  for (let attempt = 1; attempt <= CONTAINER_IP_LOOKUP_ATTEMPTS && ip === ''; attempt += 1) {
    const { stdout } = await execFileAsync('docker', [
      'inspect',
      opts.containerName,
      '--format',
      `{{ (index .NetworkSettings.Networks "${env.network}").IPAddress }}`,
    ]);
    ip = stdout.trim();
    if (ip === '' && attempt < CONTAINER_IP_LOOKUP_ATTEMPTS) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  if (ip === '')
    throw new Error(`could not determine ${opts.containerName}'s IP on ${env.network}`);

  return {
    containerName: opts.containerName,
    ip,
    result: async () => {
      await waitForContainerExit(opts.containerName, CONTAINER_EXIT_TIMEOUT_MS);
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
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
  headers: Readonly<Record<string, string>> = {},
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
  for (const [name, value] of Object.entries(headers)) args.push('-H', `${name}: ${value}`);
  if (body !== undefined) {
    args.push('-H', 'content-type: application/json', '-d', JSON.stringify(body));
  }
  const { stdout } = await execFileAsync('docker', args, { maxBuffer: 16 * 1024 * 1024 });
  const lastNewline = stdout.lastIndexOf('\n');
  const bodyText = stdout.slice(0, lastNewline);
  const status = Number(stdout.slice(lastNewline + 1).trim());
  return { status, json: bodyText === '' ? undefined : (JSON.parse(bodyText) as unknown) };
}

/**
 * GETs a URL from inside the compose network and returns the body as text —
 * for a presigned download address (S3-11's CDR export), whose host (`minio`,
 * `STORAGE_ENDPOINT`) only resolves there, the same reasoning
 * `dockerCurlUpload` gives for the upload direction.
 */
export async function dockerCurlText(url: string): Promise<{ status: number; text: string }> {
  const env = sipTestEnv();
  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      env.network,
      'curlimages/curl:latest',
      '-s',
      url,
      '-w',
      '\n%{http_code}',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  const lastNewline = stdout.lastIndexOf('\n');
  return {
    status: Number(stdout.slice(lastNewline + 1).trim()),
    text: stdout.slice(0, lastNewline),
  };
}

/**
 * Uploads a local file's real bytes to a presigned PUT URL (S2-07) — a
 * presigned URL's own host (`minio`, `STORAGE_ENDPOINT`) only resolves on
 * the compose network, the same "cannot reach it from the host" reasoning
 * `dockerCurlJson`'s own doc comment gives, so this bind-mounts the file
 * into a throwaway container rather than uploading from the host process.
 */
export async function dockerCurlUpload(
  url: string,
  filePath: string,
  contentType: string,
): Promise<{ status: number }> {
  const env = sipTestEnv();
  const { stdout } = await execFileAsync(
    'docker',
    [
      'run',
      '--rm',
      '--network',
      env.network,
      '-v',
      `${filePath}:/upload/payload:ro`,
      'curlimages/curl:latest',
      '-s',
      '-X',
      'PUT',
      '-H',
      `content-type: ${contentType}`,
      '--data-binary',
      '@/upload/payload',
      url,
      '-w',
      '%{http_code}',
    ],
    { maxBuffer: 16 * 1024 * 1024 },
  );
  return { status: Number(stdout.trim()) };
}

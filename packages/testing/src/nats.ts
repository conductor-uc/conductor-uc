import { spawn, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

/** A JetStream server to test against, and how to let it go. */
export interface TestNatsHandle {
  /** e.g. `127.0.0.1:14222`. */
  readonly server: string;
  stop(): Promise<void>;
}

/** Point this at an already-running JetStream server to skip starting one. */
export const NATS_URL_ENV = 'TEST_NATS_URL';

/** Matches the MariaDB helper: set in CI so a missing broker fails the run. */
export const REQUIRE_NATS_ENV = 'REQUIRE_NATS_TESTS';

/** Production runs this line, so tests do too. */
const NATS_IMAGE = 'nats:2.10-alpine';

/**
 * Starts a JetStream server for integration tests.
 *
 * Three paths, in order of preference:
 *
 * - `TEST_NATS_URL` — an already-running server. The caller owns its lifecycle,
 *   and `stop()` does nothing.
 * - A local `nats-server` binary — spawned on a free port with its own store
 *   directory. This is the fast path and, more importantly, the *isolated* one:
 *   streams are named after domains (`ORG`, `PBX`, …), so two suites sharing one
 *   server would fight over the same stream names. A server per suite makes that
 *   impossible.
 * - Testcontainers otherwise.
 *
 * `stop()` removes the store directory, so nothing leaks between runs.
 */
export async function startTestNats(): Promise<TestNatsHandle> {
  const external = process.env[NATS_URL_ENV] ?? '';
  if (external !== '') {
    return { server: stripScheme(external), stop: async () => {} };
  }

  const local = await startLocalServer();
  if (local !== undefined) return local;

  return startContainer();
}

/**
 * Whether integration tests can reach a JetStream server, with a reason when
 * they cannot. Throws when {@link REQUIRE_NATS_ENV} is set, so CI fails rather
 * than reporting green with everything skipped.
 */
export async function natsOrSkipReason(): Promise<string | undefined> {
  if ((process.env[NATS_URL_ENV] ?? '') !== '') return undefined;
  if (await hasBinary('nats-server')) return undefined;
  if (await hasBinary('docker')) return undefined;

  const reason =
    `no JetStream server available: set ${NATS_URL_ENV}, install nats-server, or ` +
    `make a Docker daemon reachable for Testcontainers`;

  if ((process.env[REQUIRE_NATS_ENV] ?? '') !== '') {
    throw new Error(`${REQUIRE_NATS_ENV} is set, but ${reason}.`);
  }
  return reason;
}

async function startLocalServer(): Promise<TestNatsHandle | undefined> {
  if (!(await hasBinary('nats-server'))) return undefined;

  const storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cuc-jetstream-'));
  const port = await freePort();

  const child = spawn(
    'nats-server',
    ['-p', String(port), '-js', '-sd', storeDir, '-a', '127.0.0.1'],
    { stdio: 'ignore' },
  );

  try {
    await waitForPort(port, 10_000);
  } catch (error) {
    child.kill('SIGKILL');
    await fs.rm(storeDir, { recursive: true, force: true });
    throw error;
  }

  return {
    server: `127.0.0.1:${String(port)}`,
    stop: async () => {
      await terminate(child);
      await fs.rm(storeDir, { recursive: true, force: true });
    },
  };
}

async function startContainer(): Promise<TestNatsHandle> {
  const { GenericContainer } = await import('testcontainers');
  const container = await new GenericContainer(NATS_IMAGE)
    .withCommand(['-js'])
    .withExposedPorts(4222)
    .start();

  return {
    server: `${container.getHost()}:${String(container.getMappedPort(4222))}`,
    stop: async () => {
      await container.stop();
    },
  };
}

function stripScheme(value: string): string {
  return value.replace(/^nats:\/\//, '');
}

/** Asks the OS for a port, then releases it. */
async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        server.close();
        reject(new Error('Could not determine a free port.'));
        return;
      }
      const { port } = address;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  const { connect } = await import('node:net');

  while (Date.now() < deadline) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = connect({ port, host: '127.0.0.1' });
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });
    });
    if (open) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`nats-server did not accept connections on port ${String(port)} in time.`);
}

async function terminate(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve) => {
    child.once('exit', () => {
      resolve();
    });
    child.kill('SIGTERM');
    // SIGKILL if it has not gone in a second, so a wedged server cannot hang CI.
    setTimeout(() => {
      child.kill('SIGKILL');
      resolve();
    }, 1_000);
  });
}

async function hasBinary(name: string): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('which', [name], { timeout: 3_000 });
    return true;
  } catch {
    return false;
  }
}

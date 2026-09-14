import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';

/** A Redis server to test against, and how to let it go. */
export interface TestRedisHandle {
  /** `redis://host:port`. */
  readonly url: string;
  /**
   * A key prefix unique to this handle. The compose stack's Redis is shared
   * across whatever else is running against it, so a suite that wants
   * isolation (most rate-limit tests do) should key everything under this
   * rather than assume an empty database.
   */
  readonly keyPrefix: string;
  stop(): Promise<void>;
}

/** Point this at an already-running Redis to skip container startup. */
export const REDIS_URL_ENV = 'TEST_REDIS_URL';

/** Matches the MariaDB/NATS/S3 helpers: set in CI so a missing server fails the run. */
export const REQUIRE_REDIS_ENV = 'REQUIRE_REDIS_TESTS';

/** Production runs this line (05 §1), so the container fallback matches it. */
const REDIS_IMAGE = 'redis:7-alpine';

/**
 * Starts a Redis for integration tests, or reuses one.
 *
 * Two paths, matching the other infra helpers: `TEST_REDIS_URL` points at an
 * already-running server (the compose stack from S0-05, no Docker needed);
 * otherwise a Testcontainers Redis is started and shared for the process.
 */
export async function startTestRedis(): Promise<TestRedisHandle> {
  const external = process.env[REDIS_URL_ENV] ?? '';
  const keyPrefix = `t${randomUUID().replaceAll('-', '').slice(0, 16)}:`;

  if (external !== '') {
    return { url: external, keyPrefix, stop: async () => {} };
  }

  if (sharedContainer !== undefined) {
    return { url: sharedContainer.url, keyPrefix, stop: async () => {} };
  }

  const { GenericContainer, Wait } = await import('testcontainers');
  const container = await new GenericContainer(REDIS_IMAGE)
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();

  const url = `redis://${container.getHost()}:${String(container.getMappedPort(6379))}`;
  sharedContainer = { url, stop: async () => void (await container.stop()) };

  return { url, keyPrefix, stop: async () => {} };
}

let sharedContainer: { url: string; stop: () => Promise<void> } | undefined;

/** Stops the shared container, if one was started. Call from global teardown. */
export async function stopSharedRedisContainer(): Promise<void> {
  if (sharedContainer === undefined) return;
  const { stop } = sharedContainer;
  sharedContainer = undefined;
  await stop();
}

/**
 * Whether integration tests can run here, with a reason when they cannot.
 * Throws when {@link REQUIRE_REDIS_ENV} is set, matching the DB/NATS/S3 helpers.
 */
export async function redisOrSkipReason(): Promise<string | undefined> {
  const required = (process.env[REQUIRE_REDIS_ENV] ?? '') !== '';
  const configured = process.env[REDIS_URL_ENV] ?? '';

  if (configured !== '') {
    const { hostname, port } = new URL(configured);
    if (await isReachable(hostname, Number(port) || 6379, 2_000)) return undefined;

    const reason = `${REDIS_URL_ENV} is set to a server that is not reachable`;
    if (required) throw new Error(`${REQUIRE_REDIS_ENV} is set and ${reason}.`);
    return reason;
  }

  if (await canReachDocker()) return undefined;

  const reason = `no Redis server available: set ${REDIS_URL_ENV} or make a Docker daemon reachable for Testcontainers`;
  if (required) throw new Error(`${REQUIRE_REDIS_ENV} is set, but ${reason}.`);
  return reason;
}

async function isReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    const socket = connect({ host, port, timeout: timeoutMs });
    const settle = (value: boolean): void => {
      socket.destroy();
      resolve(value);
    };
    socket.once('connect', () => {
      settle(true);
    });
    socket.once('timeout', () => {
      settle(false);
    });
    socket.once('error', () => {
      settle(false);
    });
  });
}

async function canReachDocker(): Promise<boolean> {
  try {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    await promisify(execFile)('docker', ['info'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** An S3-compatible server to test against, and how to let it go. */
export interface TestS3Handle {
  readonly endpoint: string;
  readonly region: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly forcePathStyle: boolean;
  stop(): Promise<void>;
}

/**
 * Point this at an already-running S3-compatible server to skip container
 * startup — `http://accessKey:secretKey@host:port`, e.g. the compose stack's
 * MinIO from S0-05 (`http://dev-minio:dev-minio-password@127.0.0.1:9000`).
 */
export const S3_URL_ENV = 'TEST_S3_URL';

/** Matches the MariaDB/NATS helpers: set in CI so a missing server fails the run. */
export const REQUIRE_S3_ENV = 'REQUIRE_S3_TESTS';

/** Production runs MinIO in dev/compose (S0-05); the container fallback matches it. */
const MINIO_IMAGE = 'quay.io/minio/minio:latest';

/**
 * Starts an S3-compatible server for integration tests, or reuses one.
 *
 * Two paths, matching `startTestDatabase`: `TEST_S3_URL` points at an
 * already-running server (the compose stack, no Docker needed); otherwise a
 * Testcontainers MinIO is started and shared for the process.
 */
export async function startTestS3(): Promise<TestS3Handle> {
  const external = process.env[S3_URL_ENV] ?? '';
  if (external !== '') {
    return { ...parseS3Url(external), stop: async () => {} };
  }

  if (sharedContainer !== undefined) {
    return { ...sharedContainer.connection, stop: async () => {} };
  }

  const { GenericContainer, Wait } = await import('testcontainers');
  const accessKeyId = 'test-access-key';
  const secretAccessKey = 'test-secret-key';
  const container = await new GenericContainer(MINIO_IMAGE)
    .withEnvironment({ MINIO_ROOT_USER: accessKeyId, MINIO_ROOT_PASSWORD: secretAccessKey })
    .withCommand(['server', '/data'])
    .withExposedPorts(9000)
    .withWaitStrategy(Wait.forHttp('/minio/health/live', 9000))
    .start();

  const connection: Omit<TestS3Handle, 'stop'> = {
    endpoint: `http://${container.getHost()}:${String(container.getMappedPort(9000))}`,
    region: 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  };
  sharedContainer = { connection, stop: async () => void (await container.stop()) };

  return { ...connection, stop: async () => {} };
}

let sharedContainer:
  { connection: Omit<TestS3Handle, 'stop'>; stop: () => Promise<void> } | undefined;

/** Stops the shared container, if one was started. Call from global teardown. */
export async function stopSharedS3Container(): Promise<void> {
  if (sharedContainer === undefined) return;
  const { stop } = sharedContainer;
  sharedContainer = undefined;
  await stop();
}

/**
 * Whether integration tests can run here, with a reason when they cannot.
 * Throws when {@link REQUIRE_S3_ENV} is set, matching the DB/NATS helpers.
 */
export async function s3OrSkipReason(): Promise<string | undefined> {
  const required = (process.env[REQUIRE_S3_ENV] ?? '') !== '';
  const configured = process.env[S3_URL_ENV] ?? '';

  if (configured !== '') {
    const { hostname, port } = new URL(configured.replace(/^s3:\/\//, 'http://'));
    if (await isReachable(hostname, Number(port) || 9000, 2_000)) return undefined;

    const reason = `${S3_URL_ENV} is set to a server that is not reachable`;
    if (required) throw new Error(`${REQUIRE_S3_ENV} is set and ${reason}.`);
    return reason;
  }

  if (await canReachDocker()) return undefined;

  const reason = `no S3-compatible server available: set ${S3_URL_ENV} or make a Docker daemon reachable for Testcontainers`;
  if (required) throw new Error(`${REQUIRE_S3_ENV} is set, but ${reason}.`);
  return reason;
}

/** `http://accessKey:secretKey@host:port` -> connection fields. */
export function parseS3Url(value: string): Omit<TestS3Handle, 'stop'> {
  const url = new URL(value);
  const accessKeyId = decodeURIComponent(url.username);
  const secretAccessKey = decodeURIComponent(url.password);
  url.username = '';
  url.password = '';
  return {
    endpoint: url.origin,
    region: 'us-east-1',
    accessKeyId,
    secretAccessKey,
    forcePathStyle: true,
  };
}

async function isReachable(host: string, port: number, timeoutMs: number): Promise<boolean> {
  const { connect } = await import('node:net');
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

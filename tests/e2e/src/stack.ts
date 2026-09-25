import { type ChildProcess, spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  startTestDatabase,
  startTestNats,
  startTestS3,
  type TestDatabaseHandle,
  type TestNatsHandle,
  type TestS3Handle,
} from '@cuc/testing';

/** The repository root: the nearest parent with the workspace file (this file runs from `src` under vitest and from `dist/src` when built). */
function repoRoot(): string {
  let dir = dirname(fileURLToPath(import.meta.url));
  while (!existsSync(join(dir, 'pnpm-workspace.yaml'))) {
    const parent = dirname(dir);
    if (parent === dir) throw new Error('pnpm-workspace.yaml not found above the e2e package');
    dir = parent;
  }
  return `${dir}/`;
}

const REPO = repoRoot();

/** Where the real services listen, and what the test needs to know about them. */
export interface Stack {
  readonly gateway: string;
  readonly callflow: string;
  readonly mail: string;
  readonly masterOrgId: string;
  readonly internalToken: string;
  readonly headerSecret: string;
  readonly platformBaseDomain: string;
  stop(): Promise<void>;
}

export const MAILPIT_URL = process.env['TEST_MAILPIT_URL'] ?? 'http://127.0.0.1:8025';
const SMTP_HOST = process.env['TEST_SMTP_HOST'] ?? '127.0.0.1';
const SMTP_PORT = process.env['TEST_SMTP_PORT'] ?? '1025';
const REDIS_URL = process.env['TEST_REDIS_URL'] ?? 'redis://127.0.0.1:6379';

export const MASTER_EMAIL = 'root@platform.test';
export const MASTER_PASSWORD = 'correct horse battery staple';

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      server.close(() => {
        resolve(port);
      });
    });
  });
}

interface Running {
  readonly name: string;
  readonly child: ChildProcess;
  readonly log: string[];
}

function launch(
  name: string,
  script: string,
  env: Record<string, string>,
  args: string[] = [],
): Running {
  const log: string[] = [];
  const child = spawn(process.execPath, [`${REPO}${script}`, ...args], {
    cwd: REPO,
    env: { ...process.env, ...env, SERVICE_NAME: name, LOG_LEVEL: 'info', NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const keep = (chunk: Buffer) => {
    log.push(chunk.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  return { name, child, log };
}

async function untilHealthy(service: Running, url: string): Promise<void> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) {
      throw new Error(`${service.name} exited early:\n${service.log.join('').slice(-2000)}`);
    }
    try {
      const response = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error(`${service.name} did not become healthy:\n${service.log.join('').slice(-2000)}`);
}

/** Runs a one-shot script to completion and returns what it printed. */
async function runOnce(
  script: string,
  env: Record<string, string>,
  args: string[],
): Promise<string> {
  const run = launch('bootstrap', script, env, args);
  const code = await new Promise<number | null>((resolve) => {
    run.child.once('exit', resolve);
  });
  const out = run.log.join('');
  if (code !== 0) throw new Error(`${script} exited ${String(code)}:\n${out.slice(-2000)}`);
  return out;
}

function dbEnv(handle: TestDatabaseHandle): Record<string, string> {
  return {
    DB_HOST: handle.host,
    DB_PORT: String(handle.port),
    DB_USER: handle.user,
    DB_PASSWORD: handle.password,
    DB_NAME: handle.database,
  };
}

/**
 * Starts the real services this journey needs as local processes on real
 * infrastructure (MariaDB, NATS, MinIO, Redis, Mailpit), the way the compose
 * stack runs them, and makes the master org and its first admin the way an
 * operator does (the bootstrap CLI, then identity's internal API).
 *
 * Everything a browser calls goes through the gateway, which routes each path
 * to the service that owns it (G-60): identity, org, pbx-config, trunk,
 * callflow, voicemail, cdr and recording all run here, with telephony-config left out
 * (nothing in this journey needs a media node).
 */
export async function startStack(): Promise<Stack> {
  const cleanups: (() => Promise<void>)[] = [];
  const running: Running[] = [];
  const stop = async () => {
    for (const service of running) service.child.kill('SIGTERM');
    await Promise.all(
      running.map(
        (service) =>
          new Promise<void>((resolve) => {
            if (service.child.exitCode !== null) return resolve();
            const timer = setTimeout(() => {
              service.child.kill('SIGKILL');
              resolve();
            }, 5000);
            service.child.once('exit', () => {
              clearTimeout(timer);
              resolve();
            });
          }),
      ),
    );
    for (const cleanup of cleanups.reverse()) await cleanup();
  };

  try {
    const identityDb = await startTestDatabase();
    const orgDb = await startTestDatabase();
    const notificationDb = await startTestDatabase();
    const callflowDb = await startTestDatabase();
    const pbxDb = await startTestDatabase();
    const trunkDb = await startTestDatabase();
    const voicemailDb = await startTestDatabase();
    const cdrDb = await startTestDatabase();
    const recordingDb = await startTestDatabase();
    const nats: TestNatsHandle = await startTestNats();
    const s3: TestS3Handle = await startTestS3();
    cleanups.push(
      () => identityDb.stop(),
      () => orgDb.stop(),
      () => notificationDb.stop(),
      () => callflowDb.stop(),
      () => pbxDb.stop(),
      () => trunkDb.stop(),
      () => voicemailDb.stop(),
      () => cdrDb.stop(),
      () => recordingDb.stop(),
      () => nats.stop(),
      () => s3.stop(),
    );

    const internalToken = `e2e-${randomBytes(12).toString('hex')}`;
    const headerSecret = `e2e-${randomBytes(20).toString('hex')}`;
    const platformBaseDomain = 'platform.test';
    const ports = {
      identity: await freePort(),
      org: await freePort(),
      notification: await freePort(),
      callflow: await freePort(),
      pbx: await freePort(),
      trunk: await freePort(),
      voicemail: await freePort(),
      cdr: await freePort(),
      recording: await freePort(),
      gateway: await freePort(),
    };
    const url = (port: number) => `http://127.0.0.1:${String(port)}`;
    const common = {
      NATS_SERVERS: `nats://${nats.server}`,
      INTERNAL_SERVICE_TOKEN: internalToken,
      HTTP_HOST: '127.0.0.1',
      CRYPTO_KEKS: `1:${randomBytes(32).toString('base64')}`,
      CRYPTO_KEK_CURRENT: '1',
    };
    const orgEnv = {
      ...common,
      ...dbEnv(orgDb),
      IDENTITY_SERVICE_URL: url(ports.identity),
      PLATFORM_BASE_DOMAIN: platformBaseDomain,
      STORAGE_MODE: 'bucket-per-tenant',
      STORAGE_BUCKET_PREFIX: `e2e${randomBytes(3).toString('hex')}`,
      STORAGE_ENDPOINT: s3.endpoint,
      STORAGE_REGION: s3.region,
      STORAGE_ACCESS_KEY_ID: s3.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: s3.secretAccessKey,
      STORAGE_FORCE_PATH_STYLE: String(s3.forcePathStyle),
    };

    // The master org, made the way an operator makes it.
    const out = await runOnce('services/org-service/dist/src/cli/bootstrap-master.js', orgEnv, [
      '--slug',
      'master',
      '--name',
      'Master',
    ]);
    const masterOrgId = /"orgId":"([^"]+)"/.exec(out)?.[1];
    if (masterOrgId === undefined) throw new Error(`no master org id in:\n${out}`);

    const identity = launch('identity-service', 'services/identity-service/dist/src/main.js', {
      ...common,
      ...dbEnv(identityDb),
      HTTP_PORT: String(ports.identity),
      // Asked which org a console hostname belongs to (G-56/G-61); org-service
      // starts just after, and identity only calls it when a request needs it.
      ORG_SERVICE_URL: url(ports.org),
      INTERNAL_HEADER_SIGNING_SECRET: headerSecret,
      COOKIE_SECURE: 'false',
      TRUST_INTERNAL_HEADERS: 'true',
    });
    running.push(identity);
    await untilHealthy(identity, url(ports.identity));

    const master = await fetch(
      `${url(ports.identity)}/internal/v1/orgs/${masterOrgId}/admin-user`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${internalToken}` },
        body: JSON.stringify({
          orgType: 'master',
          email: MASTER_EMAIL,
          displayName: 'Root',
          password: MASTER_PASSWORD,
        }),
      },
    );
    if (master.status !== 201) throw new Error(`master admin: ${String(master.status)}`);

    const org = launch('org-service', 'services/org-service/dist/src/main.js', {
      ...orgEnv,
      HTTP_PORT: String(ports.org),
      TRUST_INTERNAL_HEADERS: 'true',
      INTERNAL_HEADER_SIGNING_SECRET: headerSecret,
    });
    running.push(org);

    const notification = launch(
      'notification-service',
      'services/notification-service/dist/src/main.js',
      {
        ...common,
        ...dbEnv(notificationDb),
        HTTP_PORT: String(ports.notification),
        ORG_SERVICE_URL: url(ports.org),
        IDENTITY_SERVICE_URL: url(ports.identity),
        VOICEMAIL_SERVICE_URL: url(ports.voicemail),
        SMTP_HOST,
        SMTP_PORT,
        PLATFORM_NOREPLY_ADDRESS: `noreply@${platformBaseDomain}`,
        PLATFORM_BASE_DOMAIN: platformBaseDomain,
        CONSOLE_URL_OVERRIDE: 'http://console.test',
      },
    );
    running.push(notification);

    const callflow = launch('callflow-service', 'services/callflow-service/dist/src/main.js', {
      ...common,
      ...dbEnv(callflowDb),
      HTTP_PORT: String(ports.callflow),
      IDENTITY_SERVICE_URL: url(ports.identity),
      TRUST_INTERNAL_HEADERS: 'true',
      INTERNAL_HEADER_SIGNING_SECRET: headerSecret,
    });
    running.push(callflow);

    const storage = {
      STORAGE_MODE: 'bucket-per-tenant',
      STORAGE_BUCKET_PREFIX: orgEnv.STORAGE_BUCKET_PREFIX,
      STORAGE_ENDPOINT: s3.endpoint,
      STORAGE_REGION: s3.region,
      STORAGE_ACCESS_KEY_ID: s3.accessKeyId,
      STORAGE_SECRET_ACCESS_KEY: s3.secretAccessKey,
      STORAGE_FORCE_PATH_STYLE: String(s3.forcePathStyle),
    };
    const behindGateway = {
      TRUST_INTERNAL_HEADERS: 'true',
      INTERNAL_HEADER_SIGNING_SECRET: headerSecret,
    };
    // Telephony is not part of this journey: trunk-service only needs a
    // syntactically valid address for the service that projects to media nodes.
    const trunk = launch('trunk-service', 'services/trunk-service/dist/src/main.js', {
      ...common,
      ...dbEnv(trunkDb),
      ...behindGateway,
      HTTP_PORT: String(ports.trunk),
      IDENTITY_SERVICE_URL: url(ports.identity),
      ORG_SERVICE_URL: url(ports.org),
      TELEPHONY_CONFIG_URL: 'http://127.0.0.1:1',
    });
    running.push(trunk);
    const pbx = launch('pbx-config-service', 'services/pbx-config-service/dist/src/main.js', {
      ...common,
      ...dbEnv(pbxDb),
      ...storage,
      ...behindGateway,
      HTTP_PORT: String(ports.pbx),
      IDENTITY_SERVICE_URL: url(ports.identity),
      ORG_SERVICE_URL: url(ports.org),
      TRUNK_SERVICE_URL: url(ports.trunk),
    });
    running.push(pbx);
    const voicemail = launch('voicemail-service', 'services/voicemail-service/dist/src/main.js', {
      ...common,
      ...dbEnv(voicemailDb),
      ...storage,
      ...behindGateway,
      HTTP_PORT: String(ports.voicemail),
      IDENTITY_SERVICE_URL: url(ports.identity),
      PBX_CONFIG_SERVICE_URL: url(ports.pbx),
    });
    running.push(voicemail);
    const cdr = launch('cdr-service', 'services/cdr-service/dist/src/main.js', {
      ...common,
      ...dbEnv(cdrDb),
      ...storage,
      ...behindGateway,
      HTTP_PORT: String(ports.cdr),
      IDENTITY_SERVICE_URL: url(ports.identity),
      PBX_CONFIG_SERVICE_URL: url(ports.pbx),
      ORG_SERVICE_URL: url(ports.org),
      FS_CDR_INGEST_TOKEN: `e2e-${randomBytes(8).toString('hex')}`,
    });
    running.push(cdr);
    const recording = launch('recording-service', 'services/recording-service/dist/src/main.js', {
      ...common,
      ...dbEnv(recordingDb),
      ...storage,
      ...behindGateway,
      HTTP_PORT: String(ports.recording),
      IDENTITY_SERVICE_URL: url(ports.identity),
    });
    running.push(recording);

    const gateway = launch('api-gateway', 'services/api-gateway/dist/src/main.js', {
      ...common,
      HTTP_PORT: String(ports.gateway),
      IDENTITY_SERVICE_URL: url(ports.identity),
      ORG_SERVICE_URL: url(ports.org),
      PBX_CONFIG_SERVICE_URL: url(ports.pbx),
      CALLFLOW_SERVICE_URL: url(ports.callflow),
      VOICEMAIL_SERVICE_URL: url(ports.voicemail),
      CDR_SERVICE_URL: url(ports.cdr),
      TRUNK_SERVICE_URL: url(ports.trunk),
      RECORDING_SERVICE_URL: url(ports.recording),
      REDIS_URL,
      INTERNAL_HEADER_SIGNING_SECRET: headerSecret,
      // No call-control in this stack, so no realtime hub (S5-08).
      REALTIME_ENABLED: 'false',
    });
    running.push(gateway);

    await Promise.all([
      untilHealthy(org, url(ports.org)),
      untilHealthy(notification, url(ports.notification)),
      untilHealthy(callflow, url(ports.callflow)),
      untilHealthy(trunk, url(ports.trunk)),
      untilHealthy(pbx, url(ports.pbx)),
      untilHealthy(voicemail, url(ports.voicemail)),
      untilHealthy(cdr, url(ports.cdr)),
      untilHealthy(recording, url(ports.recording)),
      untilHealthy(gateway, url(ports.gateway)),
    ]);

    return {
      gateway: url(ports.gateway),
      callflow: url(ports.callflow),
      mail: MAILPIT_URL,
      masterOrgId,
      internalToken,
      headerSecret,
      platformBaseDomain,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

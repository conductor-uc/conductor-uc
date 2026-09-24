import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { beforeAll, describe, expect, it } from 'vitest';

import {
  clearRegistration,
  seedFixtures,
  sipInfraOrSkipReason,
  sipTestEnv,
  type SeedResult,
} from '../src/run-scenario.js';
import { registerOverTls } from '../src/tls-client.js';

const execFileAsync = promisify(execFile);
const skipReason = await sipInfraOrSkipReason();

/**
 * SIP over TLS (07 §5): OpenSIPs' 5061 listener. What a phone relies on is that
 * the connection is encrypted with a modern protocol and that it can register
 * over it with its ordinary digest credentials.
 */
describe.skipIf(skipReason !== undefined)('SIP over TLS', () => {
  let seed: SeedResult;
  beforeAll(async () => {
    seed = await seedFixtures();
  }, 60_000);

  /** What `openssl s_client` reports for one handshake, run inside the OpenSIPs container. */
  async function handshake(extra: string[] = []): Promise<string> {
    const env = sipTestEnv();
    const { stdout, stderr } = await execFileAsync(
      'docker',
      [
        'exec',
        env.opensipsContainer,
        'sh',
        '-c',
        `openssl s_client -connect 127.0.0.1:5061 -servername ${seed.tenantA.fqdn} ${extra.join(' ')} </dev/null 2>&1`,
      ],
      { maxBuffer: 4 * 1024 * 1024 },
    ).catch((error: { stdout?: string; stderr?: string }) => ({
      stdout: `${error.stdout ?? ''}`,
      stderr: `${error.stderr ?? ''}`,
    }));
    return `${stdout}${stderr}`;
  }

  it('offers a certificate for the tenant domain and negotiates TLS 1.2 or later', async () => {
    const output = await handshake();
    expect(output).toMatch(/Protocol\s*:\s*TLSv1\.[23]/);
    expect(output).toContain('BEGIN CERTIFICATE');
    expect(output).not.toMatch(/Cipher\s*:\s*(RC4|.*3DES|.*NULL)/i);
  });

  it('refuses a client that will only speak TLS 1.1', async () => {
    const output = await handshake(['-tls1_1']);
    expect(output).not.toMatch(/Protocol\s*:\s*TLSv1\.1/);
    expect(output).not.toContain('BEGIN CERTIFICATE');
  });

  const tlsPort = Number(process.env['SIP_TEST_OPENSIPS_TLS_HOST_PORT'] ?? '5061');

  it('registers an extension over TLS with its ordinary digest credentials', async () => {
    const ext = seed.extensions[`${seed.tenantA.fqdn}/102`];
    if (ext === undefined) throw new Error('the seed has no extension 102 for tenant A');
    await clearRegistration(`102@${seed.tenantA.fqdn}`);

    const result = await registerOverTls({
      host: '127.0.0.1',
      port: tlsPort,
      domain: seed.tenantA.fqdn,
      user: '102',
      password: ext.password,
    });

    expect(result.statuses).toEqual([401, 200]);
    expect(['TLSv1.2', 'TLSv1.3']).toContain(result.protocol);
  });

  it('refuses a wrong password over TLS, as it does over UDP', async () => {
    await clearRegistration(`102@${seed.tenantA.fqdn}`);
    const result = await registerOverTls({
      host: '127.0.0.1',
      port: tlsPort,
      domain: seed.tenantA.fqdn,
      user: '102',
      password: 'not-the-password',
    });
    // Challenged, answered wrongly, and refused: never a 200.
    expect(result.statuses[0]).toBe(401);
    expect(result.statuses).not.toContain(200);
  });
});

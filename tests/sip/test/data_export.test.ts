import { beforeAll, describe, expect, it } from 'vitest';

import {
  createSignInAdmin,
  dockerCurlJson,
  seedFixtures,
  signInThroughGateway,
  sipInfraOrSkipReason,
  type SeedResult,
} from '../src/run-scenario.js';

const skipReason = await sipInfraOrSkipReason();

const GATEWAY_URL = 'http://api-gateway:8080';

/**
 * S1-16 (G-11 (2)), live through api-gateway: a tenant's administrator builds
 * both server-side exports (every call record as CSV, the recordings and
 * voicemail as a zip), each is built in the background and handed out as a
 * download link. (A reseller is refused the private one by H1; org-service's
 * own tests cover that.)
 */
describe.skipIf(skipReason !== undefined)('S1-16 data export (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let token: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
    token = await signInThroughGateway(GATEWAY_URL, tenantId, admin.email, admin.password);
  }, 120_000);

  const call = (method: 'GET' | 'POST', path: string, body?: unknown) =>
    dockerCurlJson(method, `${GATEWAY_URL}${path}`, body, { authorization: `Bearer ${token}` });

  async function untilReady(path: string): Promise<{ status: string; downloadUrl: string }> {
    let last: { status: string; downloadUrl: string } | undefined;
    await expect
      .poll(
        async () => {
          last = (await call('GET', path)).json as { status: string; downloadUrl: string };
          return last.status;
        },
        { timeout: 60_000, interval: 2_000 },
      )
      .toBe('ready');
    return last!;
  }

  it('builds every call record as CSV and the recordings and voicemail as a zip', async () => {
    const calls = await call('POST', `/v1/tenants/${tenantId}/cdr-exports`, { all: true });
    expect(calls.status, JSON.stringify(calls.json)).toBe(201);
    const readyCalls = await untilReady(
      `/v1/tenants/${tenantId}/cdr-exports/${(calls.json as { id: string }).id}`,
    );
    expect(readyCalls.downloadUrl).toContain('.csv');

    const files = await call('POST', `/v1/tenants/${tenantId}/file-exports`);
    expect(files.status, JSON.stringify(files.json)).toBe(202);
    const readyFiles = await untilReady(
      `/v1/tenants/${tenantId}/file-exports/${(files.json as { id: string }).id}`,
    );
    expect(readyFiles.downloadUrl).toContain('.zip');
  }, 150_000);
});

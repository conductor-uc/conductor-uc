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
 * S1-08 (G-14), live through api-gateway: an administrator makes an API key
 * that may only read extensions. With it, other software reads the tenant's
 * extensions, and is refused everything else: a write, another tenant, and
 * managing keys (H4). Revoked, the key stops working once the gateway's
 * 30-second cache has let it go.
 */
describe.skipIf(skipReason !== undefined)('S1-08 API keys (live)', () => {
  let seed: SeedResult;
  let tenantId: string;
  let otherTenantId: string;
  let token: string;

  beforeAll(async () => {
    seed = await seedFixtures();
    tenantId = seed.tenantCalls.id;
    otherTenantId = seed.tenantQueue.id;
    const admin = await createSignInAdmin(tenantId, seed.resellerId);
    token = await signInThroughGateway(GATEWAY_URL, tenantId, admin.email, admin.password);
  }, 120_000);

  const call = (method: 'GET' | 'POST' | 'DELETE', path: string, bearer: string, body?: unknown) =>
    dockerCurlJson(method, `${GATEWAY_URL}${path}`, body, { authorization: `Bearer ${bearer}` });

  it('reads what it was given, and nothing else, until it is revoked', async () => {
    const created = await call('POST', `/v1/orgs/${tenantId}/api-keys`, token, {
      name: 'S1-08 live key',
      permissions: ['extension.read'],
    });
    expect(created.status, JSON.stringify(created.json)).toBe(201);
    const { apiKey, key } = created.json as { apiKey: { id: string }; key: string };
    expect(key).toMatch(/^key_[0-9a-f]{12}_/);

    const read = await call('GET', `/v1/tenants/${tenantId}/extensions`, key);
    expect(read.status, JSON.stringify(read.json)).toBe(200);
    expect((read.json as { rows: unknown[] }).rows.length).toBeGreaterThan(0);

    const write = await call('POST', `/v1/tenants/${tenantId}/extensions`, key, {
      number: '899',
      displayName: 'Not allowed',
    });
    expect(write.json).toMatchObject({ code: 'permission_denied' });

    const elsewhere = await call('GET', `/v1/tenants/${otherTenantId}/extensions`, key);
    expect(elsewhere.json).toMatchObject({ code: 'tenant_boundary' });

    const moreKeys = await call('POST', `/v1/orgs/${tenantId}/api-keys`, key, {
      name: 'from a key',
      permissions: ['extension.read'],
    });
    expect(moreKeys.json).toMatchObject({ code: 'api_key_not_allowed' });

    const revoked = await call('DELETE', `/v1/orgs/${tenantId}/api-keys/${apiKey.id}`, token);
    expect(revoked.status).toBe(204);
    await expect
      .poll(async () => (await call('GET', `/v1/tenants/${tenantId}/extensions`, key)).status, {
        timeout: 45_000,
        interval: 2_000,
      })
      .toBe(401);
    const after = await call('GET', `/v1/tenants/${tenantId}/extensions`, key);
    expect(after.json).toMatchObject({ code: 'api_key_invalid' });
  }, 90_000);
});

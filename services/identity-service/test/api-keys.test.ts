import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, silentLogger } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { createOrgAccess } from '../src/authz/org-access.js';
import { createPermissionLookup } from '../src/authz/permission-lookup.js';
import type { OrgClient, OrgLineage } from '../src/org-client.js';
import { createApiKeyRepo, type ApiKeyRepo } from '../src/repo/api-key.repo.js';
import {
  registerApiKeyInternalRoutes,
  registerApiKeyRoutes,
} from '../src/routes/api-keys.routes.js';
import { startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';
const TOKEN = 'test-internal-token';
const PASSWORD = 'correct horse battery staple';

const MASTER = 'org-master';
const ACME = 'org-acme';
const ACME_TENANT = 'org-acme-dental';
const OTHER_TENANT = 'org-other-cafe';

const TREE = new Map<string, OrgLineage>([
  [MASTER, { orgId: MASTER, type: 'master', parentId: null, resellerId: null }],
  [ACME, { orgId: ACME, type: 'reseller', parentId: MASTER, resellerId: ACME }],
  [ACME_TENANT, { orgId: ACME_TENANT, type: 'tenant', parentId: ACME, resellerId: ACME }],
  [OTHER_TENANT, { orgId: OTHER_TENANT, type: 'tenant', parentId: MASTER, resellerId: null }],
]);

interface KeyBody {
  id: string;
  name: string;
  prefix: string;
  permissions: string[];
  expiresAt: string | null;
  revokedAt: string | null;
  active: boolean;
}

describe.skipIf(skipReason !== undefined)('API keys (S1-08, G-14)', () => {
  let h: Harness;
  let app: Server;
  let keys: ApiKeyRepo;

  beforeAll(async () => {
    h = await startHarness();
    const orgClient: Pick<OrgClient, 'lineage'> = {
      lineage: (orgId) => Promise.resolve(TREE.get(orgId)),
    };
    app = await createServer({
      serviceName: 'identity-service',
      logger: silentLogger(),
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    keys = createApiKeyRepo(h.db);
    registerApiKeyRoutes(
      app,
      keys,
      createOrgAccess(orgClient),
      createPermissionLookup(h.users, h.roles, h.grants),
    );
    registerApiKeyInternalRoutes(app, keys, TOKEN);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    for (const table of ['api_keys', 'role_assignments', 'users', 'outbox'] as const) {
      await h.db.kysely.deleteFrom(table).execute();
    }
  });

  /** A person of [orgId] with [role], and the headers the gateway would forward for them. */
  async function person(orgId: string, role: string) {
    const lineage = TREE.get(orgId)!;
    const user = await h.users.create(
      { requestId: 'test' },
      {
        orgId,
        orgType: lineage.type,
        resellerId: lineage.type === 'tenant' ? lineage.resellerId : null,
        email: `${crypto.randomUUID()}@example.test`,
        displayName: 'Someone',
        password: PASSWORD,
      },
    );
    await h.roles.assignRole(user.id, role, orgId);
    return signInternalHeaders(SECRET, {
      actorId: user.id,
      actorType: 'user',
      orgId,
      orgType: lineage.type,
      ...(lineage.type === 'tenant' && lineage.resellerId !== null
        ? { resellerId: lineage.resellerId }
        : {}),
    });
  }

  const create = (orgId: string, headers: Record<string, string>, payload: object) =>
    app.inject({ method: 'POST', url: `/v1/orgs/${orgId}/api-keys`, headers, payload });
  const internal = { authorization: `Bearer ${TOKEN}` };
  const verify = (key: string) =>
    app.inject({
      method: 'POST',
      url: '/internal/v1/api-keys/verify',
      headers: internal,
      payload: { key },
    });

  it('an administrator creates a key, sees it once, and it acts for their org with what they gave it', async () => {
    const admin = await person(ACME_TENANT, 'tenant_admin');
    const created = await create(ACME_TENANT, admin, {
      name: 'Billing export',
      permissions: ['extension.manage', 'cdr.read'],
    });
    expect(created.statusCode, created.body).toBe(201);
    const { apiKey, key } = created.json<{ apiKey: KeyBody; key: string }>();
    expect(key).toMatch(/^key_[0-9a-f]{12}_[A-Za-z0-9_-]{32}$/);
    expect(key.startsWith(`key_${apiKey.prefix}_`)).toBe(true);
    expect(apiKey).toMatchObject({
      name: 'Billing export',
      permissions: ['cdr.read', 'extension.manage'],
      expiresAt: null,
      active: true,
    });

    // Listed without its secret.
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ACME_TENANT}/api-keys`,
      headers: admin,
    });
    expect(listed.body).not.toContain(key.split('_')[2]!);
    expect(listed.json<{ rows: KeyBody[] }>().rows).toHaveLength(1);

    const verified = await verify(key);
    expect(verified.json()).toEqual({
      keyId: apiKey.id,
      orgId: ACME_TENANT,
      orgType: 'tenant',
      resellerId: ACME,
    });
    const permissions = await app.inject({
      method: 'GET',
      url: `/internal/v1/orgs/${ACME_TENANT}/api-keys/${apiKey.id}/permissions`,
      headers: internal,
    });
    // The management permission brings its read twin (G-10).
    expect(permissions.json()).toEqual({
      permissions: ['cdr.read', 'extension.manage', 'extension.read'],
    });

    // A near miss is no key at all.
    expect((await verify(`${key.slice(0, -1)}x`)).statusCode).toBe(401);
    expect((await verify('key_000000000000_' + 'a'.repeat(32))).statusCode).toBe(401);
    expect((await verify('not a key')).json()).toMatchObject({ code: 'api_key_invalid' });
  });

  it('refuses unknown permissions, H4 ones, ones the creator lacks, and an end date in the past', async () => {
    const admin = await person(ACME_TENANT, 'tenant_admin');
    const code = async (payload: object) =>
      (await create(ACME_TENANT, admin, { name: 'k', ...payload })).json<{ code: string }>().code;
    expect(await code({ permissions: ['made.up'] })).toBe('unknown_permission');
    expect(await code({ permissions: ['user.manage'] })).toBe('permission_not_for_api_keys');
    expect(await code({ permissions: ['apikey.manage'] })).toBe('permission_not_for_api_keys');
    expect(await code({ permissions: ['platform.operate'] })).toBe('permission_escalation');
    expect(
      await code({ permissions: ['extension.read'], expiresAt: '2020-01-01T00:00:00.000Z' }),
    ).toBe('expires_at_in_past');
    const [row] = await h.db.kysely.selectFrom('api_keys').select('id').execute();
    expect(row).toBeUndefined();
  });

  it("keeps a reseller's key away from private data (H1), and each org to its own keys", async () => {
    const master = await person(MASTER, 'master_admin');
    const forReseller = await create(ACME, master, { name: 'k', permissions: ['cdr.read'] });
    expect(forReseller.json()).toMatchObject({ code: 'reseller_private_data_denied' });

    const admin = await person(ACME_TENANT, 'tenant_admin');
    const elsewhere = await create(OTHER_TENANT, admin, {
      name: 'k',
      permissions: ['extension.read'],
    });
    expect(elsewhere.statusCode).toBe(403);
  });

  it('a revoked key stops working at once, and an expired one after its end date', async () => {
    const admin = await person(ACME_TENANT, 'tenant_admin');
    const created = await create(ACME_TENANT, admin, {
      name: 'Short lived',
      permissions: ['extension.read'],
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
    });
    const { apiKey, key } = created.json<{ apiKey: KeyBody; key: string }>();
    expect(apiKey.expiresAt).not.toBeNull();
    expect(await keys.verify(key, new Date(Date.now() + 2 * 60 * 60 * 1000))).toBeUndefined();

    const revoke = () =>
      app.inject({
        method: 'DELETE',
        url: `/v1/orgs/${ACME_TENANT}/api-keys/${apiKey.id}`,
        headers: admin,
      });
    expect((await revoke()).statusCode).toBe(204);
    expect((await revoke()).json()).toMatchObject({ code: 'api_key_not_found' });
    expect((await verify(key)).statusCode).toBe(401);
    const permissions = await app.inject({
      method: 'GET',
      url: `/internal/v1/orgs/${ACME_TENANT}/api-keys/${apiKey.id}/permissions`,
      headers: internal,
    });
    expect(permissions.statusCode).toBe(404);
    const listed = await app.inject({
      method: 'GET',
      url: `/v1/orgs/${ACME_TENANT}/api-keys`,
      headers: admin,
    });
    expect(listed.json<{ rows: KeyBody[] }>().rows[0]).toMatchObject({ active: false });

    // Both changes are audited.
    const outbox = JSON.stringify(await h.db.kysely.selectFrom('outbox').selectAll().execute());
    expect(outbox).toContain('apikey.created');
    expect(outbox).toContain('apikey.revoked');
  });

  it('the internal routes need the service token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/internal/v1/api-keys/verify',
      payload: { key: 'key_x' },
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({ code: 'internal_token_invalid' });
  });
});

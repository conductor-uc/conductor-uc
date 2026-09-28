import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { pickupPeers } from '../src/domain/pickup-group.js';
import { createPickupGroupRepo } from '../src/repo/pickup-group.repo.js';
import {
  registerPickupGroupRoutes,
  registerPickupPeersInternalRoutes,
} from '../src/routes/pickup-group.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';
const TOKEN = 'internal-token';

describe('pickupPeers (S9-18)', () => {
  it('is every other member of every group the extension is in', () => {
    const groups = [
      { memberExtensionIds: ['a', 'b', 'c'] },
      { memberExtensionIds: ['a', 'd'] },
      { memberExtensionIds: ['e', 'f'] },
    ];
    expect(pickupPeers('a', groups).sort()).toEqual(['b', 'c', 'd']);
    expect(pickupPeers('e', groups)).toEqual(['f']);
    expect(pickupPeers('z', groups)).toEqual([]);
  });
});

describe.skipIf(skipReason !== undefined)('pickup group HTTP routes (S9-18)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    const pickupGroups = createPickupGroupRepo(h.db);
    registerPickupGroupRoutes(app, pickupGroups);
    registerPickupPeersInternalRoutes(app, {
      pickupGroups,
      extensions: h.extensions,
      internalServiceToken: TOKEN,
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
  });

  const headers = (tenantId: string) =>
    signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });

  async function extension(tenantId: string, number: string): Promise<string> {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    const location = await h.emergencyLocations.create(
      { tenantId },
      {
        label: 'Office',
        addressLine1: '1 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      },
    );
    return (
      await h.extensions.create(
        { tenantId },
        { number, displayName: `Extension ${number}`, emergencyLocationId: location.id },
      )
    ).id;
  }

  it('reads with group.read and changes with group.manage, config class', () => {
    for (const route of app.registeredRoutes) {
      if (!route.url.startsWith('/v1/tenants/:tenantId/pickup-groups')) continue;
      expect(route.permission).toBe(
        route.method === 'GET' || route.method === 'HEAD' ? 'group.read' : 'group.manage',
      );
      expect(route.dataClass).toBe('config');
    }
  });

  it('creates, lists, renames, changes the members of and deletes a group, announcing each', async () => {
    const tenantId = crypto.randomUUID();
    const a = await extension(tenantId, '101');
    const b = await extension(tenantId, '102');
    const c = await extension(tenantId, '103');
    const url = `/v1/tenants/${tenantId}/pickup-groups`;

    const created = await app.inject({
      method: 'POST',
      url,
      headers: headers(tenantId),
      payload: { label: 'Front office', memberExtensionIds: [a, b] },
    });
    expect(created.statusCode).toBe(201);
    const { id } = created.json<{ id: string }>();

    const list = await app.inject({ method: 'GET', url, headers: headers(tenantId) });
    expect(list.json()).toEqual({
      rows: [{ id, label: 'Front office', memberExtensionIds: [a, b] }],
    });

    const changed = await app.inject({
      method: 'PATCH',
      url: `${url}/${id}`,
      headers: headers(tenantId),
      payload: { label: 'Reception', memberExtensionIds: [a, b, c] },
    });
    expect(changed.json()).toMatchObject({ label: 'Reception', memberExtensionIds: [a, b, c] });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `${url}/${id}`,
      headers: headers(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const types = (
      await h.db.kysely.selectFrom('outbox').select('type').orderBy('id').execute()
    ).map((row) => row.type);
    expect(types.filter((t) => t.startsWith('pbx.pickup_group.'))).toEqual([
      'pbx.pickup_group.created',
      'pbx.pickup_group.updated',
      'pbx.pickup_group.deleted',
    ]);
  });

  it('refuses a group of one, a repeated member, and an extension not in the tenant', async () => {
    const tenantId = crypto.randomUUID();
    const a = await extension(tenantId, '101');
    const url = `/v1/tenants/${tenantId}/pickup-groups`;
    const post = (memberExtensionIds: string[]) =>
      app.inject({
        method: 'POST',
        url,
        headers: headers(tenantId),
        payload: { label: 'G', memberExtensionIds },
      });
    expect((await post([a])).statusCode).toBe(400);
    expect((await post([a, a])).json()).toMatchObject({ code: 'invalid_pickup_group' });
    expect((await post([a, 'elsewhere'])).json()).toMatchObject({
      code: 'pickup_group_member_not_found',
      params: { extensionIds: ['elsewhere'] },
    });
  });

  it('tells call-control whose calls an extension may pick up, by number', async () => {
    const tenantId = crypto.randomUUID();
    const a = await extension(tenantId, '101');
    const b = await extension(tenantId, '102');
    const c = await extension(tenantId, '103');
    const d = await extension(tenantId, '104');
    const repo = createPickupGroupRepo(h.db);
    await repo.create({ tenantId }, { label: 'Front', memberExtensionIds: [a, b] });
    await repo.create({ tenantId }, { label: 'Sales', memberExtensionIds: [a, c] });
    await repo.create({ tenantId }, { label: 'Back', memberExtensionIds: [c, d] });

    const peers = (number: string, token = TOKEN) =>
      app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/by-number/${number}/pickup-peers`,
        headers: { authorization: `Bearer ${token}` },
      });
    expect((await peers('101')).json()).toEqual({ numbers: ['102', '103'] });
    expect((await peers('102')).json()).toEqual({ numbers: ['101'] });
    // No such extension: nobody.
    expect((await peers('999')).json()).toEqual({ numbers: [] });
    // Another tenant's extension 101 is not this one.
    const other = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/extensions/by-number/101/pickup-peers`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(other.json()).toEqual({ numbers: [] });
    expect((await peers('101', 'wrong')).statusCode).toBe(401);
  });
});

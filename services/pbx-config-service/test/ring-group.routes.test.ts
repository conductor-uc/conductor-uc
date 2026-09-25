import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerRingGroupRoutes } from '../src/routes/ring-group.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('ring group HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerRingGroupRoutes(app, h.ringGroups);
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

  function actorHeaders(tenantId: string) {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  async function createExtension(tenantId: string, number: string): Promise<string> {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    const location = await h.emergencyLocations.create(ctxFor(tenantId), {
      label: 'Test Location',
      addressLine1: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    const extension = await h.extensions.create(ctxFor(tenantId), {
      number,
      displayName: `Extension ${number}`,
      emergencyLocationId: location.id,
    });
    return extension.id;
  }

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });

  it('every route requires group.read (reads) or group.manage (writes) (G-10)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/tenants/:tenantId/ring-groups')) {
        expect(route.permission).toBe(
          route.method === 'GET' || route.method === 'HEAD' ? 'group.read' : 'group.manage',
        );
      }
    }
  });

  it('creates, lists, gets, updates, and deletes a ring group', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');
    const ext2 = await createExtension(tenantId, '102');

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/ring-groups`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [ext1, ext2],
        ringTimeoutSeconds: 20,
      },
    });
    expect(created.statusCode).toBe(201);
    const body: { id: string } = created.json();

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/ring-groups`,
      headers: actorHeaders(tenantId),
    });
    expect(listed.statusCode).toBe(200);
    const listedBody: { rows: unknown[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/ring-groups/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(got.statusCode).toBe(200);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/ring-groups/${body.id}`,
      headers: actorHeaders(tenantId),
      payload: { strategy: 'round_robin' },
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody: { strategy: string } = updated.json();
    expect(updatedBody.strategy).toBe('round_robin');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/ring-groups/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/ring-groups/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects an invalid strategy with 400', async () => {
    const tenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/ring-groups`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Sales',
        strategy: 'bogus',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 20,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a member extension that does not exist with 400', async () => {
    const tenantId = crypto.randomUUID();

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/ring-groups`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [crypto.randomUUID()],
        ringTimeoutSeconds: 20,
      },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s getting a ring group in a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();
    const ext1 = await createExtension(tenantId, '101');

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/ring-groups`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 20,
      },
    });
    const body: { id: string } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${otherTenantId}/ring-groups/${body.id}`,
      headers: actorHeaders(otherTenantId),
    });
    expect(response.statusCode).toBe(404);
  });
});

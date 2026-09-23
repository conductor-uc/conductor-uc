import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerInternalRoutes } from '../src/routes/internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/tenants/:tenantId/extensions/:id',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
      registerInternalRoutes(
        app,
        h.extensions,
        h.dids,
        h.emergencyLocations,
        h.mediaAssets,
        h.ringGroups,
        h.queues,
        h.agents,
        h.queueTiers,
        h.parkingLots,
        TOKEN,
      );
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
      h.domains.realms = {};
      h.trunks.known.clear();
    });

    it('returns the digest credential for a valid token', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await h.extensions.create(
        { tenantId },
        {
          number: '101',
          displayName: 'Front Desk',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      const body: {
        extensionId: string;
        number: string;
        username: string;
        ha1: string;
        realm: string;
      } = response.json();
      expect(body).toMatchObject({
        extensionId: created.id,
        number: '101',
        username: '101',
        realm: 'tenant-a.platform.test',
      });
      expect(body.ha1).toHaveLength(32);
      expect(JSON.stringify(body)).not.toMatch(/secret|password/i);
    });

    it('401s with no token', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('401s with the wrong token', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
        headers: { authorization: 'Bearer wrong-token' },
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown extension', async () => {
      const tenantId = crypto.randomUUID();
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/extensions/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('404s an extension that exists but belongs to a different tenant', async () => {
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      const created = await h.extensions.create(
        { tenantId },
        {
          number: '101',
          displayName: 'Front Desk',
          emergencyLocationId: (
            await h.emergencyLocations.create(
              { tenantId },
              {
                label: 'Test Location',
                addressLine1: '123 Main St',
                city: 'Springfield',
                state: 'IL',
                postalCode: '62701',
                country: 'US',
              },
            )
          ).id,
        },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${otherTenantId}/extensions/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  },
);

describe.skipIf(skipReason !== undefined)('GET /internal/v1/tenants/:tenantId/dids/:id', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
    registerInternalRoutes(
      app,
      h.extensions,
      h.dids,
      h.emergencyLocations,
      h.mediaAssets,
      h.ringGroups,
      h.queues,
      h.agents,
      h.queueTiers,
      h.parkingLots,
      TOKEN,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
    h.trunks.known.clear();
  });

  it('returns a DID for a valid token', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const extension = await h.extensions.create(
      { tenantId },
      {
        number: '101',
        displayName: 'Front Desk',
        emergencyLocationId: (
          await h.emergencyLocations.create(
            { tenantId },
            {
              label: 'Test Location',
              addressLine1: '123 Main St',
              city: 'Springfield',
              state: 'IL',
              postalCode: '62701',
              country: 'US',
            },
          )
        ).id,
      },
    );
    const created = await h.dids.create(
      { tenantId },
      {
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extension.id,
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/dids/${created.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: created.id,
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId: extension.id,
    });
  });

  it('401s with no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/dids/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('404s an unknown DID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/dids/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s a DID that exists but belongs to a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const extension = await h.extensions.create(
      { tenantId },
      {
        number: '101',
        displayName: 'Front Desk',
        emergencyLocationId: (
          await h.emergencyLocations.create(
            { tenantId },
            {
              label: 'Test Location',
              addressLine1: '123 Main St',
              city: 'Springfield',
              state: 'IL',
              postalCode: '62701',
              country: 'US',
            },
          )
        ).id,
      },
    );
    const created = await h.dids.create(
      { tenantId },
      {
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extension.id,
      },
    );

    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${otherTenantId}/dids/${created.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });
});

describe.skipIf(skipReason !== undefined)('media asset internal routes (S2-07)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
    registerInternalRoutes(
      app,
      h.extensions,
      h.dids,
      h.emergencyLocations,
      h.mediaAssets,
      h.ringGroups,
      h.queues,
      h.agents,
      h.queueTiers,
      h.parkingLots,
      TOKEN,
    );
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  it('GET returns a media asset for a valid token', async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(
      { tenantId },
      { kind: 'prompt', label: 'Welcome greeting', contentType: 'audio/mpeg' },
    );

    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/media-assets/${asset.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      id: asset.id,
      kind: 'prompt',
      status: 'pending',
      contentType: 'audio/mpeg',
      objectKey: asset.objectKey,
      variant8kKey: null,
      variant16kKey: null,
    });
  });

  it('GET 401s with no token', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/media-assets/${crypto.randomUUID()}`,
    });
    expect(response.statusCode).toBe(401);
  });

  it('GET 404s an unknown asset', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/media-assets/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    expect(response.statusCode).toBe(404);
  });

  it(":complete records the transcode worker's own result and returns status ready", async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(
      { tenantId },
      { kind: 'prompt', label: 'Welcome greeting', contentType: 'audio/mpeg' },
    );
    await h.mediaAssets.finalize({ tenantId }, asset.id);

    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/media-assets/${asset.id}/complete`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        durationMs: 4200,
        sha256: 'a'.repeat(64),
        sizeBytes: 65536,
        variant8kKey: `media-assets/${asset.id}/8k.wav`,
        variant16kKey: `media-assets/${asset.id}/16k.wav`,
      },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'ready',
      variant8kKey: `media-assets/${asset.id}/8k.wav`,
      variant16kKey: `media-assets/${asset.id}/16k.wav`,
    });
  });

  it(":fail records the transcode worker's own error and returns status failed", async () => {
    const tenantId = crypto.randomUUID();
    const { asset } = await h.mediaAssets.create(
      { tenantId },
      { kind: 'prompt', label: 'Welcome greeting', contentType: 'audio/mpeg' },
    );
    await h.mediaAssets.finalize({ tenantId }, asset.id);

    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${tenantId}/media-assets/${asset.id}/fail`,
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: { errorMessage: 'ffmpeg: invalid data found when processing input' },
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ status: 'failed' });
  });

  it(':complete 401s with no token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/media-assets/${crypto.randomUUID()}/complete`,
      payload: {
        durationMs: 1,
        sha256: 'a'.repeat(64),
        sizeBytes: 1,
        variant8kKey: 'x',
        variant16kKey: 'y',
      },
    });
    expect(response.statusCode).toBe(401);
  });
});

describe.skipIf(skipReason !== undefined)(
  'GET /internal/v1/tenants/:tenantId/ring-groups/:id (S2-08)',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
      registerInternalRoutes(
        app,
        h.extensions,
        h.dids,
        h.emergencyLocations,
        h.mediaAssets,
        h.ringGroups,
        h.queues,
        h.agents,
        h.queueTiers,
        h.parkingLots,
        TOKEN,
      );
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

    async function createExtension(tenantId: string, number: string): Promise<string> {
      h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
      const location = await h.emergencyLocations.create(
        { tenantId },
        {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        },
      );
      const extension = await h.extensions.create(
        { tenantId },
        { number, displayName: `Extension ${number}`, emergencyLocationId: location.id },
      );
      return extension.id;
    }

    it('returns a ring group for a valid token', async () => {
      const tenantId = crypto.randomUUID();
      const ext1 = await createExtension(tenantId, '101');
      const created = await h.ringGroups.create(
        { tenantId },
        {
          label: 'Sales',
          strategy: 'round_robin',
          memberExtensionIds: [ext1],
          ringTimeoutSeconds: 25,
        },
      );

      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${tenantId}/ring-groups/${created.id}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        id: created.id,
        label: 'Sales',
        strategy: 'round_robin',
        memberExtensionIds: [ext1],
        ringTimeoutSeconds: 25,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
    });

    it('401s with no token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/ring-groups/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s an unknown ring group', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/internal/v1/tenants/${crypto.randomUUID()}/ring-groups/${crypto.randomUUID()}`,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(404);
    });
  },
);

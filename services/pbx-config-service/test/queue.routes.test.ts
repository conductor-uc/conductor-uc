import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerQueueRoutes } from '../src/routes/queue.routes.js';
import { registerAgentRoutes } from '../src/routes/agent.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

describe.skipIf(skipReason !== undefined)('queue/agent/tier HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerQueueRoutes(app, h.queues, h.queueTiers);
    registerAgentRoutes(app, h.agents);
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
      if (
        route.url.startsWith('/v1/tenants/:tenantId/queues') ||
        route.url.startsWith('/v1/tenants/:tenantId/agents')
      ) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
        // Reads declare the read twin, writes the management permission (G-10).
        expect(route.permission).toBe(
          route.method === 'GET' || route.method === 'HEAD' ? 'queue.read' : 'queue.manage',
        );
      }
    }
  });

  it('creates, lists, gets, updates, and deletes a queue', async () => {
    const tenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/queues`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 0,
        announcePosition: false,
      },
    });
    expect(created.statusCode).toBe(201);
    const body: { id: string } = created.json();

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/queues`,
      headers: actorHeaders(tenantId),
    });
    expect(listed.statusCode).toBe(200);
    const listedBody: { rows: unknown[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/queues/${body.id}`,
      headers: actorHeaders(tenantId),
      payload: { strategy: 'ring-all' },
    });
    expect(updated.statusCode).toBe(200);
    const updatedBody: { strategy: string } = updated.json();
    expect(updatedBody.strategy).toBe('ring-all');

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/queues/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(deleted.statusCode).toBe(204);

    const gone = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/queues/${body.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(gone.statusCode).toBe(404);
  });

  it('rejects an invalid strategy with 400', async () => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/queues`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Support', strategy: 'bogus', maxWaitSeconds: 0, announcePosition: false },
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s getting a queue in a different tenant', async () => {
    const tenantId = crypto.randomUUID();
    const otherTenantId = crypto.randomUUID();

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/queues`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 0,
        announcePosition: false,
      },
    });
    const body: { id: string } = created.json();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${otherTenantId}/queues/${body.id}`,
      headers: actorHeaders(otherTenantId),
    });
    expect(response.statusCode).toBe(404);
  });

  it('creates an agent and tiers it into a queue over HTTP', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');

    const agentResponse = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/agents`,
      headers: actorHeaders(tenantId),
      payload: { extensionId },
    });
    expect(agentResponse.statusCode).toBe(201);
    const agent: { id: string } = agentResponse.json();

    const queueResponse = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/queues`,
      headers: actorHeaders(tenantId),
      payload: {
        label: 'Support',
        strategy: 'round-robin',
        maxWaitSeconds: 0,
        announcePosition: false,
      },
    });
    const queue: { id: string } = queueResponse.json();

    const tierResponse = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/queues/${queue.id}/tiers`,
      headers: actorHeaders(tenantId),
      payload: { agentId: agent.id },
    });
    expect(tierResponse.statusCode).toBe(201);
    const tier: { id: string; queueId: string; agentId: string } = tierResponse.json();
    expect(tier).toMatchObject({ queueId: queue.id, agentId: agent.id });

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/queues/${queue.id}/tiers`,
      headers: actorHeaders(tenantId),
    });
    const listedBody: { rows: unknown[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/queues/${queue.id}/tiers/${tier.id}`,
      headers: actorHeaders(tenantId),
    });
    expect(removed.statusCode).toBe(204);
  });

  it('rejects a duplicate agent identity for the same extension with 409', async () => {
    const tenantId = crypto.randomUUID();
    const extensionId = await createExtension(tenantId, '101');
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/agents`,
      headers: actorHeaders(tenantId),
      payload: { extensionId },
    });

    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/agents`,
      headers: actorHeaders(tenantId),
      payload: { extensionId },
    });
    expect(response.statusCode).toBe(409);
  });
});

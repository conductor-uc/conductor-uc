import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventConsumer } from '@cuc/events';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createOrgConsumer } from '../src/consumers/org.consumer.js';
import { telephonyEvents } from '../src/events.js';
import { resetOpenSipsSchema, resetSchema, startBusHarness, type BusHarness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * `runOnce()` already long-polls for its own `pullTimeoutMs`, but a machine
 * running many concurrent suites against one shared NATS server can starve
 * that window before a just-published message is visible. Retrying a few
 * more empty passes still exercises the real pull-consumer path.
 *
 * `pass.handled` assertions below use `toBeGreaterThanOrEqual(1)`, not
 * `toBe(1)`, for the same reason: this suite's ORG-stream durable consumer
 * reads the same physical stream pbx-config-service's own
 * `domain.consumer.test.ts` does when `TEST_NATS_URL` points at one shared
 * server (`@cuc/testing`'s nats.ts documents the shared-server path as the
 * *unsafe* one for exactly this reason — CI sets it globally, flagged as
 * gap G-17 in docs/decisions.md). Each test still asserts its own tenant's
 * actual resulting state, which a stray unrelated event cannot affect.
 */
async function runOnceUntilHandled(
  consumer: EventConsumer,
  attempts = 3,
): Promise<{ handled: number; failed: number }> {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const pass = await consumer.runOnce();
    if (pass.handled > 0 || pass.failed > 0 || attempt === attempts) return pass;
  }
  throw new Error('unreachable');
}

describe.skipIf(skipReason !== undefined)('org consumer', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await resetOpenSipsSchema(h.opensipsDb);
    h.mi.calls.length = 0;
    await h.bus.jsm.streams.purge('ORG');
  });

  function consumer() {
    return createOrgConsumer(h.db, h.bus, h.logger, h.readModel, h.projection, {
      pullTimeoutMs: 5000,
    });
  }

  async function publish(
    type: 'org.tenant.created' | 'org.tenant.suspended' | 'org.tenant.resumed' | 'org.domain.added',
    data: Record<string, unknown>,
  ): Promise<void> {
    const contract = telephonyEvents.contract(type);
    telephonyEvents.assertPayload(type, data);
    await h.bus.publish({
      id: crypto.randomUUID(),
      type,
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: {},
      data,
    });
  }

  it('org.tenant.created inserts an active tenant row', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();

    await publish('org.tenant.created', {
      orgId: tenantId,
      slug: 'acme',
      name: 'Acme',
      parentId: crypto.randomUUID(),
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const tenant = await h.readModel.findTenant(h.db.kysely, tenantId);
    expect(tenant).toEqual({ id: tenantId, status: 'active' });
  });

  it("org.domain.added (scope: tenant) projects the tenant's domain and reloads", async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();

    await publish('org.tenant.created', {
      orgId: tenantId,
      slug: 'acme',
      name: 'Acme',
      parentId: crypto.randomUUID(),
    });
    await runOnceUntilHandled(c);

    await publish('org.domain.added', {
      domainId: crypto.randomUUID(),
      fqdn: 'acme.platform.test',
      scope: 'tenant',
      ownerId: tenantId,
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    const projected = await h.opensipsProjection.listDomains();
    expect(projected).toContain('acme.platform.test');
    expect(h.mi.calls).toContain('domain_reload');
  });

  it('ignores a reseller base-domain event — nothing to project', async () => {
    const c = consumer();
    await c.ensure();

    await publish('org.domain.added', {
      domainId: crypto.randomUUID(),
      fqdn: 'voice.reseller-brand.com',
      scope: 'reseller_base',
      ownerId: crypto.randomUUID(),
    });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(await h.opensipsProjection.listDomains()).toEqual([]);
    expect(h.mi.calls).toEqual([]);
  });

  it('suspending a tenant removes its domain from the projection (02 §2)', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();

    await publish('org.tenant.created', {
      orgId: tenantId,
      slug: 'acme',
      name: 'Acme',
      parentId: crypto.randomUUID(),
    });
    await runOnceUntilHandled(c);
    await publish('org.domain.added', {
      domainId: crypto.randomUUID(),
      fqdn: 'acme.platform.test',
      scope: 'tenant',
      ownerId: tenantId,
    });
    await runOnceUntilHandled(c);
    h.mi.calls.length = 0;

    await publish('org.tenant.suspended', { orgId: tenantId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(await h.opensipsProjection.listDomains()).toEqual([]);
    expect(h.mi.calls).toContain('domain_reload');
    const tenant = await h.readModel.findTenant(h.db.kysely, tenantId);
    expect(tenant?.status).toBe('suspended');
  });

  it('resuming a suspended tenant re-projects its domain', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();

    await publish('org.tenant.created', {
      orgId: tenantId,
      slug: 'acme',
      name: 'Acme',
      parentId: crypto.randomUUID(),
    });
    await runOnceUntilHandled(c);
    await publish('org.domain.added', {
      domainId: crypto.randomUUID(),
      fqdn: 'acme.platform.test',
      scope: 'tenant',
      ownerId: tenantId,
    });
    await runOnceUntilHandled(c);
    await publish('org.tenant.suspended', { orgId: tenantId });
    await runOnceUntilHandled(c);

    await publish('org.tenant.resumed', { orgId: tenantId });
    const pass = await runOnceUntilHandled(c);
    expect(pass.handled).toBeGreaterThanOrEqual(1);

    expect(await h.opensipsProjection.listDomains()).toContain('acme.platform.test');
    const tenant = await h.readModel.findTenant(h.db.kysely, tenantId);
    expect(tenant?.status).toBe('active');
    // Four sequential publish+handle round trips, each up to 3 x 5s pullTimeout
    // attempts under load — the shared 20s default is too tight here.
  }, 40000);

  it('redelivery does not re-project twice (dedupe via consumed_events)', async () => {
    const c = consumer();
    await c.ensure();
    const tenantId = crypto.randomUUID();

    await publish('org.tenant.created', {
      orgId: tenantId,
      slug: 'acme',
      name: 'Acme',
      parentId: crypto.randomUUID(),
    });
    const first = await runOnceUntilHandled(c);
    expect(first.handled).toBeGreaterThanOrEqual(1);

    const second = await c.runOnce();
    expect(second.handled).toBe(0);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { natsOrSkipReason, databaseOrSkipReason } from '@cuc/testing';

import { createDomainConsumer } from '../src/consumers/domain.consumer.js';
import { computeSipDigest } from '../src/domain/sip-credentials.js';
import { pbxEvents } from '../src/events.js';
import { resetSchema, startBusHarness, type BusHarness } from './harness.js';
import type { EventConsumer } from '@cuc/events';

const skipReason = (await databaseOrSkipReason()) ?? (await natsOrSkipReason());

/**
 * `runOnce()` already long-polls for up to its own `pullTimeoutMs` (1s
 * default), but a machine running many concurrent test suites against one
 * shared NATS server (this whole workspace's CI-style run, for instance) can
 * starve that window before the just-published message is even visible to
 * the fetch. Retrying a few more empty passes is still exercising the real
 * pull-consumer path — nothing here fakes a message being handled.
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

/**
 * The S1-09 acceptance criterion: "HA1 recomputes when the tenant domain
 * changes." Drives the whole pipeline for real — a JetStream `ORG` stream,
 * this service's own consumer, and the repo's recompute logic — from a
 * directly published `org.domain.added` envelope, since org-service is a
 * separate service this suite does not stand up.
 */
describe.skipIf(skipReason !== undefined)('domain consumer (org.domain.added)', () => {
  let h: BusHarness;

  beforeAll(async () => {
    h = await startBusHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
    await h.bus.jsm.streams.purge('ORG');
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  /** Returns the published envelope's own id, for a dedupe check that names it exactly. */
  async function publishDomainAdded(fields: {
    fqdn: string;
    scope: 'tenant' | 'reseller_base';
    ownerId: string;
  }): Promise<string> {
    const contract = pbxEvents.contract('org.domain.added');
    const data = { domainId: crypto.randomUUID(), ...fields };
    pbxEvents.assertPayload('org.domain.added', data);
    const id = crypto.randomUUID();
    await h.bus.publish({
      id,
      type: 'org.domain.added',
      schemaVersion: contract.schemaVersion,
      occurredAt: new Date().toISOString(),
      orgContext: fields.scope === 'tenant' ? { tenantId: fields.ownerId } : {},
      data,
    });
    return id;
  }

  it("recomputes a tenant's SIP credentials when its primary domain changes", async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'old.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
    });
    const before = await h.extensions.reveal(ctxFor(tenantId), created.id);

    const consumer = createDomainConsumer(h.db, h.bus, h.logger, h.extensions, {
      pullTimeoutMs: 5000,
    });
    await consumer.ensure();

    await publishDomainAdded({ fqdn: 'new.platform.test', scope: 'tenant', ownerId: tenantId });
    const pass = await runOnceUntilHandled(consumer);

    // >=1, not ===1: this suite shares its JetStream server's ORG stream
    // (`TEST_NATS_URL`, when set — see `@cuc/testing`'s own nats.ts) with any
    // other package's consumer tests running concurrently (S1-12 added
    // telephony-config's own `org.domain.added` consumer test), so a stray
    // unrelated event can land in the same pull batch. It never affects this
    // tenant's own outcome, asserted below.
    expect(pass.handled).toBeGreaterThanOrEqual(1);
    expect(pass.failed).toBe(0);

    const after = await h.extensions.reveal(ctxFor(tenantId), created.id);
    expect(after.realm).toBe('new.platform.test');
    expect(after.password).toBe(before.password);

    const expected = computeSipDigest('101', 'new.platform.test', before.password);
    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.ha1).toBe(expected.ha1);
    expect(row.ha1b).toBe(expected.ha1b);
  });

  it('ignores a reseller base-domain event — nothing to recompute', async () => {
    const consumer = createDomainConsumer(h.db, h.bus, h.logger, h.extensions, {
      pullTimeoutMs: 5000,
    });
    await consumer.ensure();

    await publishDomainAdded({
      fqdn: 'voice.reseller-brand.com',
      scope: 'reseller_base',
      ownerId: crypto.randomUUID(),
    });
    const pass = await runOnceUntilHandled(consumer);

    expect(pass.handled).toBeGreaterThanOrEqual(1);
    expect(pass.failed).toBe(0);
  });

  it('redelivery does not recompute twice (dedupe via consumed_events)', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'old.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
    });

    const consumer = createDomainConsumer(h.db, h.bus, h.logger, h.extensions, {
      pullTimeoutMs: 5000,
    });
    await consumer.ensure();

    const eventId = await publishDomainAdded({
      fqdn: 'new.platform.test',
      scope: 'tenant',
      ownerId: tenantId,
    });
    const first = await runOnceUntilHandled(consumer);
    expect(first.handled).toBeGreaterThanOrEqual(1);

    // A second pass — not asserted empty: this suite's ORG stream is shared
    // with any other package's own consumer tests running concurrently
    // (G-17, docs/decisions.md), which can leave a stray unrelated event for
    // it to find. What actually proves dedupe is that *our own* event was
    // recorded exactly once — `consumed_events.id` is its primary key, so a
    // second insert for it would collide and roll back the whole handler
    // (`@cuc/events`' whole mechanism), never silently recompute twice.
    await consumer.runOnce();
    const consumedRows = await h.db.kysely
      .selectFrom('consumed_events')
      .select('id')
      .where('id', '=', eventId)
      .execute();
    expect(consumedRows).toHaveLength(1);

    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.realm).toBe('new.platform.test');
  });
});

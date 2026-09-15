import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { createReconciler } from '../src/reconcile.js';
import { resetOpenSipsSchema, resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('reconciler', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    await resetOpenSipsSchema(h.opensipsDb);
    h.mi.calls.length = 0;
  });

  function reconciler() {
    return createReconciler(h.readModel, h.opensipsProjection, h.mi, h.logger);
  }

  it('reports no drift and calls no MI reload when everything already matches', async () => {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
    await h.readModel.upsertDomain(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      fqdn: 'acme.platform.test',
    });
    await h.opensipsProjection.upsertDomain('acme.platform.test');

    const report = await reconciler().reconcileOnce();
    expect(report).toEqual({
      domainsAdded: 0,
      domainsRemoved: 0,
      subscribersAdded: 0,
      subscribersRemoved: 0,
    });
    expect(h.mi.calls).toEqual([]);
  });

  it('adds a missing domain projection and reloads', async () => {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
    await h.readModel.upsertDomain(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      fqdn: 'acme.platform.test',
    });

    const report = await reconciler().reconcileOnce();
    expect(report.domainsAdded).toBe(1);
    expect(await h.opensipsProjection.listDomains()).toContain('acme.platform.test');
    expect(h.mi.calls).toContain('domain_reload');
  });

  it("removes an orphaned domain projection (e.g. a tenant that is suspended, or doesn't exist)", async () => {
    await h.opensipsProjection.upsertDomain('orphan.platform.test');

    const report = await reconciler().reconcileOnce();
    expect(report.domainsRemoved).toBe(1);
    expect(await h.opensipsProjection.listDomains()).toEqual([]);
  });

  it("removes a suspended tenant's domain projection", async () => {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'suspended' });
    await h.readModel.upsertDomain(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      fqdn: 'suspended.platform.test',
    });
    await h.opensipsProjection.upsertDomain('suspended.platform.test');

    const report = await reconciler().reconcileOnce();
    expect(report.domainsRemoved).toBe(1);
    expect(await h.opensipsProjection.listDomains()).toEqual([]);
  });

  it('adds a missing subscriber projection without an MI reload (auth_db is uncached)', async () => {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertExtension(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      number: '101',
      username: '101',
      ha1: 'a'.repeat(32),
      realm: 'acme.platform.test',
    });

    const report = await reconciler().reconcileOnce();
    expect(report.subscribersAdded).toBe(1);
    expect(await h.opensipsProjection.listSubscribers()).toEqual([
      { username: '101', domain: 'acme.platform.test' },
    ]);
    expect(h.mi.calls).toEqual([]);
  });

  it('removes an orphaned subscriber projection', async () => {
    await h.opensipsProjection.upsertSubscriber('999', 'gone.platform.test', 'f'.repeat(32));

    const report = await reconciler().reconcileOnce();
    expect(report.subscribersRemoved).toBe(1);
    expect(await h.opensipsProjection.listSubscribers()).toEqual([]);
  });
});

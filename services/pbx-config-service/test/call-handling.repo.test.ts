import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidCallHandlingError, DEFAULT_CALL_HANDLING } from '../src/domain/call-handling.js';
import { CallHandlingExtensionNotFoundError } from '../src/repo/call-handling.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('call handling repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
  });

  const ctx = (tenantId: string) => ({ tenantId });

  async function makeExtension(tenantId: string, number: string) {
    h.domains.realms[tenantId] = `${tenantId}.platform.test`;
    const location = await h.emergencyLocations.create(ctx(tenantId), {
      label: 'HQ',
      addressLine1: '1 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });
    return h.extensions.create(ctx(tenantId), {
      number,
      displayName: `Ext ${number}`,
      emergencyLocationId: location.id,
    });
  }

  it('returns the all-off default until something is saved', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    expect(await h.callHandling.get(ctx(tenantId), a.id)).toEqual(DEFAULT_CALL_HANDLING);
    expect(await h.callHandling.find(ctx(tenantId), a.id)).toBeUndefined();
  });

  it('saves, replaces (not merges) and reads back a document, with one outbox event per save', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const b = await makeExtension(tenantId, '102');

    const saved = await h.callHandling.put(ctx(tenantId), a.id, {
      dnd: true,
      dndAction: 'busy',
      forwardAlways: { type: 'extension', extensionId: b.id },
      forwardNoAnswer: { type: 'external', e164: '+14155552671' },
      noAnswerSeconds: 25,
      simultaneousRing: [{ type: 'external', e164: '+14155552672' }],
    });
    expect(await h.callHandling.get(ctx(tenantId), a.id)).toEqual(saved);
    expect(saved.simultaneousRing).toEqual([{ type: 'external', e164: '+14155552672' }]);

    // PUT replaces: fields left out go back to off.
    await h.callHandling.put(ctx(tenantId), a.id, { forwardBusy: { type: 'voicemail' } });
    const replaced = await h.callHandling.get(ctx(tenantId), a.id);
    expect(replaced).toEqual({ ...DEFAULT_CALL_HANDLING, forwardBusy: { type: 'voicemail' } });

    const events = await h.db.kysely.selectFrom('outbox').selectAll().execute();
    const mine = events.filter((e) => e.type === 'pbx.call_handling.updated');
    expect(mine).toHaveLength(2);
    // One row per extension, however many saves.
    const rows = await h.db.kysely.selectFrom('extension_call_handling').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.version).toBe(2);
    expect(rows[0]?.tenant_id).toBe(tenantId);
  });

  it("404s another tenant's extension for read and write, and writes nothing", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = await makeExtension(tenantA, '101');
    await makeExtension(tenantB, '101');

    await expect(h.callHandling.get(ctx(tenantB), a.id)).rejects.toBeInstanceOf(
      CallHandlingExtensionNotFoundError,
    );
    await expect(h.callHandling.put(ctx(tenantB), a.id, { dnd: true })).rejects.toBeInstanceOf(
      CallHandlingExtensionNotFoundError,
    );
    expect(await h.db.kysely.selectFrom('extension_call_handling').selectAll().execute()).toEqual(
      [],
    );
  });

  it('refuses a destination extension from another tenant or that does not exist', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = await makeExtension(tenantA, '101');
    const foreign = await makeExtension(tenantB, '101');

    await expect(
      h.callHandling.put(ctx(tenantA), a.id, {
        forwardAlways: { type: 'extension', extensionId: foreign.id },
      }),
    ).rejects.toThrow(/does not exist in this tenant/);
    await expect(
      h.callHandling.put(ctx(tenantA), a.id, {
        forwardBusy: { type: 'voicemail', extensionId: foreign.id },
      }),
    ).rejects.toBeInstanceOf(InvalidCallHandlingError);
    await expect(
      h.callHandling.put(ctx(tenantA), a.id, {
        simultaneousRing: [{ type: 'extension', extensionId: 'nope' }],
      }),
    ).rejects.toBeInstanceOf(InvalidCallHandlingError);
  });

  it('refuses a forward-always chain that loops back, but allows a chain that does not', async () => {
    const tenantId = crypto.randomUUID();
    const a = await makeExtension(tenantId, '101');
    const b = await makeExtension(tenantId, '102');
    const c = await makeExtension(tenantId, '103');

    await h.callHandling.put(ctx(tenantId), b.id, {
      forwardAlways: { type: 'extension', extensionId: c.id },
    });
    await h.callHandling.put(ctx(tenantId), c.id, {
      forwardAlways: { type: 'extension', extensionId: a.id },
    });
    await expect(
      h.callHandling.put(ctx(tenantId), a.id, {
        forwardAlways: { type: 'extension', extensionId: b.id },
      }),
    ).rejects.toThrow(/loop/);
    // The other conditional forwards are not chained at call time, so they may point back.
    await h.callHandling.put(ctx(tenantId), a.id, {
      forwardBusy: { type: 'extension', extensionId: b.id },
    });
  });

  it("lists a tenant's configured extensions only, and deleting the extension removes its row", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const a = await makeExtension(tenantA, '101');
    const b = await makeExtension(tenantB, '101');
    await h.callHandling.put(ctx(tenantA), a.id, { dnd: true });
    await h.callHandling.put(ctx(tenantB), b.id, { dnd: true });

    expect((await h.callHandling.listForTenant(ctx(tenantA))).map((r) => r.extensionId)).toEqual([
      a.id,
    ]);

    await h.extensions.remove(ctx(tenantA), a.id);
    expect(await h.callHandling.listForTenant(ctx(tenantA))).toEqual([]);
    expect(await h.callHandling.listForTenant(ctx(tenantB))).toHaveLength(1);
  });
});

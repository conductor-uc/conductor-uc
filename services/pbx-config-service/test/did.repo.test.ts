import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason } from '@cuc/testing';

import { InvalidE164Error } from '../src/domain/dids.js';
import {
  DidNotFoundError,
  DidNumberTakenError,
  ExtensionDestinationNotFoundError,
  TrunkNotFoundError,
} from '../src/repo/did.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('DID repo', () => {
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
    h.trunks.known.clear();
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  async function seedExtension(tenantId: string, number = '101') {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    return h.extensions.create(ctxFor(tenantId), { number, displayName: 'Front Desk' });
  }

  it('creates a DID bound to a trunk and an extension', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    const extension = await seedExtension(tenantId);

    const created = await h.dids.create(ctxFor(tenantId), {
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId: extension.id,
    });

    expect(created).toMatchObject({
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId: extension.id,
    });
  });

  it('rejects a malformed E.164 number', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    const extension = await seedExtension(tenantId);

    await expect(
      h.dids.create(ctxFor(tenantId), {
        e164: '5551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extension.id,
      }),
    ).rejects.toThrow(InvalidE164Error);
  });

  it('rejects a trunk that does not exist in this tenant', async () => {
    const tenantId = crypto.randomUUID();
    const extension = await seedExtension(tenantId);

    await expect(
      h.dids.create(ctxFor(tenantId), {
        e164: '+15551234567',
        trunkId: crypto.randomUUID(),
        destinationType: 'extension',
        destinationId: extension.id,
      }),
    ).rejects.toThrow(TrunkNotFoundError);
  });

  it('rejects an extension destination that does not exist in this tenant', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);

    await expect(
      h.dids.create(ctxFor(tenantId), {
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(ExtensionDestinationNotFoundError);
  });

  it('allows a non-extension destination with no referential check yet (docs/decisions.md G-25)', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);

    const created = await h.dids.create(ctxFor(tenantId), {
      e164: '+15551234567',
      trunkId,
      destinationType: 'ring_group',
      destinationId: crypto.randomUUID(),
    });
    expect(created.destinationType).toBe('ring_group');
  });

  it('409s a globally duplicate E.164 number, even across tenants', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    const trunkA = crypto.randomUUID();
    const trunkB = crypto.randomUUID();
    h.trunks.known.add(`${tenantA}:${trunkA}`);
    h.trunks.known.add(`${tenantB}:${trunkB}`);
    const extensionA = await seedExtension(tenantA);
    const extensionB = await seedExtension(tenantB);

    await h.dids.create(ctxFor(tenantA), {
      e164: '+15551234567',
      trunkId: trunkA,
      destinationType: 'extension',
      destinationId: extensionA.id,
    });

    await expect(
      h.dids.create(ctxFor(tenantB), {
        e164: '+15551234567',
        trunkId: trunkB,
        destinationType: 'extension',
        destinationId: extensionB.id,
      }),
    ).rejects.toThrow(DidNumberTakenError);
  });

  it('updates a DID to a different trunk', async () => {
    const tenantId = crypto.randomUUID();
    const trunkA = crypto.randomUUID();
    const trunkB = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkA}`);
    h.trunks.known.add(`${tenantId}:${trunkB}`);
    const extension = await seedExtension(tenantId);
    const created = await h.dids.create(ctxFor(tenantId), {
      e164: '+15551234567',
      trunkId: trunkA,
      destinationType: 'extension',
      destinationId: extension.id,
    });

    const updated = await h.dids.update(ctxFor(tenantId), created.id, { trunkId: trunkB });
    expect(updated.trunkId).toBe(trunkB);
  });

  it('removes a DID', async () => {
    const tenantId = crypto.randomUUID();
    const trunkId = crypto.randomUUID();
    h.trunks.known.add(`${tenantId}:${trunkId}`);
    const extension = await seedExtension(tenantId);
    const created = await h.dids.create(ctxFor(tenantId), {
      e164: '+15551234567',
      trunkId,
      destinationType: 'extension',
      destinationId: extension.id,
    });

    await h.dids.remove(ctxFor(tenantId), created.id);
    await expect(h.dids.findById(ctxFor(tenantId), created.id)).resolves.toBeUndefined();
  });

  it('404s removing a DID that does not exist', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.dids.remove(ctxFor(tenantId), crypto.randomUUID())).rejects.toThrow(
      DidNotFoundError,
    );
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe. A DID
  // is globally unique on `e164` alone, but every read still goes through
  // `scoped(ctx)` — this is exactly what makes tenant B's DID invisible to a
  // lookup scoped to tenant A, the behavior the from-trunk dialplan lookup
  // (telephony-config, S2-03) depends on for "a DID owned by tenant B that
  // arrives on tenant A's trunk is rejected".
  crossTenantProbe({
    name: 'dids',
    seed: async (tenantId) => {
      const trunkId = crypto.randomUUID();
      h.trunks.known.add(`${tenantId}:${trunkId}`);
      const extension = await seedExtension(tenantId, '101');
      // A DID is globally unique (`dids_e164_idx`) — a fresh random number
      // per call, not derived from `tenantId` (whose hex digits include
      // a-f, not valid E.164 digits).
      const created = await h.dids.create(ctxFor(tenantId), {
        e164: `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`,
        trunkId,
        destinationType: 'extension',
        destinationId: extension.id,
      });
      return created.id;
    },
    list: (tenantId) => h.dids.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.dids.findById(ctxFor(tenantId), id),
    update: (tenantId, id) =>
      h.dids
        .update(ctxFor(tenantId), id, {})
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof DidNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.dids
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof DidNotFoundError) return 0;
          throw error;
        }),
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import {
  EmergencyLocationNotFoundError,
  ExtensionNotFoundError,
  ExtensionNumberTakenError,
  TenantDomainNotFoundError,
} from '../src/repo/extension.repo.js';
import { computeSipDigest } from '../src/domain/sip-credentials.js';
import { InvalidExtensionNumberError } from '../src/domain/numbering.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('extension repo', () => {
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

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  it('creates an extension with generated SIP credentials', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';

    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    expect(created).toMatchObject({ number: '101', displayName: 'Front Desk', userId: null });

    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.username).toBe('101');
    expect(row.realm).toBe('tenant-a.platform.test');
    expect(row.ha1).toMatch(/^[0-9a-f]{32}$/);
    expect(row.ha1b).toMatch(/^[0-9a-f]{32}$/);
  });

  it('never stores the SIP password in the clear', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();

    expect(row.secret_enc).not.toContain('password');
    // Envelope-encrypted values carry no plaintext substring an attacker with
    // read access to the row could recognise or brute-force offline against.
    const revealed = await h.extensions.reveal(ctxFor(tenantId), created.id);
    expect(row.secret_enc).not.toContain(revealed.password);
  });

  it("the revealed credential's HA1 matches what OpenSIPs would compute", async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    const revealed = await h.extensions.reveal(ctxFor(tenantId), created.id);
    const expected = computeSipDigest(revealed.username, revealed.realm, revealed.password);

    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.ha1).toBe(expected.ha1);
    expect(row.ha1b).toBe(expected.ha1b);
  });

  it('rejects a number already used in the same tenant', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'A',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    await expect(
      h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'B',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      }),
    ).rejects.toThrow(ExtensionNumberTakenError);
  });

  it('allows the same number in two different tenants', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    h.domains.realms[tenantA] = 'a.platform.test';
    h.domains.realms[tenantB] = 'b.platform.test';

    await h.extensions.create(ctxFor(tenantA), {
      number: '101',
      displayName: 'A',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantA), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });
    await expect(
      h.extensions.create(ctxFor(tenantB), {
        number: '101',
        displayName: 'B',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantB), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      }),
    ).resolves.toMatchObject({ number: '101' });
  });

  it('rejects a malformed number before touching the database', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.extensions.create(ctxFor(tenantId), {
        number: 'abc',
        displayName: 'A',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      }),
    ).rejects.toThrow(InvalidExtensionNumberError);
  });

  it('refuses to create credentials when the tenant has no primary domain', async () => {
    const tenantId = crypto.randomUUID();
    await expect(
      h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'A',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      }),
    ).rejects.toThrow(TenantDomainNotFoundError);
  });

  // G-1/issue #96: "an extension cannot be created without a dispatchable location."
  it('refuses to create an extension with no such emergency location', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    await expect(
      h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'A',
        emergencyLocationId: crypto.randomUUID(),
      }),
    ).rejects.toThrow(EmergencyLocationNotFoundError);
  });

  it("refuses to create an extension with another tenant's emergency location", async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    h.domains.realms[tenantA] = 'tenant-a.platform.test';
    const locationB = await h.emergencyLocations.create(ctxFor(tenantB), {
      label: 'Test Location',
      addressLine1: '123 Main St',
      city: 'Springfield',
      state: 'IL',
      postalCode: '62701',
      country: 'US',
    });

    await expect(
      h.extensions.create(ctxFor(tenantA), {
        number: '101',
        displayName: 'A',
        emergencyLocationId: locationB.id,
      }),
    ).rejects.toThrow(EmergencyLocationNotFoundError);
  });

  it('updates display fields without touching SIP credentials', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });
    const before = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();

    const updated = await h.extensions.update(ctxFor(tenantId), created.id, {
      displayName: 'Lobby',
      voicemailEnabled: true,
    });

    expect(updated).toMatchObject({ displayName: 'Lobby', voicemailEnabled: true, number: '101' });
    const after = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(after).toEqual(before);
  });

  it('updating the number does not change the stored SIP username', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    await h.extensions.update(ctxFor(tenantId), created.id, { number: '102' });

    const row = await h.db.kysely
      .selectFrom('sip_credentials')
      .selectAll()
      .where('extension_id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.username).toBe('101');
  });

  it('404s an update for a nonexistent extension', async () => {
    await expect(
      h.extensions.update(ctxFor(crypto.randomUUID()), crypto.randomUUID(), {
        displayName: 'X',
      }),
    ).rejects.toThrow(ExtensionNotFoundError);
  });

  it('deletes an extension and its SIP credentials together', async () => {
    const tenantId = crypto.randomUUID();
    h.domains.realms[tenantId] = 'tenant-a.platform.test';
    const created = await h.extensions.create(ctxFor(tenantId), {
      number: '101',
      displayName: 'Front Desk',
      emergencyLocationId: (
        await h.emergencyLocations.create(ctxFor(tenantId), {
          label: 'Test Location',
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        })
      ).id,
    });

    await h.extensions.remove(ctxFor(tenantId), created.id);

    expect(await h.extensions.findById(ctxFor(tenantId), created.id)).toBeUndefined();
    expect(
      await h.db.kysely
        .selectFrom('sip_credentials')
        .selectAll()
        .where('extension_id', '=', created.id)
        .executeTakeFirst(),
    ).toBeUndefined();
  });

  it('404s deleting a nonexistent extension', async () => {
    await expect(
      h.extensions.remove(ctxFor(crypto.randomUUID()), crypto.randomUUID()),
    ).rejects.toThrow(ExtensionNotFoundError);
  });

  describe('recomputeForDomainChange', () => {
    it('recomputes HA1/HA1B under the new realm, keeping the password unchanged', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'old.platform.test';
      const created = await h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'Front Desk',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      });
      const before = await h.extensions.reveal(ctxFor(tenantId), created.id);

      await h.db.kysely.transaction().execute(async (trx) => {
        const recomputed = await h.extensions.recomputeForDomainChange(
          trx,
          tenantId,
          'new.platform.test',
        );
        expect(recomputed).toBe(1);
      });

      const after = await h.extensions.reveal(ctxFor(tenantId), created.id);
      expect(after.password).toBe(before.password);
      expect(after.realm).toBe('new.platform.test');

      const row = await h.db.kysely
        .selectFrom('sip_credentials')
        .selectAll()
        .where('extension_id', '=', created.id)
        .executeTakeFirstOrThrow();
      const expected = computeSipDigest('101', 'new.platform.test', before.password);
      expect(row.ha1).toBe(expected.ha1);
      expect(row.ha1b).toBe(expected.ha1b);
    });

    it('does not touch another tenant’s credentials', async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      h.domains.realms[tenantA] = 'a.platform.test';
      h.domains.realms[tenantB] = 'b.platform.test';
      await h.extensions.create(ctxFor(tenantA), {
        number: '101',
        displayName: 'A',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantA), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      });
      const extB = await h.extensions.create(ctxFor(tenantB), {
        number: '101',
        displayName: 'B',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantB), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      });

      await h.db.kysely
        .transaction()
        .execute((trx) => h.extensions.recomputeForDomainChange(trx, tenantA, 'a2.platform.test'));

      const rowB = await h.db.kysely
        .selectFrom('sip_credentials')
        .selectAll()
        .where('extension_id', '=', extB.id)
        .executeTakeFirstOrThrow();
      expect(rowB.realm).toBe('b.platform.test');
    });

    it('is a no-op when the realm has not actually changed', async () => {
      const tenantId = crypto.randomUUID();
      h.domains.realms[tenantId] = 'tenant-a.platform.test';
      await h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'A',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      });

      const recomputed = await h.db.kysely
        .transaction()
        .execute((trx) =>
          h.extensions.recomputeForDomainChange(trx, tenantId, 'tenant-a.platform.test'),
        );
      expect(recomputed).toBe(0);
    });
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'extensions',
    seed: async (tenantId) => {
      h.domains.realms[tenantId] = `${tenantId}.platform.test`;
      const created = await h.extensions.create(ctxFor(tenantId), {
        number: '101',
        displayName: 'Probe',
        emergencyLocationId: (
          await h.emergencyLocations.create(ctxFor(tenantId), {
            label: 'Test Location',
            addressLine1: '123 Main St',
            city: 'Springfield',
            state: 'IL',
            postalCode: '62701',
            country: 'US',
          })
        ).id,
      });
      return created.id;
    },
    list: (tenantId) => h.extensions.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.extensions.findById(ctxFor(tenantId), id),
    update: (tenantId, id) =>
      h.extensions
        .update(ctxFor(tenantId), id, { displayName: 'Probed' })
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof ExtensionNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.extensions
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof ExtensionNotFoundError) return 0;
          throw error;
        }),
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason } from '@cuc/testing';

import {
  TenantResellerNotFoundError,
  TrunkHasNoCredentialError,
  TrunkIpNotFoundError,
  TrunkNameTakenError,
  TrunkNotFoundError,
} from '../src/repo/trunk.repo.js';
import { InvalidTrunkConfigError } from '../src/domain/trunk.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

describe.skipIf(skipReason !== undefined)('trunk repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.resellers.resellerIds = {};
  });

  function ctxFor(tenantId: string) {
    return { tenantId };
  }

  const baseInput = {
    name: 'Primary carrier',
    authMode: 'register' as const,
    host: 'sip.carrier.test',
    port: 5060,
    transport: 'udp',
    username: 'trunkuser',
    secret: 's3cret-password',
    fromDomain: 'acme.platform.test',
    codecs: ['PCMU', 'PCMA'],
  };

  // `exactOptionalPropertyTypes` rejects `username: undefined` — this omits
  // the credential fields entirely rather than setting them to `undefined`.
  const ipModeInput = {
    name: 'Primary carrier',
    authMode: 'ip' as const,
    host: 'sip.carrier.test',
    port: 5060,
    transport: 'udp',
    fromDomain: 'acme.platform.test',
    codecs: ['PCMU', 'PCMA'],
  };

  it('creates a register-mode trunk with an encrypted secret', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';

    const created = await h.trunks.create(ctxFor(tenantId), baseInput);

    expect(created).toMatchObject({
      name: 'Primary carrier',
      authMode: 'register',
      username: 'trunkuser',
      codecs: ['PCMU', 'PCMA'],
      resellerId: 'reseller-a',
    });

    const row = await h.db.kysely
      .selectFrom('trunks')
      .selectAll()
      .where('id', '=', created.id)
      .executeTakeFirstOrThrow();
    expect(row.secret_enc).not.toBeNull();
    expect(row.secret_enc).not.toContain('s3cret-password');
  });

  it('creates an ip-mode trunk with no credential', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';

    const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);

    expect(created.username).toBeNull();
  });

  it('rejects register mode with no username/secret', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';

    await expect(
      h.trunks.create(ctxFor(tenantId), { ...ipModeInput, authMode: 'register' }),
    ).rejects.toThrow(InvalidTrunkConfigError);
  });

  it('refuses to create a trunk when the tenant has no owning reseller', async () => {
    const tenantId = crypto.randomUUID();
    await expect(h.trunks.create(ctxFor(tenantId), baseInput)).rejects.toThrow(
      TenantResellerNotFoundError,
    );
  });

  it('rejects a name already used in the same tenant', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    await h.trunks.create(ctxFor(tenantId), baseInput);

    await expect(h.trunks.create(ctxFor(tenantId), baseInput)).rejects.toThrow(TrunkNameTakenError);
  });

  it('allows the same name in two different tenants', async () => {
    const tenantA = crypto.randomUUID();
    const tenantB = crypto.randomUUID();
    h.resellers.resellerIds[tenantA] = 'reseller-a';
    h.resellers.resellerIds[tenantB] = 'reseller-b';

    await h.trunks.create(ctxFor(tenantA), baseInput);
    await expect(h.trunks.create(ctxFor(tenantB), baseInput)).resolves.toMatchObject({
      name: baseInput.name,
    });
  });

  it("reveal returns the register secret and matches the HA1-style precedent of never storing it in the clear", async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), baseInput);

    const revealed = await h.trunks.reveal(ctxFor(tenantId), created.id);
    expect(revealed).toEqual({ username: 'trunkuser', secret: 's3cret-password' });
  });

  it('reveal 409s a trunk with no credential', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);

    await expect(h.trunks.reveal(ctxFor(tenantId), created.id)).rejects.toThrow(
      TrunkHasNoCredentialError,
    );
  });

  it('updates fields and rotates the secret', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), baseInput);

    const updated = await h.trunks.update(ctxFor(tenantId), created.id, {
      maxChannels: 10,
      secret: 'new-secret',
    });

    expect(updated.maxChannels).toBe(10);
    const revealed = await h.trunks.reveal(ctxFor(tenantId), created.id);
    expect(revealed.secret).toBe('new-secret');
  });

  it('leaves the secret untouched when omitted from an update', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), baseInput);

    await h.trunks.update(ctxFor(tenantId), created.id, { name: 'Renamed' });

    const revealed = await h.trunks.reveal(ctxFor(tenantId), created.id);
    expect(revealed.secret).toBe('s3cret-password');
  });

  it('rejects switching to ip mode while a credential is still set', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), baseInput);

    await expect(
      h.trunks.update(ctxFor(tenantId), created.id, { authMode: 'ip' }),
    ).rejects.toThrow(InvalidTrunkConfigError);
  });

  it('404s an update for a nonexistent trunk', async () => {
    await expect(
      h.trunks.update(ctxFor(crypto.randomUUID()), crypto.randomUUID(), { name: 'X' }),
    ).rejects.toThrow(TrunkNotFoundError);
  });

  it('deletes a trunk and its IPs together', async () => {
    const tenantId = crypto.randomUUID();
    h.resellers.resellerIds[tenantId] = 'reseller-a';
    const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);
    await h.trunks.addIp(ctxFor(tenantId), created.id, '203.0.113.0/24');

    await h.trunks.remove(ctxFor(tenantId), created.id);

    expect(await h.trunks.findById(ctxFor(tenantId), created.id)).toBeUndefined();
    expect(
      await h.db.kysely.selectFrom('trunk_ips').selectAll().where('trunk_id', '=', created.id).execute(),
    ).toEqual([]);
  });

  it('404s deleting a nonexistent trunk', async () => {
    await expect(h.trunks.remove(ctxFor(crypto.randomUUID()), crypto.randomUUID())).rejects.toThrow(
      TrunkNotFoundError,
    );
  });

  describe('trunk IPs', () => {
    it('adds and lists IPs for a trunk', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);

      await h.trunks.addIp(ctxFor(tenantId), created.id, '203.0.113.0/24');
      await h.trunks.addIp(ctxFor(tenantId), created.id, '198.51.100.5/32');

      const ips = await h.trunks.listIps(ctxFor(tenantId), created.id);
      expect(ips.map((ip) => ip.cidr).sort()).toEqual(['198.51.100.5/32', '203.0.113.0/24']);
    });

    it('404s adding an IP to a nonexistent trunk', async () => {
      const tenantId = crypto.randomUUID();
      await expect(
        h.trunks.addIp(ctxFor(tenantId), crypto.randomUUID(), '203.0.113.0/24'),
      ).rejects.toThrow(TrunkNotFoundError);
    });

    it('removes an IP', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);
      const ip = await h.trunks.addIp(ctxFor(tenantId), created.id, '203.0.113.0/24');

      await h.trunks.removeIp(ctxFor(tenantId), created.id, ip.id);

      expect(await h.trunks.listIps(ctxFor(tenantId), created.id)).toEqual([]);
    });

    it('404s removing a nonexistent IP', async () => {
      const tenantId = crypto.randomUUID();
      h.resellers.resellerIds[tenantId] = 'reseller-a';
      const created = await h.trunks.create(ctxFor(tenantId), ipModeInput);

      await expect(
        h.trunks.removeIp(ctxFor(tenantId), created.id, crypto.randomUUID()),
      ).rejects.toThrow(TrunkIpNotFoundError);
    });
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'trunks',
    seed: async (tenantId) => {
      h.resellers.resellerIds[tenantId] = crypto.randomUUID();
      const created = await h.trunks.create(ctxFor(tenantId), baseInput);
      return created.id;
    },
    list: (tenantId) => h.trunks.list(ctxFor(tenantId)),
    findById: (tenantId, id) => h.trunks.findById(ctxFor(tenantId), id),
    update: (tenantId, id) =>
      h.trunks
        .update(ctxFor(tenantId), id, { name: 'Probed' })
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof TrunkNotFoundError) return 0;
          throw error;
        }),
    remove: (tenantId, id) =>
      h.trunks
        .remove(ctxFor(tenantId), id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof TrunkNotFoundError) return 0;
          throw error;
        }),
  });
});

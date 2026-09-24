import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { InvalidMacError, tokenMatches } from '../src/domain/provisioning.js';
import {
  DeviceExtensionNotFoundError,
  DeviceMacTakenError,
  DeviceNotFoundError,
} from '../src/repo/device.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

describe.skipIf(skipReason !== undefined)('device repo', () => {
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

  async function seedExtension(tenantId: string, number = '101') {
    h.domains.realms[tenantId] ??= `${tenantId}.platform.test`;
    const locationId = (
      await h.emergencyLocations.create(
        { tenantId },
        {
          label: `Location ${number}`,
          addressLine1: '123 Main St',
          city: 'Springfield',
          state: 'IL',
          postalCode: '62701',
          country: 'US',
        },
      )
    ).id;
    return h.extensions.create(
      { tenantId },
      { number, displayName: `Ext ${number}`, emergencyLocationId: locationId },
    );
  }

  it('sets up a phone from a MAC in any common spelling, and lists it', async () => {
    const tenantId = crypto.randomUUID();
    const ext = await seedExtension(tenantId);

    const created = await h.devices.create(
      { tenantId },
      { extensionId: ext.id, mac: '00:15:65:AA:BB:CC', model: ' T46U ', label: '' },
    );

    expect(created).toMatchObject({
      extensionId: ext.id,
      vendor: 'yealink',
      mac: '001565aabbcc',
      model: 'T46U',
      label: null,
      provisioningIssued: false,
    });
    expect(await h.devices.list({ tenantId })).toHaveLength(1);
    expect((await h.devices.findById({ tenantId }, created.id))?.mac).toBe('001565aabbcc');
  });

  it('refuses a malformed MAC', async () => {
    const tenantId = crypto.randomUUID();
    const ext = await seedExtension(tenantId);
    await expect(
      h.devices.create({ tenantId }, { extensionId: ext.id, mac: 'not-a-mac' }),
    ).rejects.toBeInstanceOf(InvalidMacError);
  });

  it('will not use an extension from another tenant', async () => {
    const owner = crypto.randomUUID();
    const other = crypto.randomUUID();
    const ext = await seedExtension(owner);
    await expect(
      h.devices.create({ tenantId: other }, { extensionId: ext.id, mac: '001565aabbcc' }),
    ).rejects.toBeInstanceOf(DeviceExtensionNotFoundError);
  });

  it('keeps a MAC to one phone across every tenant, and the error does not say whose', async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const extA = await seedExtension(a);
    const extB = await seedExtension(b);
    await h.devices.create({ tenantId: a }, { extensionId: extA.id, mac: '001565aabbcc' });

    await expect(
      h.devices.create({ tenantId: a }, { extensionId: extA.id, mac: '00:15:65:aa:bb:cc' }),
    ).rejects.toBeInstanceOf(DeviceMacTakenError);
    await expect(
      h.devices.create({ tenantId: b }, { extensionId: extB.id, mac: '001565aabbcc' }),
    ).rejects.toBeInstanceOf(DeviceMacTakenError);
    expect(await h.devices.list({ tenantId: b })).toEqual([]);
  });

  it("never shows one tenant another's phones", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const extA = await seedExtension(a);
    const created = await h.devices.create(
      { tenantId: a },
      { extensionId: extA.id, mac: '001565aabbcc' },
    );

    expect(await h.devices.list({ tenantId: b })).toEqual([]);
    expect(await h.devices.findById({ tenantId: b }, created.id)).toBeUndefined();
    await expect(h.devices.remove({ tenantId: b }, created.id)).rejects.toBeInstanceOf(
      DeviceNotFoundError,
    );
    await expect(
      h.devices.issueProvisioningPassword({ tenantId: b }, created.id),
    ).rejects.toBeInstanceOf(DeviceNotFoundError);
  });

  it('issues a provisioning password once, stores only its hash, and replaces it when issued again', async () => {
    const tenantId = crypto.randomUUID();
    const ext = await seedExtension(tenantId);
    const device = await h.devices.create(
      { tenantId },
      { extensionId: ext.id, mac: '001565aabbcc' },
    );

    const first = await h.devices.issueProvisioningPassword({ tenantId }, device.id);
    expect(first.deviceId).toBe(device.id);
    const stored = await h.db.kysely
      .selectFrom('devices')
      .select('token_hash')
      .where('id', '=', device.id)
      .executeTakeFirstOrThrow();
    expect(stored.token_hash).not.toContain(first.password);
    expect(tokenMatches(stored.token_hash, first.password)).toBe(true);
    expect((await h.devices.findById({ tenantId }, device.id))?.provisioningIssued).toBe(true);

    const second = await h.devices.issueProvisioningPassword({ tenantId }, device.id);
    const target = await h.devices.findProvisioningTarget(device.id);
    expect(tokenMatches(target?.tokenHash ?? null, second.password)).toBe(true);
    expect(tokenMatches(target?.tokenHash ?? null, first.password)).toBe(false);
    expect(target).toMatchObject({ tenantId, extensionId: ext.id, mac: '001565aabbcc' });
  });

  it('changes the extension and notes, but never the MAC', async () => {
    const tenantId = crypto.randomUUID();
    const one = await seedExtension(tenantId, '101');
    const two = await seedExtension(tenantId, '102');
    const device = await h.devices.create(
      { tenantId },
      { extensionId: one.id, mac: '001565aabbcc' },
    );

    const updated = await h.devices.update({ tenantId }, device.id, {
      extensionId: two.id,
      label: 'Reception',
    });

    expect(updated).toMatchObject({ extensionId: two.id, label: 'Reception', mac: '001565aabbcc' });
    await expect(
      h.devices.update({ tenantId }, device.id, { extensionId: crypto.randomUUID() }),
    ).rejects.toBeInstanceOf(DeviceExtensionNotFoundError);
  });

  it('records when and from where a phone last fetched its settings', async () => {
    const tenantId = crypto.randomUUID();
    const ext = await seedExtension(tenantId);
    const device = await h.devices.create(
      { tenantId },
      { extensionId: ext.id, mac: '001565aabbcc' },
    );

    await h.devices.recordFetch({ tenantId }, device.id, {
      ip: '203.0.113.9',
      userAgent: 'Yealink SIP-T46U 108.86.0.30 00:15:65:aa:bb:cc',
    });

    const after = await h.devices.findById({ tenantId }, device.id);
    expect(after?.lastSeenIp).toBe('203.0.113.9');
    expect(after?.lastUserAgent).toContain('Yealink SIP-T46U');
    expect(after?.lastProvisionedAt).toBeInstanceOf(Date);
  });

  it('is removed with its extension, and does not stop the extension being deleted', async () => {
    const tenantId = crypto.randomUUID();
    const ext = await seedExtension(tenantId);
    await h.devices.create({ tenantId }, { extensionId: ext.id, mac: '001565aabbcc' });

    await h.extensions.remove({ tenantId }, ext.id);

    expect(await h.devices.list({ tenantId })).toEqual([]);
  });
});

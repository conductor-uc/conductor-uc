import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { EventEnvelope } from '@cuc/api-contracts';
import type { Bus } from '@cuc/events';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerDeviceRoutes } from '../src/routes/device.routes.js';
import { registerProvisionRoutes } from '../src/routes/provision.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';
const BASE_URL = 'https://api.platform.test';

function fakeBus(): Bus & { published: EventEnvelope[] } {
  const published: EventEnvelope[] = [];
  return {
    published,
    js: undefined as never,
    jsm: undefined as never,
    connection: undefined as never,
    publish: (envelope: EventEnvelope) => {
      published.push(envelope);
      return Promise.resolve({ sequence: published.length, duplicate: false });
    },
    ensureStreams: () => Promise.resolve(),
    ping: () => Promise.resolve(true),
    close: () => Promise.resolve(),
  };
}

const basic = (user: string, password: string) =>
  `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;

interface DeviceBody {
  id: string;
  extensionId: string;
  mac: string;
  provisioningIssued: boolean;
  lastProvisionedAt: string | null;
}
interface Credentials {
  url: string | null;
  username: string;
  password: string;
  urlWithCredentials: string | null;
}

describe.skipIf(skipReason !== undefined)('devices and provisioning HTTP routes', () => {
  let h: Harness;
  let bus: ReturnType<typeof fakeBus>;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    bus = fakeBus();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerDeviceRoutes(app, h.devices, bus, { provisioningBaseUrl: BASE_URL });
    registerProvisionRoutes(app, h.devices, h.extensions, h.domains.lookup, {
      port: 5060,
      transports: ['udp', 'tcp'],
    });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.domains.realms = {};
    bus.published.length = 0;
  });

  function headers(tenantId: string) {
    return signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  async function seedExtension(tenantId: string, number = '101') {
    h.domains.realms[tenantId] ??= `${tenantId.slice(0, 8)}.voice.platform.test`;
    const location = await h.emergencyLocations.create(
      { tenantId },
      {
        label: `Location ${number}`,
        addressLine1: '123 Main St',
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      },
    );
    return h.extensions.create(
      { tenantId },
      { number, displayName: 'Front Desk', emergencyLocationId: location.id },
    );
  }

  async function createDevice(tenantId: string, extensionId: string, mac = '00:15:65:aa:bb:cc') {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/devices`,
      headers: headers(tenantId),
      payload: { extensionId, mac, model: 'T46U' },
    });
    expect(response.statusCode, response.body).toBe(201);
    return response.json<DeviceBody>();
  }

  async function issue(tenantId: string, deviceId: string) {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/devices/${deviceId}/provisioning-credentials`,
      headers: headers(tenantId),
      payload: { reason: 'setting up the front desk phone' },
    });
    expect(response.statusCode, response.body).toBe(200);
    return response.json<Credentials>();
  }

  describe('managing devices', () => {
    it('creates, lists, updates and deletes a phone', async () => {
      const tenantId = crypto.randomUUID();
      const one = await seedExtension(tenantId, '101');
      const two = await seedExtension(tenantId, '102');
      const created = await createDevice(tenantId, one.id);
      expect(created.mac).toBe('001565aabbcc');
      expect(created.provisioningIssued).toBe(false);

      const listed = await app.inject({
        method: 'GET',
        url: `/v1/tenants/${tenantId}/devices`,
        headers: headers(tenantId),
      });
      expect(listed.json<{ rows: DeviceBody[] }>().rows).toHaveLength(1);

      const patched = await app.inject({
        method: 'PATCH',
        url: `/v1/tenants/${tenantId}/devices/${created.id}`,
        headers: headers(tenantId),
        payload: { extensionId: two.id },
      });
      expect(patched.json<DeviceBody>().extensionId).toBe(two.id);

      const removed = await app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenantId}/devices/${created.id}`,
        headers: headers(tenantId),
      });
      expect(removed.statusCode).toBe(204);
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/v1/tenants/${tenantId}/devices/${created.id}`,
            headers: headers(tenantId),
          })
        ).statusCode,
      ).toBe(404);
    });

    it('answers a bad MAC with 400 and a taken one with the same 409 whoever has it', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await seedExtension(tenantId);
      const bad = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/devices`,
        headers: headers(tenantId),
        payload: { extensionId: ext.id, mac: 'nope' },
      });
      expect(bad.statusCode).toBe(400);

      await createDevice(tenantId, ext.id);
      const otherTenant = crypto.randomUUID();
      const otherExt = await seedExtension(otherTenant);
      const clash = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${otherTenant}/devices`,
        headers: headers(otherTenant),
        payload: { extensionId: otherExt.id, mac: '001565aabbcc' },
      });
      expect(clash.statusCode).toBe(409);
      expect(clash.json<{ code: string }>().code).toBe('device_mac_taken');
      expect(clash.body).not.toContain(tenantId);
    });
  });

  describe('POST .../provisioning-credentials', () => {
    it('returns the address and credentials, and publishes an audit event', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await seedExtension(tenantId);
      const device = await createDevice(tenantId, ext.id);
      bus.published.length = 0;

      const got = await issue(tenantId, device.id);

      expect(got.username).toBe(device.id);
      expect(got.password.length).toBeGreaterThan(30);
      expect(got.url).toBe(`${BASE_URL}/v1/public/provision/yealink/`);
      const embedded = new URL(got.urlWithCredentials ?? '');
      expect(embedded.username).toBe(device.id);
      expect(embedded.password).toBe(got.password);
      expect(bus.published[0]).toMatchObject({
        type: 'audit.event.recorded',
        data: {
          action: 'device.provisioning.issued',
          resource: device.id,
          dataClass: 'secret',
          targetOrgId: tenantId,
          reason: 'setting up the front desk phone',
        },
      });
    });

    it('needs an identified actor, and 404s for a phone that is not there', async () => {
      const tenantId = crypto.randomUUID();
      const ext = await seedExtension(tenantId);
      const device = await createDevice(tenantId, ext.id);
      const anonymous = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/devices/${device.id}/provisioning-credentials`,
        payload: {},
      });
      expect(anonymous.statusCode).toBe(401);
      expect((await h.devices.findById({ tenantId }, device.id))?.provisioningIssued).toBe(false);

      bus.published.length = 0;
      const missing = await app.inject({
        method: 'POST',
        url: `/v1/tenants/${tenantId}/devices/${crypto.randomUUID()}/provisioning-credentials`,
        headers: headers(tenantId),
        payload: {},
      });
      expect(missing.statusCode).toBe(404);
      expect(bus.published).toHaveLength(0);
    });
  });

  describe('GET /v1/public/provision/yealink/:file', () => {
    async function provisioned(mac = '00:15:65:aa:bb:cc') {
      const tenantId = crypto.randomUUID();
      const ext = await seedExtension(tenantId);
      const device = await createDevice(tenantId, ext.id, mac);
      const creds = await issue(tenantId, device.id);
      return { tenantId, ext, device, creds };
    }

    it("serves the phone's own settings, with the extension's real login", async () => {
      const { tenantId, ext, device, creds } = await provisioned();
      const secret = await h.extensions.reveal({ tenantId }, ext.id);

      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/001565aabbcc.cfg',
        headers: {
          authorization: basic(creds.username, creds.password),
          'user-agent': 'Yealink SIP-T46U 108.86.0.30 00:15:65:aa:bb:cc',
        },
      });

      expect(response.statusCode, response.body).toBe(200);
      expect(response.headers['content-type']).toContain('text/plain');
      const lines = response.body.split('\n');
      expect(lines[0]).toBe('#!version:1.0.0.1');
      expect(response.body).toContain('account.1.user_name = 101\n');
      expect(response.body).toContain(`account.1.password = ${secret.password}\n`);
      expect(response.body).toContain(
        `account.1.sip_server.1.address = ${h.domains.realms[tenantId] ?? ''}\n`,
      );
      expect(response.body).toContain('account.1.sip_server.1.port = 5060\n');
      expect(response.body).toContain('account.1.display_name = Front Desk\n');

      const after = await h.devices.findById({ tenantId }, device.id);
      expect(after?.lastProvisionedAt).toBeInstanceOf(Date);
      expect(after?.lastUserAgent).toContain('Yealink SIP-T46U');
    });

    it('follows a password reset: the phone gets the new one on its next fetch', async () => {
      const { tenantId, ext, creds } = await provisioned();
      const reset = await h.extensions.resetPassword({ tenantId }, ext.id);
      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/001565aabbcc.cfg',
        headers: { authorization: basic(creds.username, creds.password) },
      });
      expect(response.body).toContain(`account.1.password = ${reset.password}\n`);
    });

    it('answers the model-wide file with a valid file that sets nothing', async () => {
      const { creds } = await provisioned();
      const response = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/y000000000028.cfg',
        headers: { authorization: basic(creds.username, creds.password) },
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toBe('#!version:1.0.0.1\n');
    });

    it('asks for credentials, the same way, when they are missing, wrong, unknown or not yet issued', async () => {
      const { tenantId, ext, device, creds } = await provisioned();
      const notIssued = await createDevice(tenantId, ext.id, '001565000001');
      const attempts: (string | undefined)[] = [
        undefined,
        basic(creds.username, 'wrong'),
        basic(crypto.randomUUID(), creds.password),
        basic(notIssued.id, creds.password),
        `Bearer ${creds.password}`,
      ];
      for (const authorization of attempts) {
        const response = await app.inject({
          method: 'GET',
          url: '/v1/public/provision/yealink/001565aabbcc.cfg',
          headers: authorization === undefined ? {} : { authorization },
        });
        expect(response.statusCode).toBe(401);
        expect(response.headers['www-authenticate']).toBe('Basic realm="provisioning"');
        expect(response.body).toBe('Unauthorized\n');
      }
      expect(device.id).toBeDefined();
    });

    it("will not serve another phone's file, or one that is not a Yealink file", async () => {
      const { tenantId, ext, creds } = await provisioned();
      await createDevice(tenantId, ext.id, '001565000002');
      for (const file of ['001565000002.cfg', 'notes.txt', '001565aabbcc.boot']) {
        const response = await app.inject({
          method: 'GET',
          url: `/v1/public/provision/yealink/${file}`,
          headers: { authorization: basic(creds.username, creds.password) },
        });
        expect(response.statusCode, file).toBe(404);
        expect(response.body).not.toContain('account.1.password');
      }
    });

    it('stops working when the password is replaced, and when the phone is deleted', async () => {
      const { tenantId, device, creds } = await provisioned();
      const fresh = await issue(tenantId, device.id);
      const old = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/001565aabbcc.cfg',
        headers: { authorization: basic(creds.username, creds.password) },
      });
      expect(old.statusCode).toBe(401);
      const current = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/001565aabbcc.cfg',
        headers: { authorization: basic(fresh.username, fresh.password) },
      });
      expect(current.statusCode).toBe(200);

      await h.devices.remove({ tenantId }, device.id);
      const gone = await app.inject({
        method: 'GET',
        url: '/v1/public/provision/yealink/001565aabbcc.cfg',
        headers: { authorization: basic(fresh.username, fresh.password) },
      });
      expect(gone.statusCode).toBe(401);
    });
  });
});

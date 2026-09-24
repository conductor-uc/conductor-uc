import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import type { CallHandlingConfig } from '../src/domain/call-handling.js';
import { drTag } from '../src/repo/opensips-projection.repo.js';
import { registerFsRoutes } from '../src/routes/fs.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());
const TOKEN = 'test-fs-xml-curl-token';
const BASIC_AUTH = `Basic ${Buffer.from(`fs-node:${TOKEN}`).toString('base64')}`;
const DOMAIN = 'acme.platform.test';

const off: CallHandlingConfig = {
  dnd: false,
  dndAction: 'voicemail',
  forwardAlways: null,
  forwardBusy: null,
  forwardNoAnswer: null,
  noAnswerSeconds: 20,
  forwardUnreachable: null,
  simultaneousRing: [],
};

/**
 * `/fs/dialplan` for a call to an extension that has call handling: what each
 * setting resolves to, and that an external forward is an outbound call
 * (toll-fraud policy, outbound routes, caller ID, tenant attribution) rather
 * than a bridge that skips them.
 */
describe.skipIf(skipReason !== undefined)('/fs/dialplan with call handling (parity 1a)', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'telephony-config', logger: h.logger });
    registerFsRoutes(
      app,
      h.db,
      h.readModel,
      TOKEN,
      'opensips:5060',
      h.logger,
      h.orgClient,
      h.pbxConfig,
      h.storage,
      h.voicemail,
      h.redis,
      h.callflow,
      h.affinity,
      h.callControl,
      'http://telephony-config-test:8080',
    );
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    h.voicemail.mailboxes = {};
    h.orgClient.limits = {};
    h.orgClient.limitsFailFor.clear();
  });

  async function seedTenant(country = 'US'): Promise<string> {
    const tenantId = crypto.randomUUID();
    await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
    await h.readModel.upsertDomain(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      fqdn: DOMAIN,
    });
    await h.readModel.setTenantCountry(h.db.kysely, tenantId, country);
    return tenantId;
  }

  async function seedExtension(
    tenantId: string,
    number: string,
    callerId: { name: string | null; number: string | null } = { name: null, number: null },
  ): Promise<string> {
    const id = crypto.randomUUID();
    await h.readModel.upsertExtension(h.db.kysely, {
      id,
      tenantId,
      number,
      username: number,
      ha1: 'a'.repeat(32),
      realm: DOMAIN,
      callerIdName: callerId.name,
      callerIdNumber: callerId.number,
      emergencyLocationId: crypto.randomUUID(),
    });
    return id;
  }

  async function seedOutbound(tenantId: string): Promise<void> {
    const trunkId = crypto.randomUUID();
    await h.readModel.upsertTrunk(h.db.kysely, {
      id: trunkId,
      tenantId,
      name: 'Carrier',
      authMode: 'ip',
      host: 'carrier.test',
      port: 5060,
      transport: 'udp',
      username: null,
      secret: null,
      fromDomain: null,
      status: 'active',
      callerIdName: null,
      callerIdNumber: '+15550001111',
    });
    await h.readModel.upsertOutboundRoute(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      priority: 0,
      pattern: '+1',
      trunkIds: [trunkId],
      strip: 0,
      prepend: null,
    });
  }

  function seedMailbox(tenantId: string, extensionId: string): string {
    const id = crypto.randomUUID();
    h.voicemail.mailboxes[id] = {
      id,
      tenantId,
      extensionId,
      pin: '1234',
      greetingStatus: 'none',
      greetingObjectKey: null,
    };
    return id;
  }

  function setHandling(
    tenantId: string,
    extensionId: string,
    settings: Partial<CallHandlingConfig>,
  ) {
    return h.readModel.upsertCallHandling(h.db.kysely, {
      extensionId,
      tenantId,
      settings: { ...off, ...settings },
    });
  }

  async function dial(
    tenantId: string,
    fields: Record<string, string> = {},
    number = '101',
  ): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/fs/dialplan',
      headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: BASIC_AUTH },
      payload: new URLSearchParams({
        section: 'dialplan',
        'Caller-Context': 'public',
        'Caller-Destination-Number': number,
        'variable_sip_h_X-Call-Direction': 'internal',
        'variable_sip_h_X-Tenant-Id': tenantId,
        variable_sip_from_user: '100',
        ...fields,
      }).toString(),
    });
    expect(response.statusCode).toBe(200);
    return response.body;
  }

  const actions = (xml: string) =>
    [...xml.matchAll(/<action application="([^"]+)" data="([^"]*)"\/>/g)].map((m) => ({
      app: m[1] ?? '',
      data: (m[2] ?? '').replaceAll('&apos;', "'"),
    }));
  const bridges = (xml: string) => actions(xml).filter((a) => a.app === 'bridge');

  it('an extension with no call handling row dials exactly as before (one bridge to the phone)', async () => {
    const tenantId = await seedTenant();
    await seedExtension(tenantId, '101');
    const xml = await dial(tenantId);
    expect(bridges(xml)).toEqual([
      { app: 'bridge', data: `{sip_route_uri=sip:opensips:5060}sofia/internal/101@${DOMAIN}` },
    ]);
  });

  it('do not disturb goes to voicemail when the extension has a mailbox, otherwise busy', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    await setHandling(tenantId, ext, { dnd: true, dndAction: 'voicemail' });

    // No mailbox: busy, never rings.
    let xml = await dial(tenantId);
    expect(bridges(xml)).toEqual([]);
    expect(actions(xml).at(-1)).toEqual({ app: 'hangup', data: 'USER_BUSY' });

    const mailboxId = seedMailbox(tenantId, ext);
    xml = await dial(tenantId);
    expect(bridges(xml)).toEqual([]);
    expect(actions(xml).at(-1)?.data).toBe(`voicemail.lua leave ${tenantId} ${mailboxId}`);

    await setHandling(tenantId, ext, { dnd: true, dndAction: 'busy' });
    xml = await dial(tenantId);
    expect(actions(xml).at(-1)).toEqual({ app: 'hangup', data: 'USER_BUSY' });
  });

  it('forward always to another extension bridges only to that extension', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const other = await seedExtension(tenantId, '102');
    await setHandling(tenantId, ext, {
      forwardAlways: { type: 'extension', extensionId: other },
    });
    const xml = await dial(tenantId);
    expect(bridges(xml)).toHaveLength(1);
    expect(bridges(xml)[0]?.data).toContain(`sofia/internal/102@${DOMAIN}`);
    expect(bridges(xml)[0]?.data).not.toContain('sofia/internal/101@');
  });

  it('drops a destination extension that belongs to another tenant, leaving the phone to ring', async () => {
    const tenantId = await seedTenant();
    const otherTenant = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const foreign = await seedExtension(otherTenant, '555');
    await setHandling(tenantId, ext, {
      forwardAlways: { type: 'extension', extensionId: foreign },
      simultaneousRing: [{ type: 'extension', extensionId: foreign }],
    });
    const xml = await dial(tenantId);
    expect(xml).not.toContain('555');
    expect(bridges(xml)).toHaveLength(1);
    expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');
  });

  it('forward always to a voicemail goes to that mailbox, and to nothing when it has none', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const other = await seedExtension(tenantId, '102');
    await setHandling(tenantId, ext, { forwardAlways: { type: 'voicemail', extensionId: other } });

    // No mailbox for 102: the forward is unresolvable, so the phone rings.
    let xml = await dial(tenantId);
    expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');

    const mailboxId = seedMailbox(tenantId, other);
    xml = await dial(tenantId);
    expect(bridges(xml)).toEqual([]);
    expect(actions(xml).at(-1)?.data).toBe(`voicemail.lua leave ${tenantId} ${mailboxId}`);
  });

  it('busy / no answer / unreachable forwards become cause-keyed fallbacks, with the no-answer ring time', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const busyTo = await seedExtension(tenantId, '102');
    await setHandling(tenantId, ext, {
      forwardBusy: { type: 'extension', extensionId: busyTo },
      forwardNoAnswer: { type: 'voicemail' },
      noAnswerSeconds: 40,
    });
    const mailboxId = seedMailbox(tenantId, ext);

    const xml = await dial(tenantId);
    const list = actions(xml);
    expect(list.find((a) => a.data.startsWith('cuc_cf_USER_BUSY='))?.data).toContain(
      `sofia/internal/102@${DOMAIN}`,
    );
    expect(list.find((a) => a.data.startsWith('cuc_cf_vm_NO_ANSWER='))?.data).toBe(
      `cuc_cf_vm_NO_ANSWER=leave ${tenantId} ${mailboxId}`,
    );
    // Unreachable was not configured, but the extension has a mailbox, so it is the default.
    expect(list.find((a) => a.data.startsWith('cuc_cf_vm_USER_NOT_REGISTERED='))).toBeDefined();
    expect(bridges(xml)[0]?.data.startsWith('{call_timeout=40}')).toBe(true);
  });

  it('simultaneous ring adds one leg per destination after the extension itself', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const b = await seedExtension(tenantId, '102');
    await seedOutbound(tenantId);
    await setHandling(tenantId, ext, {
      simultaneousRing: [
        { type: 'extension', extensionId: b },
        { type: 'external', e164: '+14155552671' },
      ],
    });
    const xml = await dial(tenantId);
    const legs = bridges(xml)[0]?.data.split(',[') ?? [];
    expect(legs).toHaveLength(3);
    expect(legs[0]).toContain('sofia/internal/101@');
    expect(legs[1]).toContain('sofia/internal/102@');
    expect(legs[2]).toMatch(/sofia\/internal\/\d+14155552671@/);
  });

  describe('an external forward is an outbound call', () => {
    it('is tagged with the tenant routing group, carries the forwarding extension caller ID (not the original caller), and is attributed to the tenant', async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101', {
        name: 'Front Desk',
        number: '+15559990000',
      });
      await seedOutbound(tenantId);
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
      });

      const xml = await dial(tenantId, { 'Caller-Caller-ID-Number': '+12125550100' });
      const groupId = await h.readModel.findOrCreateDrGroupId(h.db.kysely, tenantId);
      const list = actions(xml);
      expect(list[0]?.data).toBe(`cuc_tenant_id=${tenantId}`);
      const data = bridges(xml)[0]?.data ?? '';
      expect(data).toContain(`sofia/internal/${drTag(groupId)}14155552671@${DOMAIN}`);
      expect(data).toContain('origination_caller_id_number=+15559990000');
      expect(data).toContain("origination_caller_id_name='Front Desk'");
      expect(data).not.toContain('12125550100');
      expect(data).toContain('sip_h_X-Forward-Hops=1');
    });

    it("falls back to the trunk's caller ID when the extension has none", async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await seedOutbound(tenantId);
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
      });
      const xml = await dial(tenantId);
      expect(bridges(xml)[0]?.data).toContain('origination_caller_id_number=+15550001111');
    });

    it("applies the tenant's concurrent-channel limit before the bridge", async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await seedOutbound(tenantId);
      h.orgClient.limits[tenantId] = { maxConcurrentChannels: 3 };
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
      });
      const list = actions(await dial(tenantId));
      const limitAt = list.findIndex((a) => a.app === 'limit');
      expect(list[limitAt]?.data).toBe(`redis ${tenantId} outbound-channels 3`);
      expect(limitAt).toBeLessThan(list.findIndex((a) => a.app === 'bridge'));
    });

    it('is blocked by the international-calling policy, and the extension rings instead', async () => {
      const tenantId = await seedTenant('US');
      const ext = await seedExtension(tenantId, '101');
      await seedOutbound(tenantId);
      // +44 is international for a US tenant; internationalAllowed defaults off.
      await h.readModel.upsertOutboundRoute(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        priority: 1,
        pattern: '+44',
        trunkIds: [],
        strip: 0,
        prepend: null,
      });
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+442071838750' },
        simultaneousRing: [{ type: 'external', e164: '+442071838751' }],
      });
      const xml = await dial(tenantId);
      expect(xml).not.toContain('4420718');
      expect(bridges(xml)).toHaveLength(1);
      expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');
    });

    it('is allowed once the tenant permits that country', async () => {
      const tenantId = await seedTenant('US');
      const ext = await seedExtension(tenantId, '101');
      const trunkId = crypto.randomUUID();
      await h.readModel.upsertTrunk(h.db.kysely, {
        id: trunkId,
        tenantId,
        name: 'Carrier',
        authMode: 'ip',
        host: 'carrier.test',
        port: 5060,
        transport: 'udp',
        username: null,
        secret: null,
        fromDomain: null,
        status: 'active',
        callerIdName: null,
        callerIdNumber: null,
      });
      await h.readModel.upsertOutboundRoute(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        priority: 0,
        pattern: '+44',
        trunkIds: [trunkId],
        strip: 0,
        prepend: null,
      });
      h.orgClient.limits[tenantId] = { countryAllowList: ['GB'] };
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+442071838750' },
      });
      const xml = await dial(tenantId);
      expect(bridges(xml)[0]?.data).toMatch(/sofia\/internal\/\d+442071838750@/);
    });

    it('is refused when there is no outbound route, and when the limits cannot be fetched (fails closed)', async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
      });
      // No outbound route at all.
      let xml = await dial(tenantId);
      expect(xml).not.toContain('14155552671');
      expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');

      await seedOutbound(tenantId);
      h.orgClient.limitsFailFor.add(tenantId);
      xml = await dial(tenantId);
      expect(xml).not.toContain('14155552671');
    });

    it('never contacts org-service for a call with no external destination', async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      const other = await seedExtension(tenantId, '102');
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'extension', extensionId: other },
      });
      h.orgClient.limitsCalls = 0;
      await dial(tenantId);
      expect(h.orgClient.limitsCalls).toBe(0);
    });
  });

  describe('loops and chains', () => {
    async function forwardingExtension(): Promise<{ tenantId: string; ext: string }> {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await seedOutbound(tenantId);
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
        simultaneousRing: [{ type: 'external', e164: '+14155552672' }],
        forwardBusy: { type: 'external', e164: '+14155552673' },
      });
      return { tenantId, ext };
    }

    it('counts hops: a call that arrives with 1 hop leaves with 2', async () => {
      const { tenantId } = await forwardingExtension();
      const xml = await dial(tenantId, { 'variable_sip_h_X-Forward-Hops': '1' });
      expect(bridges(xml)[0]?.data).toContain('sip_h_X-Forward-Hops=2');
      expect(actions(xml).find((a) => a.data.startsWith('cuc_forward_hops='))?.data).toBe(
        'cuc_forward_hops=1',
      );
    });

    it.each(['3', '4', '999', 'abc', '-1', '1.5', '1e9'])(
      'stops forwarding at the cap or on an unreadable count (%s): the phone just rings',
      async (hops) => {
        const { tenantId } = await forwardingExtension();
        const xml = await dial(tenantId, { 'variable_sip_h_X-Forward-Hops': hops });
        expect(xml).not.toContain('1415555267');
        expect(bridges(xml)).toHaveLength(1);
        expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');
      },
    );

    it('a call from a trunk that presents one of the tenant numbers as caller ID is treated as a loop', async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await seedOutbound(tenantId);
      const trunkId = crypto.randomUUID();
      await h.readModel.upsertTrunk(h.db.kysely, {
        id: trunkId,
        tenantId,
        name: 'Carrier',
        authMode: 'ip',
        host: 'carrier.test',
        port: 5060,
        transport: 'udp',
        username: null,
        secret: null,
        fromDomain: null,
        status: 'active',
        callerIdName: null,
        callerIdNumber: null,
      });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15559990000',
        trunkId,
        destinationType: 'extension',
        destinationId: ext,
      });
      await setHandling(tenantId, ext, {
        forwardAlways: { type: 'external', e164: '+14155552671' },
      });

      const fromTrunk = {
        'variable_sip_h_X-Call-Direction': 'inbound',
        'variable_sip_h_X-Trunk-Id': trunkId.replaceAll('-', ''),
        'Caller-Destination-Number': '+15559990000',
        'variable_sip_h_X-Tenant-Id': '',
      };
      // A genuine outside caller is forwarded.
      let xml = await dial(
        tenantId,
        { ...fromTrunk, 'Caller-Caller-ID-Number': '+12125550100' },
        '+15559990000',
      );
      expect(xml).toContain('14155552671');
      // The forward coming straight back, with the tenant's own DID as caller ID, is not.
      xml = await dial(
        tenantId,
        { ...fromTrunk, 'Caller-Caller-ID-Number': '+15559990000' },
        '+15559990000',
      );
      expect(xml).not.toContain('14155552671');
      expect(bridges(xml)[0]?.data).toContain('sofia/internal/101@');
    });

    it('do not disturb is not a forward: it still applies when forwarding is suppressed', async () => {
      const tenantId = await seedTenant();
      const ext = await seedExtension(tenantId, '101');
      await setHandling(tenantId, ext, { dnd: true, dndAction: 'busy' });
      const xml = await dial(tenantId, { 'variable_sip_h_X-Forward-Hops': '9' });
      expect(actions(xml).at(-1)).toEqual({ app: 'hangup', data: 'USER_BUSY' });
    });
  });

  it('applies to a DID that routes to the extension too', async () => {
    const tenantId = await seedTenant();
    const ext = await seedExtension(tenantId, '101');
    const other = await seedExtension(tenantId, '102');
    const trunkId = crypto.randomUUID();
    await h.readModel.upsertTrunk(h.db.kysely, {
      id: trunkId,
      tenantId,
      name: 'Carrier',
      authMode: 'ip',
      host: 'carrier.test',
      port: 5060,
      transport: 'udp',
      username: null,
      secret: null,
      fromDomain: null,
      status: 'active',
      callerIdName: null,
      callerIdNumber: null,
    });
    await h.readModel.upsertDid(h.db.kysely, {
      id: crypto.randomUUID(),
      tenantId,
      e164: '+15559990000',
      trunkId,
      destinationType: 'extension',
      destinationId: ext,
    });
    await setHandling(tenantId, ext, { forwardAlways: { type: 'extension', extensionId: other } });
    const xml = await dial(
      tenantId,
      {
        'variable_sip_h_X-Call-Direction': 'inbound',
        'variable_sip_h_X-Trunk-Id': trunkId.replaceAll('-', ''),
        'variable_sip_h_X-Tenant-Id': '',
      },
      '+15559990000',
    );
    expect(bridges(xml)[0]?.data).toContain(`sofia/internal/102@${DOMAIN}`);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { toContextId } from '../src/context-id.js';
import { drTag } from '../src/repo/opensips-projection.repo.js';
import { registerFsRoutes } from '../src/routes/fs.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-fs-xml-curl-token';
const BASIC_AUTH = `Basic ${Buffer.from(`fs-node:${TOKEN}`).toString('base64')}`;

/** mod_xml_curl's real wire format (verified live against FreeSWITCH 1.10.12). */
function form(fields: Record<string, string>): string {
  return new URLSearchParams(fields).toString();
}

describe.skipIf(skipReason !== undefined)('/fs/directory and /fs/dialplan', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'telephony-config', logger: h.logger });
    registerFsRoutes(app, h.db, h.readModel, TOKEN, 'opensips:5060', h.logger);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  describe('/fs/directory', () => {
    it('401s with no Authorization header', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fs/directory',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: form({
          section: 'directory',
          tag_name: 'domain',
          key_name: 'name',
          key_value: 'x',
        }),
      });
      expect(response.statusCode).toBe(401);
    });

    it('401s with the wrong token', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fs/directory',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: `Basic ${Buffer.from('fs-node:wrong').toString('base64')}`,
        },
        payload: form({
          section: 'directory',
          tag_name: 'domain',
          key_name: 'name',
          key_value: 'x',
        }),
      });
      expect(response.statusCode).toBe(401);
    });

    it('returns the not-found document for an unknown domain', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fs/directory',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'directory',
          tag_name: 'domain',
          key_name: 'name',
          key_value: 'unknown.platform.test',
        }),
      });
      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it("returns every tenant's extension under <domain> for a known domain", async () => {
      const tenantId = crypto.randomUUID();
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number: '101',
        username: '101',
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/directory',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'directory',
          tag_name: 'domain',
          key_name: 'name',
          key_value: 'acme.platform.test',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<document type="freeswitch/xml">');
      expect(response.body).toContain('<domain name="acme.platform.test">');
      expect(response.body).toContain('<user id="101" cacheable="30000">');
      expect(response.body).not.toContain('not found');
    });
  });

  describe('/fs/dialplan', () => {
    async function seedExtension(tenantId: string, number: string): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
      });
    }

    it('returns a bridge dialplan for a known in-tenant ext→ext destination', async () => {
      const tenantId = crypto.randomUUID();
      await seedExtension(tenantId, '102');

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'dialplan',
          tag_name: '',
          key_name: '',
          key_value: '',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '102',
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<context name="public">');
      expect(response.body).toContain('expression="^102$"');
      expect(response.body).toContain(
        'data="{sip_route_uri=sip:opensips:5060}sofia/internal/102@acme.platform.test"',
      );
    });

    it('returns not-found for an unknown destination number', async () => {
      const tenantId = crypto.randomUUID();
      await seedExtension(tenantId, '102');

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '999',
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it("does not leak another tenant's extension with the same number", async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      await seedExtension(tenantA, '102');
      await seedExtension(tenantB, '102');

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '102',
          // A tenant that has no extension 102 of its own — must not see tenantA's.
          'variable_sip_h_X-Tenant-Id': crypto.randomUUID(),
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects an inbound call with no X-Trunk-Id header at all', async () => {
      const tenantId = crypto.randomUUID();
      await seedExtension(tenantId, '102');

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '102',
          'variable_sip_h_X-Call-Direction': 'inbound',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects a request missing the trusted X-Tenant-Id header entirely', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'Caller-Destination-Number': '102',
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });
  });

  describe('/fs/dialplan (S2-03: from-trunk DID routing)', () => {
    async function seedTrunkAndExtension(
      tenantId: string,
      trunkId: string,
      extensionNumber: string,
    ): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
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
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number: extensionNumber,
        username: extensionNumber,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
      });
    }

    function extensionIdFor(tenantId: string): Promise<string> {
      return h.db.kysely
        .selectFrom('extensions')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow()
        .then((row) => row.id);
    }

    function inboundPayload(fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'public',
        'variable_sip_h_X-Call-Direction': 'inbound',
        ...fields,
      });
    }

    it('bridges a DID to its bound extension', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, trunkId, '102');
      const extensionId = await extensionIdFor(tenantId);
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'extension',
        destinationId: extensionId,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15551234567',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      // The leading `+` is a regex metacharacter, not a literal one, in the
      // `destination_number` condition FreeSWITCH compiles — escaped, not
      // passed through raw (`xml.ts`'s own comment on why: an unescaped `+`
      // right after `^` fails FreeSWITCH's regex compile entirely).
      expect(response.body).toContain('expression="^\\+15551234567$"');
      expect(response.body).toContain(
        'data="{sip_route_uri=sip:opensips:5060}sofia/internal/102@acme.platform.test"',
      );
    });

    it('rejects an INVITE whose source IP matched no trunk (no X-Trunk-Id)', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({ 'Caller-Destination-Number': '+15551234567' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects a DID owned by a different tenant than the trunk it arrived on', async () => {
      const tenantA = crypto.randomUUID();
      const tenantB = crypto.randomUUID();
      const trunkA = crypto.randomUUID();
      const trunkB = crypto.randomUUID();
      await seedTrunkAndExtension(tenantA, trunkA, '102');
      await seedTrunkAndExtension(tenantB, trunkB, '201');
      const tenantBExtensionId = await h.db.kysely
        .selectFrom('extensions')
        .select('id')
        .where('tenant_id', '=', tenantB)
        .executeTakeFirstOrThrow()
        .then((row) => row.id);
      // A DID owned by tenant B...
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId: tenantB,
        e164: '+15551234567',
        trunkId: trunkB,
        destinationType: 'extension',
        destinationId: tenantBExtensionId,
      });

      // ...dialed on a call that arrived on tenant A's trunk.
      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15551234567',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkA),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects a DID bound to a different trunk of the same tenant', async () => {
      const tenantId = crypto.randomUUID();
      const boundTrunk = crypto.randomUUID();
      const otherTrunk = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, boundTrunk, '102');
      await h.readModel.upsertTrunk(h.db.kysely, {
        id: otherTrunk,
        tenantId,
        name: 'Other trunk',
        authMode: 'ip',
        host: 'other.test',
        port: 5060,
        transport: 'udp',
        username: null,
        secret: null,
        fromDomain: null,
        status: 'active',
        callerIdName: null,
        callerIdNumber: null,
      });
      const extensionId = await extensionIdFor(tenantId);
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId: boundTrunk,
        destinationType: 'extension',
        destinationId: extensionId,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15551234567',
          'variable_sip_h_X-Trunk-Id': toContextId(otherTrunk),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects a DID whose destination type has no owning subsystem yet (docs/decisions.md G-25)', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, trunkId, '102');
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'ring_group',
        destinationId: crypto.randomUUID(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15551234567',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('rejects an unknown DID entirely', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, trunkId, '102');

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+19998887777',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });
  });

  describe('/fs/dialplan (S2-04: outbound dialing)', () => {
    async function seedTenant(tenantId: string, country: string): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
      await h.readModel.setTenantCountry(h.db.kysely, tenantId, country);
    }

    async function seedTrunk(
      tenantId: string,
      overrides: { callerIdName?: string | null; callerIdNumber?: string | null } = {},
    ): Promise<string> {
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
        callerIdName: overrides.callerIdName ?? null,
        callerIdNumber: overrides.callerIdNumber ?? null,
      });
      return trunkId;
    }

    async function seedRoute(
      tenantId: string,
      trunkIds: readonly string[],
      pattern = '+1',
    ): Promise<void> {
      await h.readModel.upsertOutboundRoute(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        priority: 0,
        pattern,
        trunkIds,
        strip: 0,
        prepend: null,
      });
    }

    /** The tag `buildOutboundDialplanDocument` must have prepended — fetched back, not predicted, since `dr_group_id` is `AUTO_INCREMENT` (same reasoning as `trunk.consumer.test.ts`'s own `tenantDrTag`). */
    async function tenantDrTag(tenantId: string): Promise<string> {
      const groupId = await h.readModel.findOrCreateDrGroupId(h.db.kysely, tenantId);
      return drTag(groupId);
    }

    function outboundPayload(fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'public',
        'variable_sip_h_X-Call-Direction': 'internal',
        ...fields,
      });
    }

    it('bridges to a tenant-tagged, plus-free number, with no X-Dr-Group-Id header (G-28/G-29)', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId]);

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: outboundPayload({
          'Caller-Destination-Number': '+14155552671',
          'variable_sip_h_X-Tenant-Id': tenantId,
        }),
      });

      expect(response.statusCode).toBe(200);
      const tag = await tenantDrTag(tenantId);
      expect(response.body).toContain(
        `data="{sip_route_uri=sip:opensips:5060}sofia/internal/${tag}14155552671@acme.platform.test"`,
      );
      // Superseded design (G-28): `do_routing()`'s `groupID` param turned
      // out to be compile-time-only, so this header is no longer set.
      expect(response.body).not.toContain('X-Dr-Group-Id');
      // The dialplan *condition* still matches the original dialed number
      // (only the bridge target — checked above — carries the tag).
      expect(response.body).toContain('name="outbound-+14155552671"');
    });

    it("applies the calling extension's caller ID override to the bridge vars", async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId]);
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number: '101',
        username: '101',
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: 'Front Desk',
        callerIdNumber: '+15559990000',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: outboundPayload({
          'Caller-Destination-Number': '+14155552671',
          'variable_sip_h_X-Tenant-Id': tenantId,
          variable_sip_from_user: '101',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('origination_caller_id_number=+15559990000');
      expect(response.body).toContain('origination_caller_id_name=&apos;Front Desk&apos;');
    });

    it('returns not-found when the tenant has no known country', async () => {
      const tenantId = crypto.randomUUID();
      // No `seedTenant`/`setTenantCountry` call — mirrors a tenant whose
      // `org.tenant.created` was consumed before `country` existed at all
      // (`seed.ts`'s own comment on why the SIP suite needs a fresh tenant
      // for this).
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: outboundPayload({
          'Caller-Destination-Number': '+14155552671',
          'variable_sip_h_X-Tenant-Id': tenantId,
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('returns not-found when no outbound route matches the normalized number', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '+44'); // UK-only route; dialing a US number

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: outboundPayload({
          'Caller-Destination-Number': '+14155552671',
          'variable_sip_h_X-Tenant-Id': tenantId,
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });
  });
});

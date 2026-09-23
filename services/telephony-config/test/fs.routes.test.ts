import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, redisOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { toContextId } from '../src/context-id.js';
import { drTag } from '../src/repo/opensips-projection.repo.js';
import { registerFsRoutes } from '../src/routes/fs.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await redisOrSkipReason());
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
        emergencyLocationId: crypto.randomUUID(),
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
        emergencyLocationId: crypto.randomUUID(),
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

    function extensionIdFor(tenantId: string): Promise<string> {
      return h.db.kysely
        .selectFrom('extensions')
        .select('id')
        .where('tenant_id', '=', tenantId)
        .executeTakeFirstOrThrow()
        .then((row) => row.id);
    }

    it('S2-16: adds a no-answer voicemail fallback when the bridged extension has a mailbox', async () => {
      const tenantId = crypto.randomUUID();
      await seedExtension(tenantId, '102');
      const extensionId = await extensionIdFor(tenantId);
      const mailboxId = crypto.randomUUID();
      h.voicemail.mailboxes[mailboxId] = {
        id: mailboxId,
        tenantId,
        extensionId,
        pin: '1234',
        greetingStatus: 'none',
        greetingObjectKey: null,
      };

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
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        'data="{sip_route_uri=sip:opensips:5060}sofia/internal/102@acme.platform.test"',
      );
      expect(response.body).toContain('continue_on_fail=');
      expect(response.body).toContain(`data="voicemail.lua leave ${tenantId} ${mailboxId}"`);
    });

    it('S2-16: no fallback action when the extension has no mailbox', async () => {
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
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('voicemail.lua');
    });

    it('S2-16: *97 dials the calling extension’s own mailbox retrieval menu', async () => {
      const tenantId = crypto.randomUUID();
      await seedExtension(tenantId, '102');
      const extensionId = await extensionIdFor(tenantId);
      const mailboxId = crypto.randomUUID();
      h.voicemail.mailboxes[mailboxId] = {
        id: mailboxId,
        tenantId,
        extensionId,
        pin: '1234',
        greetingStatus: 'none',
        greetingObjectKey: null,
      };

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
          'Caller-Destination-Number': '*97',
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
          variable_sip_from_user: '102',
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`data="voicemail.lua retrieve ${tenantId} ${mailboxId}"`);
    });

    it('S2-16: *97 is a miss when the calling extension has no mailbox', async () => {
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
          'Caller-Destination-Number': '*97',
          'variable_sip_h_X-Tenant-Id': tenantId,
          'variable_sip_h_X-Call-Direction': 'internal',
          variable_sip_from_user: '102',
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
        emergencyLocationId: crypto.randomUUID(),
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

    it('S2-16: a DID bound directly to a mailbox dials into voicemail leave mode', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, trunkId, '102');
      const mailboxId = crypto.randomUUID();
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15559998888',
        trunkId,
        destinationType: 'voicemail',
        destinationId: mailboxId,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15559998888',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`data="voicemail.lua leave ${tenantId} ${mailboxId}"`);
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
      // `ring_group` gained a real owning subsystem in S2-08 (see the
      // describe block below) — `queue` (S2-13) is still the honest miss.
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunkAndExtension(tenantId, trunkId, '102');
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'queue',
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

  describe('/fs/dialplan (S2-08: DID -> ring group)', () => {
    async function seedTrunk(tenantId: string, trunkId: string): Promise<void> {
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
    }

    async function seedExtension(tenantId: string, number: string): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertExtension(h.db.kysely, {
        id,
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: crypto.randomUUID(),
      });
      return id;
    }

    function inboundPayload(fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'public',
        'variable_sip_h_X-Call-Direction': 'inbound',
        ...fields,
      });
    }

    it('bridges a simultaneous ring group to every member at once', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunk(tenantId, trunkId);
      const ext1 = await seedExtension(tenantId, '101');
      const ext2 = await seedExtension(tenantId, '102');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Sales',
        strategy: 'simultaneous',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 20,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551234567',
        trunkId,
        destinationType: 'ring_group',
        destinationId: ringGroupId,
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
      expect(response.body).toContain(
        'data="{sip_route_uri=sip:opensips:5060,call_timeout=20}' +
          'sofia/internal/101@acme.platform.test,sofia/internal/102@acme.platform.test"',
      );
    });

    it('bridges a sequential ring group with per-leg timeouts, in member order', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunk(tenantId, trunkId);
      const ext1 = await seedExtension(tenantId, '101');
      const ext2 = await seedExtension(tenantId, '102');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Support',
        strategy: 'sequential',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 15,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15559876543',
        trunkId,
        destinationType: 'ring_group',
        destinationId: ringGroupId,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15559876543',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      const legs =
        '[leg_timeout=15]sofia/internal/101@acme.platform.test|[leg_timeout=15]sofia/internal/102@acme.platform.test';
      expect(response.body).toContain(legs);
    });

    it('falls back to the no-answer extension when the ring group bridge fails', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunk(tenantId, trunkId);
      const ext1 = await seedExtension(tenantId, '101');
      const fallback = await seedExtension(tenantId, '199');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Support',
        strategy: 'sequential',
        memberExtensionIds: JSON.stringify([ext1]),
        ringTimeoutSeconds: 15,
        noAnswerDestinationType: 'extension',
        noAnswerDestinationId: fallback,
      });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15551112222',
        trunkId,
        destinationType: 'ring_group',
        destinationId: ringGroupId,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: inboundPayload({
          'Caller-Destination-Number': '+15551112222',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('sofia/internal/199@acme.platform.test');
    });

    it('rotates round-robin starting member across successive calls via the Redis counter', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTrunk(tenantId, trunkId);
      const ext1 = await seedExtension(tenantId, '101');
      const ext2 = await seedExtension(tenantId, '102');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'RoundRobin',
        strategy: 'round_robin',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 10,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15553334444',
        trunkId,
        destinationType: 'ring_group',
        destinationId: ringGroupId,
      });

      const payload = inboundPayload({
        'Caller-Destination-Number': '+15553334444',
        'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
      });
      const headers = {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: BASIC_AUTH,
      };

      const first = await app.inject({ method: 'POST', url: '/fs/dialplan', headers, payload });
      const second = await app.inject({ method: 'POST', url: '/fs/dialplan', headers, payload });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      // First call starts at member[0] (101), second at member[1] (102) —
      // the Redis-backed counter (`ring-group-counter.ts`) rotates the
      // start position on every call to the same ring group. The bridge
      // action's own `data="..."` is the second one in the document (S2-18
      // added a leading `cuc_tenant_id` set action ahead of it).
      const firstLegs = first.body.split('data="')[2] ?? '';
      const secondLegs = second.body.split('data="')[2] ?? '';
      expect(firstLegs.indexOf('101@acme.platform.test')).toBeLessThan(
        firstLegs.indexOf('102@acme.platform.test'),
      );
      expect(secondLegs.indexOf('102@acme.platform.test')).toBeLessThan(
        secondLegs.indexOf('101@acme.platform.test'),
      );
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
        emergencyLocationId: crypto.randomUUID(),
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

  describe('/fs/dialplan (S2-05: toll-fraud controls)', () => {
    async function seedTenant(tenantId: string, country: string): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
      await h.readModel.setTenantCountry(h.db.kysely, tenantId, country);
    }

    async function seedTrunk(tenantId: string): Promise<string> {
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
      return trunkId;
    }

    async function seedRoute(
      tenantId: string,
      trunkIds: readonly string[],
      pattern: string,
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

    function outboundPayload(fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'public',
        'variable_sip_h_X-Call-Direction': 'internal',
        ...fields,
      });
    }

    async function dial(tenantId: string, destinationNumber: string) {
      return app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: outboundPayload({
          'Caller-Destination-Number': destinationNumber,
          'variable_sip_h_X-Tenant-Id': tenantId,
        }),
      });
    }

    it('blocks an international call by default (no limits set at all)', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      // A route that would match a GB number too, so the block is provably
      // the fraud check firing, not "no route matched".
      await seedRoute(tenantId, [trunkId], '');

      // libphonenumber's own documented example UK number (`e164.test.ts`).
      const response = await dial(tenantId, '+442079460958');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<result status="not found"/>');
    });

    it('allows an international call once internationalAllowed is set', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '');
      h.orgClient.limits[tenantId] = { internationalAllowed: true };

      const response = await dial(tenantId, '+442079460958');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<action application="bridge"');
    });

    it("allows an international call to a country on the tenant's own allow-list", async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '');
      h.orgClient.limits[tenantId] = { countryAllowList: ['GB'] };

      const allowed = await dial(tenantId, '+442079460958');
      expect(allowed.statusCode).toBe(200);
      expect(allowed.body).toContain('<action application="bridge"');

      // A country *not* on the list is still blocked.
      h.orgClient.limits[tenantId] = { countryAllowList: ['DE'] };
      const stillBlocked = await dial(tenantId, '+442079460958');
      expect(stillBlocked.body).toContain('<result status="not found"/>');
    });

    it('never blocks a domestic call, even with no limits configured', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '+1');

      const response = await dial(tenantId, '+14155552671');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('<action application="bridge"');
    });

    it('fails the call closed when org-service cannot be reached for the limits lookup', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '+1');
      const originalFindLimits = h.orgClient.findLimits.bind(h.orgClient);
      h.orgClient.findLimits = () => Promise.reject(new Error('connection refused'));

      try {
        const response = await dial(tenantId, '+14155552671');
        expect(response.statusCode).toBe(200);
        expect(response.body).toContain('<result status="not found"/>');
      } finally {
        h.orgClient.findLimits = originalFindLimits;
      }
    });

    it('emits a redis-backed limit action ahead of the bridge when maxConcurrentChannels is set', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '+1');
      h.orgClient.limits[tenantId] = { maxConcurrentChannels: 3 };

      const response = await dial(tenantId, '+14155552671');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `<action application="limit" data="redis ${tenantId} outbound-channels 3"/>`,
      );
      // Ordered before the bridge, not after — a call over the limit must
      // never reach it.
      const limitIndex = response.body.indexOf('application="limit"');
      const bridgeIndex = response.body.indexOf('application="bridge"');
      expect(limitIndex).toBeGreaterThan(-1);
      expect(limitIndex).toBeLessThan(bridgeIndex);
    });

    it('emits no limit action at all when maxConcurrentChannels is unset (unlimited)', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId, 'US');
      const trunkId = await seedTrunk(tenantId);
      await seedRoute(tenantId, [trunkId], '+1');

      const response = await dial(tenantId, '+14155552671');

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('application="limit"');
    });
  });

  describe('/fs/dialplan (S2-06: emergency dialing)', () => {
    async function seedTenant(tenantId: string): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
    }

    async function seedEmergencyRoute(tenantId: string, numbers: string[]): Promise<void> {
      await h.readModel.upsertEmergencyRoute(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        trunkId: crypto.randomUUID(),
        numbers,
      });
    }

    async function seedExtension(
      tenantId: string,
      number: string,
      emergencyLocationId?: string,
    ): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertExtension(h.db.kysely, {
        id,
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: emergencyLocationId ?? crypto.randomUUID(),
      });
      return id;
    }

    function dialplanPayload(fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'public',
        'variable_sip_h_X-Call-Direction': 'internal',
        ...fields,
      });
    }

    async function dial(tenantId: string, destinationNumber: string, callingNumber?: string) {
      return app.inject({
        method: 'POST',
        url: '/fs/dialplan',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: dialplanPayload({
          'Caller-Destination-Number': destinationNumber,
          'variable_sip_h_X-Tenant-Id': tenantId,
          ...(callingNumber === undefined ? {} : { variable_sip_from_user: callingNumber }),
        }),
      });
    }

    it('bridges an emergency call even though the tenant is already at its configured channel limit', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedEmergencyRoute(tenantId, ['911']);
      // The same kind of limit that gates a normal outbound call (S2-05) —
      // proving the bypass means proving *this* never produces a `limit`
      // action, not that some separately-configured "no limit" state does.
      h.orgClient.limits[tenantId] = { maxConcurrentChannels: 1 };

      const response = await dial(tenantId, '911');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('application="bridge"');
      expect(response.body).not.toContain('application="limit"');
    });

    it('sets X-Emergency-Location from the calling extension’s resolved location, address parts slash-joined', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedEmergencyRoute(tenantId, ['911']);
      const locationId = crypto.randomUUID();
      h.pbxConfig.emergencyLocations[locationId] = {
        id: locationId,
        label: 'HQ',
        addressLine1: '123 Main St',
        addressLine2: null,
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      };
      await seedExtension(tenantId, '101', locationId);

      const response = await dial(tenantId, '911', '101');

      expect(response.statusCode).toBe(200);
      // `escapeXml` turns the value's own wrapping `'` into `&apos;` (same
      // as `origination_caller_id_name`'s own escaping above) — ` / `, not
      // `, `, is what must separate the parts (the comma-corruption bug
      // this header's own construction was fixed for before it ever shipped).
      expect(response.body).toContain(
        'sip_h_X-Emergency-Location=&apos;123 Main St / Springfield / IL / 62701 / US&apos;',
      );
      expect(response.body).not.toContain('123 Main St, Springfield');
    });

    it('still bridges, with no location header or caller ID, when the calling extension cannot be resolved', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedEmergencyRoute(tenantId, ['911']);

      // No `variable_sip_from_user` at all — an unrecognized/absent caller.
      const response = await dial(tenantId, '911');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('application="bridge"');
      expect(response.body).not.toContain('X-Emergency-Location');
      expect(response.body).not.toContain('origination_caller_id');
    });

    it('enqueues call.emergency.initiated with the dialed number, extension, and location', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedEmergencyRoute(tenantId, ['911']);
      const locationId = crypto.randomUUID();
      h.pbxConfig.emergencyLocations[locationId] = {
        id: locationId,
        label: 'HQ',
        addressLine1: '123 Main St',
        addressLine2: null,
        city: 'Springfield',
        state: 'IL',
        postalCode: '62701',
        country: 'US',
      };
      const extensionId = await seedExtension(tenantId, '101', locationId);

      const response = await dial(tenantId, '911', '101');
      expect(response.statusCode).toBe(200);

      const rows = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'tenant_id as tenantId', 'payload'])
        .where('type', '=', 'call.emergency.initiated')
        .execute();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        tenantId,
        payload: {
          dialedNumber: '911',
          callingExtensionId: extensionId,
          emergencyLocationId: locationId,
        },
      });
    });

    it('takes the emergency path, not the extension path, when a real extension shares the emergency number', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedEmergencyRoute(tenantId, ['911']);
      // A misconfigured (or coincidental) extension numbered exactly '911' —
      // G-1's own "must never be shadowed" requirement (`fs.routes.ts`'s own
      // doc comment on why the emergency check runs first).
      await seedExtension(tenantId, '911');

      const response = await dial(tenantId, '911');

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain('name="emergency-911"');
      expect(response.body).not.toContain('name="ext-911"');
    });
  });

  describe('/fs/media/:tenantId/:assetId/:rate (S2-07: media asset playback)', () => {
    async function seedReadyAsset(
      tenantId: string,
      wav8k: Buffer,
      wav16k: Buffer,
    ): Promise<string> {
      const assetId = crypto.randomUUID();
      const variant8kKey = `media-assets/${assetId}/8k.wav`;
      const variant16kKey = `media-assets/${assetId}/16k.wav`;
      const tenantStorage = h.storage.forTenant(tenantId);
      await tenantStorage.provisionBucket();
      await tenantStorage.putObject(variant8kKey, wav8k, { contentType: 'audio/wav' });
      await tenantStorage.putObject(variant16kKey, wav16k, { contentType: 'audio/wav' });
      h.pbxConfig.mediaAssets[assetId] = {
        id: assetId,
        kind: 'prompt',
        status: 'ready',
        variant8kKey,
        variant16kKey,
      };
      return assetId;
    }

    it('serves the 8k variant bytes for a ready asset', async () => {
      const tenantId = crypto.randomUUID();
      const wav8k = Buffer.from('fake 8k wav bytes');
      const wav16k = Buffer.from('fake 16k wav bytes');
      const assetId = await seedReadyAsset(tenantId, wav8k, wav16k);

      const response = await app.inject({
        method: 'GET',
        url: `/fs/media/${tenantId}/${assetId}/8k`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      expect(response.headers['content-type']).toContain('audio/wav');
      expect(response.rawPayload).toEqual(wav8k);
    });

    it('serves the 16k variant bytes for a ready asset', async () => {
      const tenantId = crypto.randomUUID();
      const wav8k = Buffer.from('fake 8k wav bytes');
      const wav16k = Buffer.from('fake 16k wav bytes');
      const assetId = await seedReadyAsset(tenantId, wav8k, wav16k);

      const response = await app.inject({
        method: 'GET',
        url: `/fs/media/${tenantId}/${assetId}/16k`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      expect(response.rawPayload).toEqual(wav16k);
    });

    it('401s with no Authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/media/${crypto.randomUUID()}/${crypto.randomUUID()}/8k`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('404s for an asset that does not exist', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/media/${crypto.randomUUID()}/${crypto.randomUUID()}/8k`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });

    it('404s for an asset that has not finished transcoding yet', async () => {
      const tenantId = crypto.randomUUID();
      const assetId = crypto.randomUUID();
      h.pbxConfig.mediaAssets[assetId] = {
        id: assetId,
        kind: 'prompt',
        status: 'processing',
        variant8kKey: null,
        variant16kKey: null,
      };

      const response = await app.inject({
        method: 'GET',
        url: `/fs/media/${tenantId}/${assetId}/8k`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('/fs/voicemail/... (S2-16: voicemail)', () => {
    function seedMailbox(tenantId: string, extensionId: string, pin = '1234') {
      const id = crypto.randomUUID();
      h.voicemail.mailboxes[id] = {
        id,
        tenantId,
        extensionId,
        pin,
        greetingStatus: 'none',
        greetingObjectKey: null,
      };
      return id;
    }

    it('401s every voicemail route with no Authorization header', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${crypto.randomUUID()}/mailbox/by-extension/${crypto.randomUUID()}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('finds a mailbox by extension id, and 404s an unknown one', async () => {
      const tenantId = crypto.randomUUID();
      const extensionId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, extensionId);

      const found = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/by-extension/${extensionId}`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(found.statusCode).toBe(200);
      expect(found.json()).toMatchObject({ id: mailboxId });

      const missing = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/by-extension/${crypto.randomUUID()}`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(missing.statusCode).toBe(404);
    });

    it('verifies a PIN', async () => {
      const tenantId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, crypto.randomUUID(), '4242');

      const valid = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/verify-pin`,
        headers: { authorization: BASIC_AUTH },
        payload: { pin: '4242' },
      });
      expect(valid.json()).toMatchObject({ valid: true });

      const invalid = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/verify-pin`,
        headers: { authorization: BASIC_AUTH },
        payload: { pin: '0000' },
      });
      expect(invalid.json()).toMatchObject({ valid: false });
    });

    it('the full leave-message round trip: create, upload, complete, list, play the real bytes, mark read, delete', async () => {
      const tenantId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, crypto.randomUUID());
      await h.storage.forTenant(tenantId).provisionBucket();

      const created = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages`,
        headers: { authorization: BASIC_AUTH },
        payload: { callerIdNumber: '+15005550001' },
      });
      expect(created.statusCode).toBe(201);
      const { messageId, uploadUrl }: { messageId: string; uploadUrl: string } = created.json();

      const wav = Buffer.from('real spool bytes');
      const uploaded = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      });
      expect(uploaded.ok).toBe(true);

      const completed = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages/${messageId}/complete`,
        headers: { authorization: BASIC_AUTH },
        payload: { durationMs: 4000, sizeBytes: wav.length },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ status: 'ready' });

      const list = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(list.json()).toMatchObject({ rows: [{ id: messageId }] });

      const audio = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages/${messageId}/audio`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.headers['content-type']).toContain('audio/wav');
      expect(audio.rawPayload).toEqual(wav);

      const markedRead = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages/${messageId}/mark-read`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(markedRead.json()).toMatchObject({ isRead: true });

      const deleted = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages/${messageId}/delete`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(deleted.statusCode).toBe(204);
    });

    it('404s message audio for one that has not finished uploading yet', async () => {
      const tenantId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, crypto.randomUUID());
      const created = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages`,
        headers: { authorization: BASIC_AUTH },
        payload: {},
      });
      const { messageId }: { messageId: string } = created.json();

      const response = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/messages/${messageId}/audio`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });

    it('uploads and completes a greeting, then serves its real bytes', async () => {
      const tenantId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, crypto.randomUUID());
      await h.storage.forTenant(tenantId).provisionBucket();

      const presigned = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/greeting/presign`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(presigned.statusCode).toBe(201);
      const { uploadUrl }: { uploadUrl: string } = presigned.json();

      const wav = Buffer.from('real greeting bytes');
      await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'content-type': 'audio/wav' },
        body: wav,
      });

      const completed = await app.inject({
        method: 'POST',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/greeting/complete`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({ greetingStatus: 'ready' });

      const audio = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/greeting/audio`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(audio.statusCode).toBe(200);
      expect(audio.rawPayload).toEqual(wav);
    });

    it('404s greeting audio for a mailbox with no greeting yet', async () => {
      const tenantId = crypto.randomUUID();
      const mailboxId = seedMailbox(tenantId, crypto.randomUUID());

      const response = await app.inject({
        method: 'GET',
        url: `/fs/voicemail/${tenantId}/mailbox/${mailboxId}/greeting/audio`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });
  });

  describe('/fs/flow and /fs/dialplan (S2-10: flow runner)', () => {
    async function seedTenant(tenantId: string): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        fqdn: 'acme.platform.test',
      });
    }

    async function seedTrunk(tenantId: string, trunkId: string): Promise<void> {
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
    }

    async function seedExtension(tenantId: string, number: string): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertExtension(h.db.kysely, {
        id,
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: crypto.randomUUID(),
      });
      return id;
    }

    /** A minimal two-node published flow: a `play` that hangs up after. */
    function publishFlow(tenantId: string, flowId: string, entryPoints: Record<string, string>) {
      h.callflow.flows[`${tenantId}/${flowId}`] = {
        flowId,
        versionId: crypto.randomUUID(),
        versionNumber: 3,
        ir: {
          entryPoints,
          nodes: {
            greeting: {
              id: 'greeting',
              type: 'play',
              config: { mediaAssetId: crypto.randomUUID() },
              ports: { next: 'done' },
            },
            done: { id: 'done', type: 'hangup', config: {}, ports: {} },
          },
        },
      };
    }

    it('hands a flow DID off to flow_runner.lua with the tenant context set', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      const flowId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedTrunk(tenantId, trunkId);
      publishFlow(tenantId, flowId, { main: 'greeting' });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15557654321',
        trunkId,
        destinationType: 'flow',
        destinationId: flowId,
      });

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
          'variable_sip_h_X-Call-Direction': 'inbound',
          'Caller-Destination-Number': '+15557654321',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(`data="flow_runner.lua ${tenantId} ${flowId} main"`);
      // The runner bridges extension/ring_group nodes itself, so it needs the
      // domain and edge URI without a lookup of its own.
      expect(response.body).toContain('data="cuc_tenant_domain=acme.platform.test"');
      expect(response.body).toContain('data="cuc_opensips_sip_uri=opensips:5060"');
      expect(response.body).toContain('<action application="answer"/>');
    });

    it('misses a flow DID whose flow has never published', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedTrunk(tenantId, trunkId);
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15550000001',
        trunkId,
        destinationType: 'flow',
        destinationId: crypto.randomUUID(),
      });

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
          'variable_sip_h_X-Call-Direction': 'inbound',
          'Caller-Destination-Number': '+15550000001',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('flow_runner.lua');
    });

    it('misses a flow DID whose flow has no "main" entry point', async () => {
      const tenantId = crypto.randomUUID();
      const trunkId = crypto.randomUUID();
      const flowId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedTrunk(tenantId, trunkId);
      publishFlow(tenantId, flowId, { after_hours: 'greeting' });
      await h.readModel.upsertDid(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        e164: '+15550000002',
        trunkId,
        destinationType: 'flow',
        destinationId: flowId,
      });

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
          'variable_sip_h_X-Call-Direction': 'inbound',
          'Caller-Destination-Number': '+15550000002',
          'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
        }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).not.toContain('flow_runner.lua');
    });

    it('serves the published IR with its version so the runner can cache by it', async () => {
      const tenantId = crypto.randomUUID();
      const flowId = crypto.randomUUID();
      publishFlow(tenantId, flowId, { main: 'greeting' });

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/${flowId}/ir`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json<{ versionNumber: number; ir: { entryPoints: unknown } }>();
      expect(body.versionNumber).toBe(3);
      expect(body.ir.entryPoints).toEqual({ main: 'greeting' });
    });

    it('404s the IR for a flow with no published version', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${crypto.randomUUID()}/${crypto.randomUUID()}/ir`,
        headers: { authorization: BASIC_AUTH },
      });
      expect(response.statusCode).toBe(404);
    });

    it('rejects an unauthenticated IR fetch', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${crypto.randomUUID()}/${crypto.randomUUID()}/ir`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('resolves an extension node id to its dialable number', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const extensionId = await seedExtension(tenantId, '201');

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/extension/${extensionId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ number: '201' });
    });

    it('refuses to resolve an extension belonging to another tenant', async () => {
      const tenantId = crypto.randomUUID();
      const otherTenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const extensionId = await seedExtension(tenantId, '202');

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${otherTenantId}/extension/${extensionId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(404);
    });

    it('resolves a ring group node to its members in strategy order', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const ext1 = await seedExtension(tenantId, '301');
      const ext2 = await seedExtension(tenantId, '302');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Support',
        strategy: 'sequential',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 25,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/ring-group/${ringGroupId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        numbers: ['301', '302'],
        strategy: 'sequential',
        ringTimeoutSeconds: 25,
      });
    });

    it('rotates a round-robin ring group for the flow runner too, via the same Redis counter', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const ext1 = await seedExtension(tenantId, '401');
      const ext2 = await seedExtension(tenantId, '402');
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Rotating',
        strategy: 'round_robin',
        memberExtensionIds: JSON.stringify([ext1, ext2]),
        ringTimeoutSeconds: 15,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });

      async function firstMember(): Promise<string> {
        const response = await app.inject({
          method: 'GET',
          url: `/fs/flow/${tenantId}/ring-group/${ringGroupId}`,
          headers: { authorization: BASIC_AUTH },
        });
        return response.json<{ numbers: string[] }>().numbers[0]!;
      }

      // The whole point of sharing `resolveRingGroup` with the DID path: a
      // group reached through a flow advances the same counter, so it cannot
      // start every flow-routed call at the same member.
      expect(await firstMember()).not.toBe(await firstMember());
    });

    it('404s a ring group with no resolvable members', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const ringGroupId = crypto.randomUUID();
      await h.readModel.upsertRingGroup(h.db.kysely, {
        id: ringGroupId,
        tenantId,
        label: 'Empty',
        strategy: 'simultaneous',
        memberExtensionIds: JSON.stringify([crypto.randomUUID()]),
        ringTimeoutSeconds: 20,
        noAnswerDestinationType: null,
        noAnswerDestinationId: null,
      });

      const response = await app.inject({
        method: 'GET',
        url: `/fs/flow/${tenantId}/ring-group/${ringGroupId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('/fs/affinity (S2-12: resource affinity leases)', () => {
    it('reports null when nothing holds the lease', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/affinity/${crypto.randomUUID()}/queue/${crypto.randomUUID()}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json<{ nodeId: string | null }>()).toEqual({ nodeId: null });
    });

    it('reports the current holder, read directly off the same Redis state call-control writes', async () => {
      const tenantId = crypto.randomUUID();
      const resourceId = crypto.randomUUID();
      await h.affinity.acquire({ tenantId, kind: 'conf', resourceId }, 'fs-1', 30_000);

      const response = await app.inject({
        method: 'GET',
        url: `/fs/affinity/${tenantId}/conf/${resourceId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.json<{ nodeId: string | null }>()).toEqual({ nodeId: 'fs-1' });
    });

    it('keeps leases of different kinds on the same resourceId independent', async () => {
      const tenantId = crypto.randomUUID();
      const resourceId = crypto.randomUUID();
      await h.affinity.acquire({ tenantId, kind: 'queue', resourceId }, 'fs-1', 30_000);

      const response = await app.inject({
        method: 'GET',
        url: `/fs/affinity/${tenantId}/park/${resourceId}`,
        headers: { authorization: BASIC_AUTH },
      });

      expect(response.json<{ nodeId: string | null }>()).toEqual({ nodeId: null });
    });

    it('401s without the fs-node token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/fs/affinity/${crypto.randomUUID()}/queue/${crypto.randomUUID()}`,
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('queues, agents, and mod_callcenter (S2-13)', () => {
    async function seedTenant(tenantId: string, fqdn = 'acme.platform.test'): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, { id: crypto.randomUUID(), tenantId, fqdn });
    }

    async function seedExtension(tenantId: string, number: string): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertExtension(h.db.kysely, {
        id,
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: crypto.randomUUID(),
      });
      return id;
    }

    async function seedQueue(
      tenantId: string,
      overrides: Partial<Parameters<typeof h.readModel.upsertQueue>[1]> = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertQueue(h.db.kysely, {
        id,
        tenantId,
        label: 'Support',
        strategy: 'round-robin',
        mohMediaAssetId: null,
        maxWaitSeconds: 0,
        announcePosition: false,
        announceFrequencySeconds: null,
        noAgentDestinationType: null,
        noAgentDestinationId: null,
        ...overrides,
      });
      return id;
    }

    async function seedAgent(tenantId: string, extensionId: string): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertAgent(h.db.kysely, {
        id,
        tenantId,
        extensionId,
        maxNoAnswer: 3,
        wrapUpSeconds: 0,
        rejectDelaySeconds: 0,
      });
      return id;
    }

    async function seedTier(
      tenantId: string,
      queueId: string,
      agentId: string,
      level = 1,
      position = 1,
    ): Promise<void> {
      await h.readModel.replaceQueueTiersForQueue(h.db.kysely, tenantId, queueId, [
        { id: crypto.randomUUID(), tenantId, queueId, agentId, level, position },
      ]);
    }

    describe('/fs/dialplan (from-trunk DID -> queue)', () => {
      async function seedTrunk(tenantId: string, trunkId: string): Promise<void> {
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
      }

      function inboundPayload(fields: Record<string, string>) {
        return form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'variable_sip_h_X-Call-Direction': 'inbound',
          ...fields,
        });
      }

      it('acquires the affinity lease onto the requesting node and hands off to callcenter', async () => {
        const tenantId = crypto.randomUUID();
        const trunkId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTrunk(tenantId, trunkId);
        const queueId = await seedQueue(tenantId);
        await h.readModel.upsertDid(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId,
          e164: '+15551234567',
          trunkId,
          destinationType: 'queue',
          destinationId: queueId,
        });

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan?nodeId=fs-1',
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
        expect(response.body).toContain(
          `<action application="callcenter" data="${queueId}@acme.platform.test"/>`,
        );
        expect(h.callControl.acquireCalls).toContainEqual({
          tenantId,
          kind: 'queue',
          resourceId: queueId,
          preferredNodeId: 'fs-1',
        });
      });

      it('404s when the queue is leased to a different node', async () => {
        const tenantId = crypto.randomUUID();
        const trunkId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTrunk(tenantId, trunkId);
        const queueId = await seedQueue(tenantId);
        await h.readModel.upsertDid(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId,
          e164: '+15551234567',
          trunkId,
          destinationType: 'queue',
          destinationId: queueId,
        });
        h.callControl.acquireResults[`${tenantId}:queue:${queueId}`] = {
          nodeId: 'fs-2',
          acquired: false,
        };

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan?nodeId=fs-1',
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

      it('404s when the queue no longer exists in the local mirror', async () => {
        const tenantId = crypto.randomUUID();
        const trunkId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTrunk(tenantId, trunkId);
        await h.readModel.upsertDid(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId,
          e164: '+15551234567',
          trunkId,
          destinationType: 'queue',
          destinationId: crypto.randomUUID(),
        });

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan?nodeId=fs-1',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: inboundPayload({
            'Caller-Destination-Number': '+15551234567',
            'variable_sip_h_X-Trunk-Id': toContextId(trunkId),
          }),
        });

        expect(response.body).toContain('<result status="not found"/>');
      });
    });

    describe('/fs/configuration (callcenter.conf)', () => {
      function configPayload(fields: Record<string, string>) {
        return form({ section: 'configuration', ...fields });
      }

      it('builds callcenter.conf filtered to queues leased to the requesting node', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const extensionId = await seedExtension(tenantId, '101');
        const agentId = await seedAgent(tenantId, extensionId);

        const leasedQueueId = await seedQueue(tenantId, { label: 'Leased' });
        await seedTier(tenantId, leasedQueueId, agentId, 2, 1);
        await h.affinity.acquire(
          { tenantId, kind: 'queue', resourceId: leasedQueueId },
          'fs-1',
          30_000,
        );

        const unleasedQueueId = await seedQueue(tenantId, { label: 'Unleased' });
        void unleasedQueueId;

        const otherNodeQueueId = await seedQueue(tenantId, { label: 'OtherNode' });
        await h.affinity.acquire(
          { tenantId, kind: 'queue', resourceId: otherNodeQueueId },
          'fs-2',
          30_000,
        );

        const response = await app.inject({
          method: 'POST',
          url: '/fs/configuration?nodeId=fs-1',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: configPayload({ key_value: 'callcenter.conf' }),
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain(`<queue name="${leasedQueueId}@acme.platform.test">`);
        expect(response.body).toContain('<param name="strategy" value="round-robin"/>');
        expect(response.body).toContain(
          `<agent name="101@acme.platform.test" type="callback" contact="user/101@acme.platform.test" status="Logged Out" max-no-answer="3" wrap-up-time="0" reject-delay-time="0"/>`,
        );
        expect(response.body).toContain(
          `<tier agent="101@acme.platform.test" queue="${leasedQueueId}@acme.platform.test" level="2" position="1"/>`,
        );
        expect(response.body).toContain('<param name="moh-sound" value="local_stream://moh"/>');
        expect(response.body).not.toContain(`${unleasedQueueId}@`);
        expect(response.body).not.toContain(`${otherNodeQueueId}@`);
      });

      it('embeds a credentialed http_cache URL for moh-sound when the queue has an uploaded MOH asset', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const mediaAssetId = crypto.randomUUID();
        const queueId = await seedQueue(tenantId, { mohMediaAssetId: mediaAssetId });
        await h.affinity.acquire({ tenantId, kind: 'queue', resourceId: queueId }, 'fs-1', 30_000);

        const response = await app.inject({
          method: 'POST',
          url: '/fs/configuration?nodeId=fs-1',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: configPayload({ key_value: 'callcenter.conf' }),
        });

        expect(response.body).toContain(
          `<param name="moh-sound" value="http_cache://http://fs-node:${TOKEN}@telephony-config-test:8080/fs/media/${tenantId}/${mediaAssetId}/8k"/>`,
        );
      });

      it('returns the not-found document for a module other than callcenter.conf', async () => {
        const response = await app.inject({
          method: 'POST',
          url: '/fs/configuration?nodeId=fs-1',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: configPayload({ key_value: 'conference.conf' }),
        });

        expect(response.body).toContain('<result status="not found"/>');
      });

      it('returns the not-found document when no nodeId is given', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const queueId = await seedQueue(tenantId);
        await h.affinity.acquire({ tenantId, kind: 'queue', resourceId: queueId }, 'fs-1', 30_000);

        const response = await app.inject({
          method: 'POST',
          url: '/fs/configuration',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: configPayload({ key_value: 'callcenter.conf' }),
        });

        expect(response.body).toContain('<result status="not found"/>');
      });
    });

    describe('/fs/dialplan (agent login/logout feature codes)', () => {
      function internalPayload(tenantId: string, fields: Record<string, string>) {
        return form({
          section: 'dialplan',
          'Caller-Context': 'internal',
          'variable_sip_h_X-Call-Direction': 'internal',
          'variable_sip_h_X-Tenant-Id': tenantId,
          ...fields,
        });
      }

      it('*45 sets the calling agent to Available', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const extensionId = await seedExtension(tenantId, '101');
        await seedAgent(tenantId, extensionId);

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: internalPayload(tenantId, {
            'Caller-Destination-Number': '*45',
            variable_sip_from_user: '101',
          }),
        });

        expect(response.statusCode).toBe(200);
        expect(response.body).toContain(
          `callcenter_config agent set status &apos;101@acme.platform.test&apos; &apos;Available&apos;`,
        );
      });

      it('*46 sets the calling agent to Logged Out', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const extensionId = await seedExtension(tenantId, '101');
        await seedAgent(tenantId, extensionId);

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: internalPayload(tenantId, {
            'Caller-Destination-Number': '*46',
            variable_sip_from_user: '101',
          }),
        });

        expect(response.body).toContain(
          `callcenter_config agent set status &apos;101@acme.platform.test&apos; &apos;Logged Out&apos;`,
        );
      });

      it('404s for a calling extension with no agent identity', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedExtension(tenantId, '102');

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan',
          headers: {
            'content-type': 'application/x-www-form-urlencoded',
            authorization: BASIC_AUTH,
          },
          payload: internalPayload(tenantId, {
            'Caller-Destination-Number': '*45',
            variable_sip_from_user: '102',
          }),
        });

        expect(response.body).toContain('<result status="not found"/>');
      });
    });

    describe('/fs/flow/:tenantId/queue/:queueId (S2-13 flow node)', () => {
      it('acquires the lease preferring the calling node and reports isLocal', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const queueId = await seedQueue(tenantId);

        const response = await app.inject({
          method: 'GET',
          url: `/fs/flow/${tenantId}/queue/${queueId}?nodeId=fs-1`,
          headers: { authorization: BASIC_AUTH },
        });

        expect(response.statusCode).toBe(200);
        const body: { queueName: string; nodeId: string; isLocal: boolean } = response.json();
        expect(body).toEqual({
          queueName: `${queueId}@acme.platform.test`,
          nodeId: 'fs-1',
          isLocal: true,
        });
        expect(h.callControl.acquireCalls).toContainEqual({
          tenantId,
          kind: 'queue',
          resourceId: queueId,
          preferredNodeId: 'fs-1',
        });
      });

      it('reports isLocal: false when leased to another node (hairpin case)', async () => {
        const tenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        const queueId = await seedQueue(tenantId);
        h.callControl.acquireResults[`${tenantId}:queue:${queueId}`] = {
          nodeId: 'fs-2',
          acquired: false,
        };

        const response = await app.inject({
          method: 'GET',
          url: `/fs/flow/${tenantId}/queue/${queueId}?nodeId=fs-1`,
          headers: { authorization: BASIC_AUTH },
        });

        const body: { isLocal: boolean; nodeId: string } = response.json();
        expect(body).toMatchObject({ isLocal: false, nodeId: 'fs-2' });
      });

      it('404s for a queue in a different tenant', async () => {
        const tenantId = crypto.randomUUID();
        const otherTenantId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTenant(otherTenantId);
        const queueId = await seedQueue(tenantId);

        const response = await app.inject({
          method: 'GET',
          url: `/fs/flow/${otherTenantId}/queue/${queueId}?nodeId=fs-1`,
          headers: { authorization: BASIC_AUTH },
        });

        expect(response.statusCode).toBe(404);
      });
    });
  });

  describe('parking lots (S2-14)', () => {
    async function seedTenant(tenantId: string, fqdn = 'acme.platform.test'): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, { id: crypto.randomUUID(), tenantId, fqdn });
    }

    async function seedLot(
      tenantId: string,
      overrides: Partial<Parameters<typeof h.readModel.upsertParkingLot>[1]> = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertParkingLot(h.db.kysely, {
        id,
        tenantId,
        label: 'Main Lot',
        slotStart: 700,
        slotEnd: 719,
        timeoutSeconds: 120,
        returnDestinationType: null,
        returnDestinationId: null,
        ...overrides,
      });
      return id;
    }

    function internalPayload(tenantId: string, fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'internal',
        'variable_sip_h_X-Call-Direction': 'internal',
        'variable_sip_h_X-Tenant-Id': tenantId,
        ...fields,
      });
    }

    it('dialing a number inside a lot’s slot range runs valet_park after acquiring the lease', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const lotId = await seedLot(tenantId);

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '705' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `<action application="valet_park" data="${lotId}@acme.platform.test/705"/>`,
      );
      expect(h.callControl.acquireCalls).toContainEqual({
        tenantId,
        kind: 'park',
        resourceId: lotId,
        preferredNodeId: 'fs-1',
      });
    });

    it('a real extension wins over a coincidentally-numbered slot', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedLot(tenantId, { slotStart: 100, slotEnd: 199 });
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number: '150',
        username: '150',
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: crypto.randomUUID(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '150' }),
      });

      expect(response.body).not.toContain('valet_park');
      expect(response.body).toContain('sofia/internal/150@acme.platform.test');
    });

    it('404s when the slot is leased to a different node', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const lotId = await seedLot(tenantId);
      h.callControl.acquireResults[`${tenantId}:park:${lotId}`] = {
        nodeId: 'fs-2',
        acquired: false,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '705' }),
      });

      expect(response.body).toContain('<result status="not found"/>');
    });

    it('falls through to outbound dialing for a number outside every lot', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedLot(tenantId, { slotStart: 700, slotEnd: 719 });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '9995551234' }),
      });

      // No tenant country configured in this test, so outbound dial itself
      // 404s too — the point here is only that it did *not* try valet_park.
      expect(response.body).not.toContain('valet_park');
    });
  });

  describe('conference rooms (S2-15)', () => {
    async function seedTenant(tenantId: string, fqdn = 'acme.platform.test'): Promise<void> {
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, { id: crypto.randomUUID(), tenantId, fqdn });
    }

    async function seedRoom(
      tenantId: string,
      overrides: Partial<Parameters<typeof h.readModel.upsertConferenceRoom>[1]> = {},
    ): Promise<string> {
      const id = crypto.randomUUID();
      await h.readModel.upsertConferenceRoom(h.db.kysely, {
        id,
        tenantId,
        label: 'All Hands',
        number: '600',
        pinRequired: false,
        maxMembers: 50,
        ...overrides,
      });
      return id;
    }

    function internalPayload(tenantId: string, fields: Record<string, string>) {
      return form({
        section: 'dialplan',
        'Caller-Context': 'internal',
        'variable_sip_h_X-Call-Direction': 'internal',
        'variable_sip_h_X-Tenant-Id': tenantId,
        ...fields,
      });
    }

    it('dialing a room’s number runs the conference lua app after acquiring the lease', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const roomId = await seedRoom(tenantId);

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '600' }),
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toContain(
        `<action application="lua" data="conference.lua ${tenantId} ${roomId} ${roomId}@acme.platform.test 0"/>`,
      );
      expect(h.callControl.acquireCalls).toContainEqual({
        tenantId,
        kind: 'conf',
        resourceId: roomId,
        preferredNodeId: 'fs-1',
      });
    });

    it('a room requiring a PIN passes that through to the lua app', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const roomId = await seedRoom(tenantId, { number: '601', pinRequired: true });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '601' }),
      });

      expect(response.body).toContain(
        `<action application="lua" data="conference.lua ${tenantId} ${roomId} ${roomId}@acme.platform.test 1"/>`,
      );
    });

    it('a real extension wins over a coincidentally-numbered conference room', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      await seedRoom(tenantId, { number: '150' });
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number: '150',
        username: '150',
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
        callerIdName: null,
        callerIdNumber: null,
        emergencyLocationId: crypto.randomUUID(),
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '150' }),
      });

      expect(response.body).not.toContain('conference.lua');
      expect(response.body).toContain('sofia/internal/150@acme.platform.test');
    });

    it('a conference room wins over a coincidentally-numbered parking slot', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const roomId = await seedRoom(tenantId, { number: '705' });
      await h.readModel.upsertParkingLot(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        label: 'Main Lot',
        slotStart: 700,
        slotEnd: 719,
        timeoutSeconds: 120,
        returnDestinationType: null,
        returnDestinationId: null,
      });

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '705' }),
      });

      expect(response.body).toContain(`conference.lua ${tenantId} ${roomId}`);
      expect(response.body).not.toContain('valet_park');
    });

    it('404s when the room is leased to a different node', async () => {
      const tenantId = crypto.randomUUID();
      await seedTenant(tenantId);
      const roomId = await seedRoom(tenantId);
      h.callControl.acquireResults[`${tenantId}:conf:${roomId}`] = {
        nodeId: 'fs-2',
        acquired: false,
      };

      const response = await app.inject({
        method: 'POST',
        url: '/fs/dialplan?nodeId=fs-1',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          authorization: BASIC_AUTH,
        },
        payload: internalPayload(tenantId, { 'Caller-Destination-Number': '600' }),
      });

      expect(response.body).toContain('<result status="not found"/>');
    });

    describe('/fs/dialplan (from-trunk DID -> conference)', () => {
      async function seedTrunk(tenantId: string, trunkId: string): Promise<void> {
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
      }

      function inboundPayload(fields: Record<string, string>) {
        return form({
          section: 'dialplan',
          'Caller-Context': 'public',
          'variable_sip_h_X-Call-Direction': 'inbound',
          ...fields,
        });
      }

      it('acquires the affinity lease onto the requesting node and hands off to the conference lua app', async () => {
        const tenantId = crypto.randomUUID();
        const trunkId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTrunk(tenantId, trunkId);
        const roomId = await seedRoom(tenantId);
        await h.readModel.upsertDid(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId,
          e164: '+15551234567',
          trunkId,
          destinationType: 'conference',
          destinationId: roomId,
        });

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan?nodeId=fs-1',
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
        expect(response.body).toContain(
          `<action application="lua" data="conference.lua ${tenantId} ${roomId} ${roomId}@acme.platform.test 0"/>`,
        );
        expect(h.callControl.acquireCalls).toContainEqual({
          tenantId,
          kind: 'conf',
          resourceId: roomId,
          preferredNodeId: 'fs-1',
        });
      });

      it('404s when the room is leased to a different node', async () => {
        const tenantId = crypto.randomUUID();
        const trunkId = crypto.randomUUID();
        await seedTenant(tenantId);
        await seedTrunk(tenantId, trunkId);
        const roomId = await seedRoom(tenantId);
        await h.readModel.upsertDid(h.db.kysely, {
          id: crypto.randomUUID(),
          tenantId,
          e164: '+15551234567',
          trunkId,
          destinationType: 'conference',
          destinationId: roomId,
        });
        h.callControl.acquireResults[`${tenantId}:conf:${roomId}`] = {
          nodeId: 'fs-2',
          acquired: false,
        };

        const response = await app.inject({
          method: 'POST',
          url: '/fs/dialplan?nodeId=fs-1',
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
    });

    describe('/fs/conference-rooms/:tenantId/:roomId/verify-pin', () => {
      it('proxies to pbx-config-service and returns its verdict', async () => {
        const tenantId = crypto.randomUUID();
        const roomId = crypto.randomUUID();
        h.pbxConfig.conferencePins[roomId] = '1234';

        const correct = await app.inject({
          method: 'POST',
          url: `/fs/conference-rooms/${tenantId}/${roomId}/verify-pin`,
          headers: { 'content-type': 'application/json', authorization: BASIC_AUTH },
          payload: { pin: '1234' },
        });
        expect(correct.statusCode).toBe(200);
        expect(correct.json()).toMatchObject({ valid: true });

        const wrong = await app.inject({
          method: 'POST',
          url: `/fs/conference-rooms/${tenantId}/${roomId}/verify-pin`,
          headers: { 'content-type': 'application/json', authorization: BASIC_AUTH },
          payload: { pin: '9999' },
        });
        expect(wrong.statusCode).toBe(200);
        expect(wrong.json()).toMatchObject({ valid: false });
      });

      it('401s with no auth', async () => {
        const response = await app.inject({
          method: 'POST',
          url: `/fs/conference-rooms/${crypto.randomUUID()}/${crypto.randomUUID()}/verify-pin`,
          headers: { 'content-type': 'application/json' },
          payload: { pin: '1234' },
        });
        expect(response.statusCode).toBe(401);
      });
    });
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

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
    registerFsRoutes(app, h.db, h.readModel, TOKEN, h.logger);
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
      await h.readModel.upsertExtension(h.db.kysely, {
        id: crypto.randomUUID(),
        tenantId,
        number,
        username: number,
        ha1: 'a'.repeat(32),
        realm: 'acme.platform.test',
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
        'data="sofia/internal/102@${network_addr}:${sip_network_port}"',
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

    it('rejects a non-internal call direction (from-trunk DID routing is out of scope, S2-03)', async () => {
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
});

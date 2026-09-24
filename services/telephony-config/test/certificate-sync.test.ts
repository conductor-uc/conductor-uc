import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason } from '@cuc/testing';

import { certificateFingerprint, createCertificateSync } from '../src/certificate-sync.js';
import { resetOpenSipsSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();

const pem = (label: string) => `-----BEGIN CERTIFICATE-----\n${label}\n-----END CERTIFICATE-----\n`;
const key = (label: string) => `-----BEGIN PRIVATE KEY-----\n${label}\n-----END PRIVATE KEY-----\n`;

describe.skipIf(skipReason !== undefined)('certificate sync', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  afterEach(async () => {
    await resetOpenSipsSchema(h.opensipsDb);
    h.orgClient.certificates = {};
    h.mi.calls.length = 0;
  });

  const sync = () => createCertificateSync(h.orgClient, h.opensipsProjection, h.mi, h.logger);

  const rows = () =>
    h.opensipsDb.kysely.selectFrom('tls_mgm').selectAll().orderBy('domain', 'asc').execute();

  describe('syncOne', () => {
    it("writes a reseller's certificate as a server row chosen by its name, and reloads", async () => {
      h.orgClient.certificates['sip.voice.reseller.test'] = {
        resellerId: 'reseller-1',
        version: 1,
        certificate: pem('reseller-cert'),
        privateKey: key('reseller-key'),
      };

      expect(await sync().syncOne('sip.voice.reseller.test')).toBe(true);

      const written = await rows();
      expect(written).toHaveLength(1);
      expect(written[0]).toMatchObject({
        domain: 'sip.voice.reseller.test',
        match_sip_domain: 'sip.voice.reseller.test',
        match_ip_address: null,
        // OpenSIPs' server domain (1 would be a client domain).
        type: 2,
        method: 'SSLv23',
        verify_cert: 0,
        require_cert: 0,
        certificate: pem('reseller-cert'),
        private_key: key('reseller-key'),
      });
      expect(h.mi.calls).toEqual(['tls_reload']);
    });

    it("also makes the platform's own certificate the default, for any name there is nothing for", async () => {
      h.orgClient.certificates['sip.platform.test'] = {
        resellerId: null,
        version: 1,
        certificate: pem('platform-cert'),
        privateKey: key('platform-key'),
      };

      await sync().syncOne('sip.platform.test');

      const written = await rows();
      expect(written.map((r) => r.domain)).toEqual(['default', 'sip.platform.test']);
      expect(written[0]).toMatchObject({
        domain: 'default',
        match_ip_address: '*',
        match_sip_domain: null,
        type: 2,
        certificate: pem('platform-cert'),
      });
    });

    it('replaces a certificate when it is renewed, without adding a row', async () => {
      const sipRow = {
        resellerId: 'reseller-1',
        version: 1,
        certificate: pem('one'),
        privateKey: key('one'),
      };
      h.orgClient.certificates['sip.a.test'] = sipRow;
      await sync().syncOne('sip.a.test');
      h.orgClient.certificates['sip.a.test'] = {
        ...sipRow,
        version: 2,
        certificate: pem('two'),
        privateKey: key('two'),
      };
      await sync().syncOne('sip.a.test');

      const written = await rows();
      expect(written).toHaveLength(1);
      expect(written[0]?.certificate).toBe(pem('two'));
      expect(written[0]?.private_key).toBe(key('two'));
    });

    it('does nothing, and does not reload, for a name org-service holds nothing for', async () => {
      expect(await sync().syncOne('sip.unknown.test')).toBe(false);
      expect(await rows()).toEqual([]);
      expect(h.mi.calls).toEqual([]);
    });
  });

  describe('syncAll', () => {
    it('fetches only what differs, writes it, and reloads once', async () => {
      h.orgClient.certificates['sip.platform.test'] = {
        resellerId: null,
        version: 1,
        certificate: pem('p'),
        privateKey: key('p'),
      };
      h.orgClient.certificates['sip.a.test'] = {
        resellerId: 'r1',
        version: 1,
        certificate: pem('a'),
        privateKey: key('a'),
      };
      h.orgClient.certificates['sip.b.test'] = {
        resellerId: 'r2',
        version: 1,
        certificate: pem('b'),
        privateKey: key('b'),
      };

      const first = await sync().syncAll();
      expect([...first.written].sort()).toEqual(['sip.a.test', 'sip.b.test', 'sip.platform.test']);
      expect((await rows()).map((r) => r.domain)).toEqual([
        'default',
        'sip.a.test',
        'sip.b.test',
        'sip.platform.test',
      ]);
      expect(h.mi.calls).toEqual(['tls_reload']);

      // Nothing changed: nothing is fetched, written or reloaded.
      h.mi.calls.length = 0;
      let fetched = 0;
      const original = h.orgClient.findCertificate.bind(h.orgClient);
      h.orgClient.findCertificate = (fqdn) => {
        fetched += 1;
        return original(fqdn);
      };
      try {
        expect(await sync().syncAll()).toEqual({ written: [], removed: [] });
      } finally {
        h.orgClient.findCertificate = original;
      }
      expect(fetched).toBe(0);
      expect(h.mi.calls).toEqual([]);
    });

    it('repairs a row that was changed or deleted by hand, and only that one', async () => {
      h.orgClient.certificates['sip.a.test'] = {
        resellerId: 'r1',
        version: 1,
        certificate: pem('a'),
        privateKey: key('a'),
      };
      h.orgClient.certificates['sip.b.test'] = {
        resellerId: 'r2',
        version: 1,
        certificate: pem('b'),
        privateKey: key('b'),
      };
      await sync().syncAll();
      await h.opensipsDb.kysely
        .updateTable('tls_mgm')
        .set({ certificate: pem('tampered') })
        .where('domain', '=', 'sip.a.test')
        .execute();
      await h.opensipsDb.kysely.deleteFrom('tls_mgm').where('domain', '=', 'sip.b.test').execute();
      h.mi.calls.length = 0;

      const pass = await sync().syncAll();

      expect([...pass.written].sort()).toEqual(['sip.a.test', 'sip.b.test']);
      const back = await rows();
      expect(back.find((r) => r.domain === 'sip.a.test')?.certificate).toBe(pem('a'));
      expect(back.find((r) => r.domain === 'sip.b.test')?.certificate).toBe(pem('b'));
      expect(h.mi.calls).toEqual(['tls_reload']);
    });

    it('picks up a renewal by its new fingerprint', async () => {
      h.orgClient.certificates['sip.a.test'] = {
        resellerId: 'r1',
        version: 1,
        certificate: pem('old'),
        privateKey: key('old'),
      };
      await sync().syncAll();
      h.orgClient.certificates['sip.a.test'] = {
        resellerId: 'r1',
        version: 2,
        certificate: pem('new'),
        privateKey: key('new'),
      };

      expect((await sync().syncAll()).written).toEqual(['sip.a.test']);
      expect((await rows())[0]?.certificate).toBe(pem('new'));
    });

    it('removes a row whose certificate org-service no longer holds, and the default when the platform has none', async () => {
      h.orgClient.certificates['sip.platform.test'] = {
        resellerId: null,
        version: 1,
        certificate: pem('p'),
        privateKey: key('p'),
      };
      h.orgClient.certificates['sip.a.test'] = {
        resellerId: 'r1',
        version: 1,
        certificate: pem('a'),
        privateKey: key('a'),
      };
      await sync().syncAll();
      h.mi.calls.length = 0;

      delete h.orgClient.certificates['sip.a.test'];
      const pass = await sync().syncAll();
      expect(pass.removed).toEqual(['sip.a.test']);
      expect((await rows()).map((r) => r.domain)).toEqual(['default', 'sip.platform.test']);
      expect(h.mi.calls).toEqual(['tls_reload']);

      delete h.orgClient.certificates['sip.platform.test'];
      const later = await sync().syncAll();
      expect([...later.removed].sort()).toEqual(['default', 'sip.platform.test']);
      expect(await rows()).toEqual([]);
    });

    it('agrees with the fingerprint org-service reports', () => {
      expect(certificateFingerprint('x')).toBe(
        '2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881',
      );
    });
  });
});

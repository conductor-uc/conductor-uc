import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createDatabase, migrateToLatest, type Database } from '@cuc/db';
import type { Bus, EventEnvelope } from '@cuc/events';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';
import { databaseOrSkipReason, silentLogger, startTestDatabase } from '@cuc/testing';

import { migrations } from '../migrations/index.js';
import type { CertificateRepo } from '../src/repo/certificate.repo.js';
import { createPlatformNetworkRepo } from '../src/repo/platform-network.repo.js';
import { registerNetworkRoutes } from '../src/routes/network.routes.js';
import type { OrgServiceDb } from '../src/schema.js';

const skipReason = await databaseOrSkipReason();
const SECRET = 'test-internal-header-secret';

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

describe.skipIf(skipReason !== undefined)('network settings and DNS records routes', () => {
  let db: Database<OrgServiceDb>;
  let app: Server;
  let bus: ReturnType<typeof fakeBus>;
  let stop: () => Promise<void>;
  const listed: { resellerId: string | null }[] = [];

  beforeAll(async () => {
    const logger = silentLogger();
    const handle = await startTestDatabase();
    db = createDatabase<OrgServiceDb>({
      host: handle.host,
      port: handle.port,
      user: handle.user,
      password: handle.password,
      database: handle.database,
      logger,
    });
    await migrateToLatest({ db: db.kysely, migrations, logger });
    bus = fakeBus();
    const certs = {
      list: (filter: { resellerId: string | null }) => {
        listed.push(filter);
        return Promise.resolve([
          { fqdn: 'sip.voice.reseller.test', purpose: 'sip' },
          { fqdn: 'portal.reseller.test', purpose: 'console' },
        ]);
      },
    } as unknown as CertificateRepo;
    app = await createServer({
      serviceName: 'org-service',
      logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
    });
    registerNetworkRoutes(app, createPlatformNetworkRepo(db), certs, bus);
    await app.ready();
    stop = async () => {
      await app.close();
      await db.destroy();
      await handle.stop();
    };
  });

  afterAll(async () => {
    await stop?.();
  });

  beforeEach(async () => {
    await db.kysely.deleteFrom('platform_network').execute();
    bus.published.length = 0;
    listed.length = 0;
  });

  const as = (orgType: 'master' | 'reseller') =>
    signInternalHeaders(SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: `${orgType}-org`,
      orgType,
    });

  it('starts with no address, and the operator saves one, which is audited', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/platform/network-settings',
      headers: as('master'),
    });
    expect(before.json()).toEqual({ publicAddress: null });

    const saved = await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: ' 203.0.113.10 ' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(saved.json()).toEqual({ publicAddress: '203.0.113.10' });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/platform/network-settings',
      headers: as('master'),
    });
    expect(after.json()).toEqual({ publicAddress: '203.0.113.10' });
    expect(bus.published.map((e) => e.type)).toEqual(['audit.event.recorded']);
    expect(JSON.stringify(bus.published[0])).toContain('platform.network_settings.updated');
  });

  it('refuses something that is not an address, and lets the operator clear it', async () => {
    const bad = await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: 'https://edge.example.com' },
    });
    expect(bad.statusCode).toBe(400);
    expect(bad.body).toContain('invalid_public_address');

    await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: 'edge.example.com' },
    });
    const cleared = await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: null },
    });
    expect(cleared.json()).toEqual({ publicAddress: null });
  });

  it("is the operator's alone to see or change", async () => {
    for (const method of ['GET', 'PUT'] as const) {
      const response = await app.inject({
        method,
        url: '/v1/platform/network-settings',
        headers: as('reseller'),
        ...(method === 'PUT' ? { payload: { publicAddress: '203.0.113.10' } } : {}),
      });
      expect(response.statusCode, method).toBe(403);
    }
    expect(await db.kysely.selectFrom('platform_network').selectAll().execute()).toEqual([]);
  });

  it('tells a reseller which records to publish, one per name it keeps a certificate for', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: '203.0.113.10' },
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/resellers/r-1/dns-records',
      headers: as('reseller'),
    });

    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toEqual({
      publicAddress: '203.0.113.10',
      rows: [
        { name: 'sip.voice.reseller.test', type: 'A', value: '203.0.113.10', purpose: 'sip' },
        { name: 'portal.reseller.test', type: 'A', value: '203.0.113.10', purpose: 'console' },
      ],
    });
    expect(listed).toEqual([{ resellerId: 'r-1' }]);
  });

  it('uses a CNAME for a hostname, an AAAA for IPv6, and no value until the address is known', async () => {
    const get = async () =>
      (
        await app.inject({
          method: 'GET',
          url: '/v1/resellers/r-1/dns-records',
          headers: as('reseller'),
        })
      ).json<{
        publicAddress: string | null;
        rows: { type: string; value: string | null }[];
      }>();
    expect((await get()).rows.map((r) => [r.type, r.value])).toEqual([
      ['A', null],
      ['A', null],
    ]);
    await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: 'edge.example.com' },
    });
    expect((await get()).rows.map((r) => [r.type, r.value])).toEqual([
      ['CNAME', 'edge.example.com'],
      ['CNAME', 'edge.example.com'],
    ]);
    await app.inject({
      method: 'PUT',
      url: '/v1/platform/network-settings',
      headers: as('master'),
      payload: { publicAddress: '2001:db8::10' },
    });
    expect((await get()).rows[0]?.type).toBe('AAAA');
  });
});

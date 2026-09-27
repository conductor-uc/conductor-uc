import { createServer, type Server } from '@cuc/http';
import { databaseOrSkipReason } from '@cuc/testing';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import type { OpenSipsMiClient } from '../src/opensips-mi-client.js';
import { createPresenceWatcher, registeredAors, type PresenceWatcher } from '../src/presence.js';
import { registerPresenceRoutes } from '../src/routes/presence.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = await databaseOrSkipReason();
const TOKEN = 'test-internal-service-token';

/** `ul_dump`'s answer as OpenSIPs 3.6 gave it live, for the AORs given (`user@domain` → Expires). */
function ulDump(aors: Record<string, (number | string)[]>) {
  return {
    Domains: [
      {
        name: 'location',
        hash_size: 512,
        AORs: Object.entries(aors).map(([aor, expires]) => ({
          AOR: aor,
          Contacts: expires.map((value) => ({
            Contact: `sip:${aor.split('@')[0] ?? ''}@172.19.0.25:6000`,
            Expires: value,
            State: 'CS_NEW',
          })),
        })),
      },
    ],
  };
}

describe('registeredAors (S5-10)', () => {
  it('counts an AOR with a live contact, lowercased; not one whose contacts are all deleted', () => {
    const result = ulDump({
      '301@Queue.Platform.Test': ['deleted', 299],
      '302@queue.platform.test': ['deleted'],
      '303@queue.platform.test': ['permanent'],
      '304@queue.platform.test': [0],
    });
    expect([...registeredAors(result)].sort()).toEqual([
      '301@queue.platform.test',
      '303@queue.platform.test',
    ]);
  });

  it('reads nothing from an answer it does not recognize', () => {
    for (const odd of [undefined, null, 'x', {}, { Domains: 'x' }, { Domains: [{ AORs: [{}] }] }]) {
      expect(registeredAors(odd).size).toBe(0);
    }
  });
});

describe.skipIf(skipReason !== undefined)(
  'presence watcher and GET /internal/v1/tenants/:tenantId/presence (S5-10)',
  () => {
    let h: Harness;
    let app: Server;
    let watcher: PresenceWatcher;
    /** What OpenSIPs answers next; an Error makes the MI call fail. */
    let dump: unknown = ulDump({});
    const mi: OpenSipsMiClient = {
      call: () => Promise.resolve(),
      query: <T>(method: string) => {
        if (method !== 'ul_dump') return Promise.reject(new Error(`unexpected ${method}`));
        return dump instanceof Error ? Promise.reject(dump) : Promise.resolve(dump as T);
      },
    };

    beforeAll(async () => {
      h = await startHarness();
      watcher = createPresenceWatcher({ db: h.db, mi, logger: h.logger });
      app = await createServer({ serviceName: 'telephony-config', logger: h.logger });
      registerPresenceRoutes(app, { presence: watcher, internalServiceToken: TOKEN });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
      dump = ulDump({});
    });

    /** A tenant with a domain and extensions `numbers` (SIP username = number). */
    async function tenant(fqdn: string, numbers: string[]) {
      const tenantId = crypto.randomUUID();
      await h.readModel.upsertTenant(h.db.kysely, { id: tenantId, status: 'active' });
      await h.readModel.upsertDomain(h.db.kysely, { id: crypto.randomUUID(), tenantId, fqdn });
      const ids: Record<string, string> = {};
      for (const number of numbers) {
        const id = crypto.randomUUID();
        ids[number] = id;
        await h.readModel.upsertExtension(h.db.kysely, {
          id,
          tenantId,
          number,
          username: number,
          ha1: 'x',
          realm: fqdn,
          callerIdName: null,
          callerIdNumber: null,
          emergencyLocationId: crypto.randomUUID(),
        });
      }
      return { tenantId, ids };
    }

    async function setDnd(tenantId: string, extensionId: string, dnd: boolean) {
      await h.readModel.upsertCallHandling(h.db.kysely, {
        extensionId,
        tenantId,
        settings: {
          dnd,
          dndAction: 'voicemail',
          forwardAlways: null,
          forwardBusy: null,
          forwardNoAnswer: null,
          noAnswerSeconds: 20,
          forwardUnreachable: null,
          simultaneousRing: [],
        },
      });
    }

    interface Announced {
      readonly tenantId: string;
      readonly extensionId: string;
      readonly extension: string;
      readonly registered: boolean;
      readonly dnd: boolean;
    }

    async function announced(): Promise<Announced[]> {
      const rows = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'tenant_id as tenantId', 'payload'])
        .where('type', '=', 'call.presence.changed')
        .execute();
      await h.db.kysely.deleteFrom('outbox').execute();
      return rows.map((row) => ({
        tenantId: row.tenantId ?? '',
        ...((typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload) as Omit<
          Announced,
          'tenantId'
        >),
      }));
    }

    it('announces every extension once, then only what changes', async () => {
      const acme = await tenant('acme.platform.test', ['101', '102']);
      dump = ulDump({ '101@acme.platform.test': [300] });

      expect(await watcher.pollOnce()).toBe(2);
      expect(await announced()).toEqual(
        expect.arrayContaining([
          {
            tenantId: acme.tenantId,
            extensionId: acme.ids['101'],
            extension: '101',
            registered: true,
            dnd: false,
          },
          {
            tenantId: acme.tenantId,
            extensionId: acme.ids['102'],
            extension: '102',
            registered: false,
            dnd: false,
          },
        ]),
      );

      expect(await watcher.pollOnce()).toBe(0);
      expect(await announced()).toEqual([]);

      dump = ulDump({ '101@acme.platform.test': ['deleted'], '102@acme.platform.test': [60] });
      await setDnd(acme.tenantId, acme.ids['101']!, true);
      expect(await watcher.pollOnce()).toBe(2);
      expect(await announced()).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ extension: '101', registered: false, dnd: true }),
          expect.objectContaining({ extension: '102', registered: true, dnd: false }),
        ]),
      );
    });

    it('matches the registration to the tenant’s own domain, not another tenant’s', async () => {
      const acme = await tenant('acme.platform.test', ['101']);
      const other = await tenant('other.platform.test', ['101']);
      dump = ulDump({ '101@other.platform.test': [300] });

      await watcher.pollOnce();
      const byTenant = Object.fromEntries(
        (await announced()).map((event) => [event.tenantId, event]),
      );
      expect(byTenant[acme.tenantId]).toMatchObject({ registered: false });
      expect(byTenant[other.tenantId]).toMatchObject({ registered: true });
    });

    it('changes nothing when OpenSIPs cannot be asked', async () => {
      const acme = await tenant('acme.platform.test', ['101']);
      dump = ulDump({ '101@acme.platform.test': [300] });
      await watcher.pollOnce();
      await announced();

      dump = new Error('connection refused');
      await expect(watcher.pollOnce()).rejects.toThrow('connection refused');
      expect(await announced()).toEqual([]);
      expect(await watcher.forTenant(acme.tenantId)).toEqual([
        { extensionId: acme.ids['101'], extension: '101', registered: true, dnd: false },
      ]);
    });

    it('forgets an extension that is gone', async () => {
      const acme = await tenant('acme.platform.test', ['101']);
      await watcher.pollOnce();
      await h.db.kysely.deleteFrom('extensions').where('id', '=', acme.ids['101']!).execute();
      await watcher.pollOnce();
      expect(await h.db.kysely.selectFrom('extension_presence').selectAll().execute()).toEqual([]);
    });

    it('serves the tenant’s extensions in number order, as last announced, to a service only', async () => {
      const acme = await tenant('acme.platform.test', ['1000', '99', '101']);
      await tenant('other.platform.test', ['500']);
      dump = ulDump({ '101@acme.platform.test': [300] });
      await setDnd(acme.tenantId, acme.ids['99']!, true);
      await watcher.pollOnce();
      // Registered after the last pass: not announced yet, so not in the snapshot either.
      dump = ulDump({ '101@acme.platform.test': [300], '1000@acme.platform.test': [300] });

      const url = `/internal/v1/tenants/${acme.tenantId}/presence`;
      expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
      const response = await app.inject({
        method: 'GET',
        url,
        headers: { authorization: `Bearer ${TOKEN}` },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        extensions: [
          { extensionId: acme.ids['99'], extension: '99', registered: false, dnd: true },
          { extensionId: acme.ids['101'], extension: '101', registered: true, dnd: false },
          { extensionId: acme.ids['1000'], extension: '1000', registered: false, dnd: false },
        ],
      });
    });
  },
);

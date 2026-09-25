import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import type { NormalizedCdr } from '../src/domain/cdr.js';
import { PbxClientError, type UserExtensionLookup } from '../src/pbx-client.js';
import { registerCdrRoutes } from '../src/routes/cdr.routes.js';
import { registerMeRoutes } from '../src/routes/me.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const SECRET = 'test-internal-header-secret';
const SELF = ['self.settings', 'self.voicemail', 'self.history'];

const held: Record<string, string[]> = {};
/** `${tenantId}:${userId}` to that person's extension number: pbx-config-service's answer, set per test. */
const numbers = new Map<string, string>();
let pbxDown = false;
const userExtension: UserExtensionLookup = (tenantId, userId) => {
  if (pbxDown) return Promise.reject(new PbxClientError('down'));
  const number = numbers.get(`${tenantId}:${userId}`);
  return Promise.resolve(
    number === undefined ? undefined : { extensionId: `ext-${number}`, number },
  );
};

function call(tenantId: string, overrides: Partial<NormalizedCdr> = {}): NormalizedCdr {
  return {
    tenantId,
    callUuid: crypto.randomUUID(),
    nodeId: 'fs-1',
    direction: 'internal',
    startAt: new Date('2026-01-15T10:00:00.000Z'),
    answerAt: new Date('2026-01-15T10:00:02.000Z'),
    endAt: new Date('2026-01-15T10:00:30.000Z'),
    durationSec: 30,
    billableSec: 28,
    fromNumber: '101',
    fromName: null,
    toNumber: '102',
    dialedNumber: '102',
    did: null,
    trunkId: 'trunk-secret-id',
    disposition: 'answered',
    hangupCause: 'NORMAL_CLEARING',
    hangupBy: 'caller',
    legs: null,
    sip: {},
    ...overrides,
  };
}

describe.skipIf(skipReason !== undefined)('end-user self-service in cdr-service', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'cdr-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: SECRET },
      permissions: (actor, permission) =>
        Promise.resolve(held[actor.id]?.includes(permission) ?? false),
    });
    registerCdrRoutes(app, h.cdrs, h.exports, h.storage);
    registerMeRoutes(app, h.cdrs, userExtension);
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
    numbers.clear();
    pbxDown = false;
    for (const key of Object.keys(held)) delete held[key];
  });

  function person(
    tenantId: string,
    userId: string,
    permissions: string[] = SELF,
    extra: { orgType?: 'tenant' | 'reseller' | 'master'; orgId?: string } = {},
  ) {
    held[userId] = permissions;
    return signInternalHeaders(SECRET, {
      actorId: userId,
      actorType: 'user',
      orgId: extra.orgId ?? tenantId,
      orgType: extra.orgType ?? 'tenant',
      ...(extra.orgType === undefined || extra.orgType === 'tenant' ? { tenantId } : {}),
    });
  }

  const url = (tenantId: string, query = '') => `/v1/tenants/${tenantId}/me/calls${query}`;

  async function seed(tenantId: string) {
    // 101 calls 102, 103 calls 104, someone external calls 101 through a DID.
    await h.cdrs.ingest(call(tenantId), null);
    await h.cdrs.ingest(
      call(tenantId, { fromNumber: '103', toNumber: '104', dialedNumber: '104' }),
      null,
    );
    await h.cdrs.ingest(
      call(tenantId, {
        direction: 'inbound',
        fromNumber: '+15005550100',
        toNumber: '101',
        dialedNumber: '+15005550101',
        did: '+15005550101',
        startAt: new Date('2026-01-16T10:00:00.000Z'),
        endAt: new Date('2026-01-16T10:01:00.000Z'),
      }),
      null,
    );
    await h.cdrs.ingest(
      call(tenantId, { fromNumber: '105', toNumber: '106', dialedNumber: '106' }),
      null,
    );
  }

  it('declares self.history and the private class (CLAUDE.md rule 3): H1 walls off resellers', () => {
    const routes = app.registeredRoutes.filter(
      (r) => r.url.includes('/me/') && r.method !== 'HEAD',
    );
    expect(routes.map((r) => `${r.method} ${r.url}`)).toEqual([
      'GET /v1/tenants/:tenantId/me/calls',
    ]);
    expect(routes[0]?.permission).toBe('self.history');
    expect(routes[0]?.dataClass).toBe('private');
  });

  it('lists only calls to, from or dialed as my extension, newest first', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    numbers.set(`${tenantId}:user-b`, '103');
    await seed(tenantId);

    const response = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: person(tenantId, 'user-a'),
    });
    expect(response.statusCode).toBe(200);
    const rows = response.json<{ rows: { fromNumber: string; toNumber: string }[] }>().rows;
    expect(rows.map((r) => `${r.fromNumber}>${r.toNumber}`)).toEqual([
      '+15005550100>101',
      '101>102',
    ]);

    const other = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: person(tenantId, 'user-b'),
    });
    expect(other.json<{ rows: { fromNumber: string }[] }>().rows.map((r) => r.fromNumber)).toEqual([
      '103',
    ]);
  });

  it('shows a person’s view of a call, without trunk, flow, recording or extension ids', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    await seed(tenantId);
    const response = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: person(tenantId, 'user-a'),
    });
    const [row] = response.json<{ rows: Record<string, unknown>[] }>().rows;
    expect(Object.keys(row ?? {}).sort()).toEqual(
      [
        'answerAt',
        'direction',
        'disposition',
        'dialedNumber',
        'durationSec',
        'endAt',
        'fromName',
        'fromNumber',
        'id',
        'startAt',
        'toNumber',
      ].sort(),
    );
    expect(response.body).not.toContain('trunk-secret-id');
  });

  it('no parameter changes whose history it is', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    await seed(tenantId);
    const asA = person(tenantId, 'user-a');
    for (const query of [
      '?number=103',
      '?number=105&did=+15005550101',
      '?userId=user-b',
      '?extensionId=ext-103',
      '?number=',
    ]) {
      const response = await app.inject({ method: 'GET', url: url(tenantId, query), headers: asA });
      expect(response.statusCode, query).toBe(200);
      const numbersSeen = response
        .json<{ rows: { fromNumber: string; toNumber: string }[] }>()
        .rows.flatMap((r) => [r.fromNumber, r.toNumber]);
      expect(
        numbersSeen.every((n) => n !== '103' && n !== '104' && n !== '105' && n !== '106'),
        query,
      ).toBe(true);
      expect(numbersSeen.length, query).toBe(4);
    }
  });

  it('paging and filters keep to my own history', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    await seed(tenantId);
    const asA = person(tenantId, 'user-a');

    const first = await app.inject({ method: 'GET', url: url(tenantId, '?limit=1'), headers: asA });
    const page1 = first.json<{ rows: { fromNumber: string }[]; nextCursor: string | null }>();
    expect(page1.rows).toHaveLength(1);
    expect(page1.nextCursor).not.toBeNull();
    const second = await app.inject({
      method: 'GET',
      url: url(tenantId, `?limit=1&cursor=${page1.nextCursor ?? ''}`),
      headers: asA,
    });
    expect(
      second.json<{ rows: { fromNumber: string }[]; nextCursor: string | null }>(),
    ).toMatchObject({
      rows: [{ fromNumber: '101' }],
      nextCursor: null,
    });

    const inbound = await app.inject({
      method: 'GET',
      url: url(tenantId, '?direction=inbound'),
      headers: asA,
    });
    expect(inbound.json<{ rows: unknown[] }>().rows).toHaveLength(1);
  });

  it('takes the page size as the digit string a query string carries, and refuses one out of range', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    await seed(tenantId);
    const asA = person(tenantId, 'user-a');
    for (const bad of ['0', '201', 'abc', '-1']) {
      const response = await app.inject({
        method: 'GET',
        url: url(tenantId, `?limit=${bad}`),
        headers: asA,
      });
      expect(response.statusCode, bad).toBe(400);
    }
    // The admin list had the same bug (a Number in the query schema refused every real request).
    const admin = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/cdrs?limit=2`,
      headers: person(tenantId, 'admin-1', ['cdr.read']),
    });
    expect(admin.statusCode).toBe(200);
    expect(admin.json<{ rows: unknown[] }>().rows).toHaveLength(2);
  });

  it('another tenant’s calls under the same extension number are never mine', async () => {
    const t1 = crypto.randomUUID();
    const t2 = crypto.randomUUID();
    numbers.set(`${t1}:user-a`, '101');
    await h.cdrs.ingest(
      call(t2, { fromNumber: '101', toNumber: '999', dialedNumber: '999' }),
      null,
    );
    const response = await app.inject({
      method: 'GET',
      url: url(t1),
      headers: person(t1, 'user-a'),
    });
    expect(response.json<{ rows: unknown[] }>().rows).toEqual([]);
  });

  it('a person with no linked extension gets a clear 404', async () => {
    const tenantId = crypto.randomUUID();
    await seed(tenantId);
    const response = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: person(tenantId, 'user-a'),
    });
    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'no_linked_extension' });
  });

  it('fails with 503, never with a wider list, when pbx-config-service is unreachable', async () => {
    const tenantId = crypto.randomUUID();
    numbers.set(`${tenantId}:user-a`, '101');
    await seed(tenantId);
    pbxDown = true;
    const response = await app.inject({
      method: 'GET',
      url: url(tenantId),
      headers: person(tenantId, 'user-a'),
    });
    expect(response.statusCode).toBe(503);
    expect(response.body).not.toContain('fromNumber');
  });

  describe('who can reach it', () => {
    it.each(['reseller', 'master'] as const)(
      'a %s is refused: H1 for a reseller, no "me" for either',
      async (orgType) => {
        const tenantId = crypto.randomUUID();
        numbers.set(`${tenantId}:user-a`, '101');
        await seed(tenantId);
        const headers = person(tenantId, 'user-a', [...SELF, 'cdr.read'], {
          orgType,
          orgId: crypto.randomUUID(),
        });
        const response = await app.inject({ method: 'GET', url: url(tenantId), headers });
        expect(response.statusCode).toBe(403);
        expect(response.json()).toMatchObject({
          code: orgType === 'reseller' ? 'reseller_private_data_denied' : 'self_service_only',
        });
      },
    );

    it('a person of another tenant naming this one is refused at the tenant boundary (H2)', async () => {
      const t1 = crypto.randomUUID();
      const t2 = crypto.randomUUID();
      numbers.set(`${t1}:user-a`, '101');
      await seed(t1);
      const response = await app.inject({
        method: 'GET',
        url: url(t1),
        headers: person(t2, 'user-a'),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'tenant_boundary' });
    });

    it('a person without self.history is refused', async () => {
      const tenantId = crypto.randomUUID();
      numbers.set(`${tenantId}:user-a`, '101');
      const response = await app.inject({
        method: 'GET',
        url: url(tenantId),
        headers: person(tenantId, 'user-a', ['self.settings', 'self.voicemail']),
      });
      expect(response.statusCode).toBe(403);
      expect(response.json()).toMatchObject({ code: 'permission_denied' });
    });

    it('a self-service user cannot use the admin CDR routes to read or export anyone’s calls', async () => {
      const tenantId = crypto.randomUUID();
      numbers.set(`${tenantId}:user-a`, '101');
      await seed(tenantId);
      const asA = person(tenantId, 'user-a');
      const one = (await h.cdrs.list({ tenantId }, {})).rows[0];
      for (const [method, path] of [
        ['GET', '/cdrs'],
        ['GET', '/cdrs?number=103'],
        ['GET', `/cdrs/${one?.id ?? 'x'}`],
        ['POST', '/cdr-exports'],
        ['GET', `/cdr-exports/${crypto.randomUUID()}`],
      ] as const) {
        const response = await app.inject({
          method,
          url: `/v1/tenants/${tenantId}${path}`,
          headers: asA,
          ...(method === 'POST'
            ? { payload: { from: '2026-01-01T00:00:00Z', to: '2026-02-01T00:00:00Z' } }
            : {}),
        });
        expect(response.statusCode, `${method} ${path}`).toBe(403);
      }
    });
  });
});

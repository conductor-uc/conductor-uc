import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import type { NormalizedCdr } from '../src/domain/cdr.js';
import { registerCdrRoutes } from '../src/routes/cdr.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

function sample(overrides: Partial<NormalizedCdr> = {}): NormalizedCdr {
  return {
    tenantId: 'tenant-a',
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
    trunkId: null,
    disposition: 'answered',
    hangupCause: 'NORMAL_CLEARING',
    hangupBy: 'caller',
    legs: null,
    sip: {},
    ...overrides,
  };
}

describe.skipIf(skipReason !== undefined)('cdr HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'cdr-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerCdrRoutes(app, h.cdrs, h.exports, h.storage);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function tenantHeaders(tenantId: string, orgType: 'tenant' | 'reseller' | 'master' = 'tenant') {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType,
      tenantId,
    });
  }

  it('every route declares permission and dataClass (CLAUDE.md rule 3)', () => {
    for (const route of app.registeredRoutes) {
      if (route.url.startsWith('/v1/tenants/:tenantId/cdr')) {
        expect(route.permission, `${route.method} ${route.url}`).not.toBeNull();
        expect(route.dataClass, `${route.method} ${route.url}`).not.toBeNull();
      }
    }
  });

  it('lists and gets a CDR', async () => {
    const created = await h.cdrs.ingest(sample(), null);

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdrs`,
      headers: tenantHeaders('tenant-a'),
    });
    expect(listed.statusCode).toBe(200);
    const listedBody: { rows: { id: string }[] } = listed.json();
    expect(listedBody.rows).toHaveLength(1);

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdrs/${created.id}`,
      headers: tenantHeaders('tenant-a'),
    });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({ id: created.id, disposition: 'answered' });
  });

  it('404s getting an unknown CDR', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdrs/${crypto.randomUUID()}`,
      headers: tenantHeaders('tenant-a'),
    });
    expect(response.statusCode).toBe(404);
  });

  it('a reseller actor gets 403 on the CDR endpoints (H1)', async () => {
    await h.cdrs.ingest(sample(), null);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdrs`,
      headers: tenantHeaders('tenant-a', 'reseller'),
    });
    expect(response.statusCode).toBe(403);
  });

  it('a master actor is allowed on the CDR endpoints', async () => {
    await h.cdrs.ingest(sample(), null);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdrs`,
      headers: tenantHeaders('tenant-a', 'master'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('creates a CDR export job', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/tenant-a/cdr-exports`,
      headers: tenantHeaders('tenant-a'),
      payload: { from: '2026-01-01T00:00:00.000Z', to: '2026-01-31T00:00:00.000Z' },
    });
    expect(response.statusCode).toBe(201);
    expect(response.json()).toMatchObject({ status: 'pending', downloadUrl: null });
  });

  it('rejects an export request with to before from', async () => {
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/tenant-a/cdr-exports`,
      headers: tenantHeaders('tenant-a'),
      payload: { from: '2026-01-31T00:00:00.000Z', to: '2026-01-01T00:00:00.000Z' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('returns a download URL only once an export is ready', async () => {
    const created = await h.exports.create(
      { tenantId: 'tenant-a' },
      new Date('2026-01-01'),
      new Date('2026-01-31'),
    );

    const pending = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdr-exports/${created.id}`,
      headers: tenantHeaders('tenant-a'),
    });
    expect(pending.json()).toMatchObject({ status: 'pending', downloadUrl: null });

    await h.storage.forTenant('tenant-a').provisionBucket();
    await h.storage
      .forTenant('tenant-a')
      .putObject('cdr-exports/tenant-a/export.csv', Buffer.from('id\r\n'), {
        contentType: 'text/csv',
      });
    await h.exports.markReady(created.id, 'cdr-exports/tenant-a/export.csv');

    const ready = await app.inject({
      method: 'GET',
      url: `/v1/tenants/tenant-a/cdr-exports/${created.id}`,
      headers: tenantHeaders('tenant-a'),
    });
    const readyBody: { status: string; downloadUrl: string | null } = ready.json();
    expect(readyBody.status).toBe('ready');
    expect(readyBody.downloadUrl).not.toBeNull();
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerIngestRoutes } from '../src/routes/ingest.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TOKEN = 'test-cdr-ingest-token';
const BASIC_AUTH = `Basic ${Buffer.from(`fs-node:${TOKEN}`).toString('base64')}`;

function samplePayload(overrides: Record<string, string> = {}): Record<string, unknown> {
  return {
    variables: {
      uuid: crypto.randomUUID(),
      cuc_node_id: 'fs-1',
      cuc_tenant_id: 'tenant-a',
      'sip_h_X-Call-Direction': 'internal',
      start_epoch: '1700000000',
      answer_epoch: '1700000005',
      end_epoch: '1700000030',
      duration: '30',
      billsec: '25',
      sip_from_user: '101',
      sip_to_user: '102',
      destination_number: '102',
      hangup_cause: 'NORMAL_CLEARING',
      sip_hangup_disposition: 'send_bye',
      ...overrides,
    },
  };
}

describe.skipIf(skipReason !== undefined)('POST /ingest/json-cdr', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'cdr-service', logger: h.logger });
    registerIngestRoutes(app, h.cdrs, h.orgClient.resellerForTenant, TOKEN);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
    h.orgClient.resellers = {};
  });

  it('ingests a valid payload and denormalizes the reseller id', async () => {
    h.orgClient.resellers['tenant-a'] = 'reseller-a';

    const response = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { authorization: BASIC_AUTH, 'content-type': 'application/json' },
      payload: samplePayload(),
    });
    expect(response.statusCode).toBe(200);

    const rows = await h.db.kysely.selectFrom('cdrs').selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tenant_id: 'tenant-a', reseller_id: 'reseller-a' });
  });

  it('401s with no auth', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { 'content-type': 'application/json' },
      payload: samplePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('401s with the wrong token', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: {
        authorization: `Basic ${Buffer.from('fs-node:wrong').toString('base64')}`,
        'content-type': 'application/json',
      },
      payload: samplePayload(),
    });
    expect(response.statusCode).toBe(401);
  });

  it('200s (not an error) on a malformed payload, and does not insert a row', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { authorization: BASIC_AUTH, 'content-type': 'application/json' },
      payload: { not: 'a real cdr' },
    });
    expect(response.statusCode).toBe(200);

    const rows = await h.db.kysely.selectFrom('cdrs').selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  it('200s (not an error) on a duplicate ingest for the same call_uuid/node', async () => {
    const payload = samplePayload();

    const first = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { authorization: BASIC_AUTH, 'content-type': 'application/json' },
      payload,
    });
    expect(first.statusCode).toBe(200);

    const second = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { authorization: BASIC_AUTH, 'content-type': 'application/json' },
      payload,
    });
    expect(second.statusCode).toBe(200);

    const rows = await h.db.kysely.selectFrom('cdrs').selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  it('ingests with a null reseller_id when the org-service lookup has no answer', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/ingest/json-cdr',
      headers: { authorization: BASIC_AUTH, 'content-type': 'application/json' },
      payload: samplePayload(),
    });
    expect(response.statusCode).toBe(200);

    const rows = await h.db.kysely.selectFrom('cdrs').selectAll().execute();
    expect(rows[0]?.reseller_id).toBeNull();
  });
});

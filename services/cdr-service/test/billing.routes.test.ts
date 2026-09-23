import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import type { NormalizedCdr } from '../src/domain/cdr.js';
import { registerBillingRoutes } from '../src/routes/billing.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

function sample(overrides: Partial<NormalizedCdr> = {}): NormalizedCdr {
  return {
    tenantId: 'tenant-a',
    callUuid: crypto.randomUUID(),
    nodeId: 'fs-1',
    direction: 'outbound',
    startAt: new Date('2026-01-15T10:00:00.000Z'),
    answerAt: new Date('2026-01-15T10:00:02.000Z'),
    endAt: new Date('2026-01-15T10:00:30.000Z'),
    durationSec: 30,
    billableSec: 28,
    fromNumber: '101',
    fromName: null,
    toNumber: '+15551234567',
    dialedNumber: '+15551234567',
    did: null,
    trunkId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    disposition: 'answered',
    hangupCause: 'NORMAL_CLEARING',
    hangupBy: 'caller',
    legs: { some: 'raw callflow data' },
    sip: { codec: 'PCMU' },
    ...overrides,
  };
}

describe.skipIf(skipReason !== undefined)('billing HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'cdr-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerBillingRoutes(app, h.cdrs);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function headers(orgType: 'tenant' | 'reseller' | 'master') {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: 'tenant-a',
      orgType,
      tenantId: 'tenant-a',
    });
  }

  it('declares billing.read / usage on the billing-records route', () => {
    const route = app.registeredRoutes.find(
      (r) => r.url === '/v1/tenants/:tenantId/billing-records',
    );
    expect(route?.permission).toBe('billing.read');
    expect(route?.dataClass).toBe('usage');
  });

  it('a reseller actor is NOT blocked by H1 on the usage-class billing view (C-1/D-013)', async () => {
    await h.cdrs.ingest(sample(), null);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/tenant-a/billing-records',
      headers: headers('reseller'),
    });
    expect(response.statusCode).toBe(200);
  });

  it('returns only the C-1-approved fields, never legs/sip/caller name/extension detail', async () => {
    await h.cdrs.ingest(sample({ fromName: 'Jane Doe' }), null);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/tenant-a/billing-records',
      headers: headers('reseller'),
    });
    const body: { rows: Record<string, unknown>[] } = response.json();
    expect(body.rows).toHaveLength(1);
    const record = body.rows[0];
    expect(record).toMatchObject({
      direction: 'outbound',
      billableSec: 28,
      toNumber: '+15551234567',
      trunkId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    });
    expect(record).not.toHaveProperty('legs');
    expect(record).not.toHaveProperty('sip');
    expect(record).not.toHaveProperty('fromName');
    expect(record).not.toHaveProperty('extensionIds');
    expect(record).not.toHaveProperty('recordingIds');
  });

  it('the full destination number is exposed, not a truncated prefix (issue #95 answer 1)', async () => {
    await h.cdrs.ingest(sample({ toNumber: '+15559876543' }), null);

    const response = await app.inject({
      method: 'GET',
      url: '/v1/tenants/tenant-a/billing-records',
      headers: headers('reseller'),
    });
    const body: { rows: { toNumber: string }[] } = response.json();
    expect(body.rows[0]?.toNumber).toBe('+15559876543');
  });
});

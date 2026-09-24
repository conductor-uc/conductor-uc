import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { registerScheduleInternalRoutes } from '../src/routes/schedule-internal.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)('schedule internal route', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({ serviceName: 'pbx-config-service', logger: h.logger });
    registerScheduleInternalRoutes(app, h.schedules, TOKEN);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  async function make(tenantId: string) {
    return h.schedules.create(
      { tenantId },
      {
        label: 'Office hours',
        timezone: 'America/Chicago',
        rules: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }],
        holidays: [{ date: '2026-07-03' }],
      },
    );
  }

  const auth = { authorization: `Bearer ${TOKEN}` };

  it('says whether the schedule is open at a given instant', async () => {
    const tenantId = crypto.randomUUID();
    const schedule = await make(tenantId);
    const url = `/internal/v1/tenants/${tenantId}/schedules/${schedule.id}/open`;

    const open = await app.inject({
      method: 'GET',
      url: `${url}?at=2026-07-01T15:00:00Z`,
      headers: auth,
    });
    expect(open.statusCode).toBe(200);
    expect(open.json<{ open: boolean }>().open).toBe(true);

    const closed = await app.inject({
      method: 'GET',
      url: `${url}?at=2026-07-03T15:00:00Z`,
      headers: auth,
    });
    expect(closed.json<{ open: boolean }>().open).toBe(false);
  });

  it('evaluates now when no instant is given', async () => {
    const tenantId = crypto.randomUUID();
    const schedule = await make(tenantId);
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${tenantId}/schedules/${schedule.id}/open`,
      headers: auth,
    });
    expect(response.statusCode).toBe(200);
    const body = response.json<{ open: boolean; evaluatedAt: string }>();
    expect(typeof body.open).toBe('boolean');
    expect(Math.abs(Date.now() - new Date(body.evaluatedAt).getTime())).toBeLessThan(5000);
  });

  it('needs the service token', async () => {
    const tenantId = crypto.randomUUID();
    const schedule = await make(tenantId);
    const url = `/internal/v1/tenants/${tenantId}/schedules/${schedule.id}/open`;
    expect((await app.inject({ method: 'GET', url })).statusCode).toBe(401);
    const wrong = await app.inject({
      method: 'GET',
      url,
      headers: { authorization: 'Bearer wrong' },
    });
    expect(wrong.statusCode).toBe(401);
  });

  it("does not answer for another tenant's schedule", async () => {
    const schedule = await make(crypto.randomUUID());
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/schedules/${schedule.id}/open`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });

  it('404s a schedule that does not exist', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/internal/v1/tenants/${crypto.randomUUID()}/schedules/nope/open`,
      headers: auth,
    });
    expect(response.statusCode).toBe(404);
  });
});

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, signInternalHeaders, type Server } from '@cuc/http';

import { registerScheduleRoutes } from '../src/routes/schedule.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TEST_INTERNAL_SECRET = 'test-internal-header-secret';

interface ScheduleBody {
  id: string;
  label: string;
  timezone: string;
  rules: { days: number[]; start: string; end: string }[];
  holidays: { date: string; label?: string }[];
}

const weekdays = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

describe.skipIf(skipReason !== undefined)('schedule HTTP routes', () => {
  let h: Harness;
  let app: Server;

  beforeAll(async () => {
    h = await startHarness();
    app = await createServer({
      serviceName: 'pbx-config-service',
      logger: h.logger,
      context: { trustInternalHeaders: true, internalHeaderSigningSecret: TEST_INTERNAL_SECRET },
    });
    registerScheduleRoutes(app, h.schedules);
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await h?.close();
  });

  afterEach(async () => {
    await resetSchema(h.db);
  });

  function actorHeaders(tenantId: string) {
    return signInternalHeaders(TEST_INTERNAL_SECRET, {
      actorId: 'user-1',
      actorType: 'user',
      orgId: tenantId,
      orgType: 'tenant',
      tenantId,
    });
  }

  it('every route declares permission and dataClass (CLAUDE.md rule 3), gated by schedule.read/.manage (G-10)', () => {
    const routes = app.registeredRoutes.filter((r) =>
      r.url.startsWith('/v1/tenants/:tenantId/schedules'),
    );
    expect(routes.length).toBeGreaterThanOrEqual(5);
    for (const route of routes) {
      expect(route.permission, `${route.method} ${route.url}`).toBe(
        route.method === 'GET' || route.method === 'HEAD' ? 'schedule.read' : 'schedule.manage',
      );
      expect(route.dataClass, `${route.method} ${route.url}`).toBe('config');
    }
  });

  it('creates, lists, gets, updates, and deletes a schedule', async () => {
    const tenantId = crypto.randomUUID();
    const headers = actorHeaders(tenantId);

    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers,
      payload: {
        label: 'Office hours',
        timezone: 'America/Chicago',
        rules: [weekdays],
        holidays: [{ date: '2026-12-25', label: 'Christmas' }],
      },
    });
    expect(created.statusCode).toBe(201);
    const body = created.json<ScheduleBody>();
    expect(body).toMatchObject({
      label: 'Office hours',
      timezone: 'America/Chicago',
      rules: [weekdays],
      holidays: [{ date: '2026-12-25', label: 'Christmas' }],
    });

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers,
    });
    expect(listed.json<{ rows: ScheduleBody[] }>().rows.map((r) => r.id)).toEqual([body.id]);

    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/schedules/${body.id}`,
      headers,
    });
    expect(got.json<ScheduleBody>().rules).toEqual([weekdays]);

    const updated = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/schedules/${body.id}`,
      headers,
      payload: { label: 'Reception', holidays: [] },
    });
    expect(updated.statusCode).toBe(200);
    // Fields left out are kept.
    expect(updated.json<ScheduleBody>()).toMatchObject({
      label: 'Reception',
      timezone: 'America/Chicago',
      rules: [weekdays],
      holidays: [],
    });

    const deleted = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/schedules/${body.id}`,
      headers,
    });
    expect(deleted.statusCode).toBe(204);
    const after = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${tenantId}/schedules/${body.id}`,
      headers,
    });
    expect(after.statusCode).toBe(404);
  });

  it('creates a schedule with no windows or holidays yet', async () => {
    const tenantId = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers: actorHeaders(tenantId),
      payload: { label: 'Empty', timezone: 'UTC' },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json<ScheduleBody>()).toMatchObject({ rules: [], holidays: [] });
  });

  it.each([
    ['an unknown time zone', { label: 'x', timezone: 'Mars/Olympus' }],
    [
      'a window that ends before it starts',
      { label: 'x', timezone: 'UTC', rules: [{ days: [1], start: '17:00', end: '09:00' }] },
    ],
    [
      'a day outside 0 to 6',
      { label: 'x', timezone: 'UTC', rules: [{ days: [9], start: '09:00', end: '17:00' }] },
    ],
    [
      'a holiday that is not a date',
      { label: 'x', timezone: 'UTC', holidays: [{ date: '2026-02-30' }] },
    ],
    ['a blank label', { label: '   ', timezone: 'UTC' }],
  ])('400s %s', async (_name, payload) => {
    const tenantId = crypto.randomUUID();
    const response = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers: actorHeaders(tenantId),
      payload,
    });
    expect(response.statusCode).toBe(400);
  });

  it('404s an update or delete of a schedule that is not there', async () => {
    const tenantId = crypto.randomUUID();
    const headers = actorHeaders(tenantId);
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/schedules/nope`,
      headers,
      payload: { label: 'x' },
    });
    expect(patch.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/schedules/nope`,
      headers,
    });
    expect(del.statusCode).toBe(404);
  });

  it("never shows one tenant another tenant's schedules", async () => {
    const a = crypto.randomUUID();
    const b = crypto.randomUUID();
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${a}/schedules`,
      headers: actorHeaders(a),
      payload: { label: 'A only', timezone: 'UTC' },
    });
    const id = created.json<ScheduleBody>().id;

    const listed = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${b}/schedules`,
      headers: actorHeaders(b),
    });
    expect(listed.json<{ rows: ScheduleBody[] }>().rows).toEqual([]);
    const got = await app.inject({
      method: 'GET',
      url: `/v1/tenants/${b}/schedules/${id}`,
      headers: actorHeaders(b),
    });
    expect(got.statusCode).toBe(404);
  });

  it('publishes an event for each change, in the same transaction', async () => {
    const tenantId = crypto.randomUUID();
    const headers = actorHeaders(tenantId);
    const created = await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers,
      payload: { label: 'Events', timezone: 'UTC' },
    });
    const id = created.json<ScheduleBody>().id;
    await app.inject({
      method: 'PATCH',
      url: `/v1/tenants/${tenantId}/schedules/${id}`,
      headers,
      payload: { label: 'Events 2' },
    });
    await app.inject({
      method: 'DELETE',
      url: `/v1/tenants/${tenantId}/schedules/${id}`,
      headers,
    });
    // A rejected change leaves no event behind.
    await app.inject({
      method: 'POST',
      url: `/v1/tenants/${tenantId}/schedules`,
      headers,
      payload: { label: 'Bad', timezone: 'Nowhere/Land' },
    });

    const rows = await h.db.kysely.selectFrom('outbox').select(['type']).execute();
    expect(rows.map((r) => r.type).sort()).toEqual([
      'pbx.schedule.created',
      'pbx.schedule.deleted',
      'pbx.schedule.updated',
    ]);
  });
});

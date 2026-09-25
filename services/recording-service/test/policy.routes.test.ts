import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import {
  TENANT_ADMIN_ROLE,
  grant,
  resetSchema,
  startHarness,
  startRoutes,
  type Harness,
  type RoutesHarness,
} from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

interface PolicyBody {
  id: string;
  scopeType: string;
  scopeId: string;
  direction: string;
  action: string;
  announce: boolean;
  consentAssetId: string | null;
}

describe.skipIf(skipReason !== undefined)(
  'recording policy and settings routes (S5-01, S5-05)',
  () => {
    let h: Harness;
    let r: RoutesHarness;
    const tenant = 'tenant-a';
    const base = `/v1/tenants/${tenant}/recording-policies`;

    beforeAll(async () => {
      h = await startHarness();
      r = await startRoutes(h);
    });
    afterAll(async () => {
      await r?.app.close();
      await h?.close();
    });
    afterEach(async () => {
      await resetSchema(h.db);
      r.audited.length = 0;
    });

    const admin = () => {
      r.access.set('admin', { roles: [TENANT_ADMIN_ROLE] });
      return r.headers('admin', tenant);
    };
    const send = (
      method: 'GET' | 'POST' | 'PUT' | 'DELETE',
      url: string,
      headers: Record<string, string>,
      payload?: unknown,
    ) =>
      r.app.inject({
        method,
        url,
        headers,
        ...(payload === undefined ? {} : { payload: payload as object }),
      });

    it('every route declares recording.policy.read (reads) or .manage (writes) and the config data class (CLAUDE.md rule 3, G-10)', () => {
      const routes = r.app.registeredRoutes.filter(
        (route) =>
          route.url.startsWith('/v1/tenants/:tenantId/recording-policies') ||
          route.url.startsWith('/v1/tenants/:tenantId/recording-settings'),
      );
      expect(routes.length).toBeGreaterThanOrEqual(6);
      for (const route of routes) {
        const permission =
          route.method === 'GET' || route.method === 'HEAD'
            ? 'recording.policy.read'
            : 'recording.policy.manage';
        expect(route).toMatchObject({ permission, dataClass: 'config' });
      }
    });

    it('creates, lists, edits and deletes a policy', async () => {
      const headers = admin();
      const created = await send('POST', base, headers, {
        scopeType: 'queue',
        scopeId: 'Q1',
        action: 'record',
        announce: true,
        consentAssetId: 'asset-1',
      });
      expect(created.statusCode).toBe(201);
      const policy = created.json<PolicyBody>();
      expect(policy).toMatchObject({ direction: 'any', announce: true, consentAssetId: 'asset-1' });

      const listed = await send('GET', base, headers);
      expect(listed.json<{ rows: PolicyBody[] }>().rows).toEqual([policy]);

      const edited = await send('PUT', `${base}/${policy.id}`, headers, {
        scopeType: 'queue',
        scopeId: 'Q1',
        direction: 'inbound',
        action: 'no_record',
      });
      expect(edited.statusCode).toBe(200);
      expect(edited.json<PolicyBody>()).toMatchObject({
        id: policy.id,
        direction: 'inbound',
        action: 'no_record',
        announce: false,
      });

      expect((await send('DELETE', `${base}/${policy.id}`, headers)).statusCode).toBe(204);
      expect((await send('GET', base, headers)).json<{ rows: unknown[] }>().rows).toEqual([]);
      expect((await send('DELETE', `${base}/${policy.id}`, headers)).statusCode).toBe(404);
    });

    it('answers 400 for an invalid policy and 409 for a duplicate scope', async () => {
      const headers = admin();
      for (const body of [
        { scopeType: 'galaxy', action: 'record' },
        { scopeType: 'queue', action: 'record' }, // no scope id
        { scopeType: 'tenant', action: 'no_record', announce: true },
        { scopeType: 'tenant', action: 'record', consentAssetId: 'a' },
        { scopeType: 'tenant', action: 'record', direction: 'sideways' },
        { scopeType: 'tenant' },
      ]) {
        const response = await send('POST', base, headers, body);
        expect(response.statusCode, JSON.stringify(body)).toBe(400);
      }

      const tenantWide = { scopeType: 'tenant', action: 'record' };
      expect((await send('POST', base, headers, tenantWide)).statusCode).toBe(201);
      const duplicate = await send('POST', base, headers, tenantWide);
      expect(duplicate.statusCode).toBe(409);
      expect(duplicate.json<{ code: string }>().code).toBe('policy_exists');
    });

    it('audits policy writes in the same transaction', async () => {
      const created = await send('POST', base, admin(), { scopeType: 'tenant', action: 'record' });
      const id = created.json<PolicyBody>().id;
      const audit = (
        await h.db.kysely.selectFrom('outbox').select(['type', 'payload']).execute()
      ).find((row) => row.type === 'audit.event.recorded');
      expect(audit?.payload).toMatchObject({
        action: 'recording.policy.created',
        resource: `recording-policy:${id}`,
        actorId: 'admin',
        dataClass: 'config',
      });
    });

    it('refuses everything without recording.policy.manage: supervisors, listeners, users', async () => {
      r.access.set('sup', {
        grants: [grant('sup', 'recording.listen', { type: 'org', id: tenant })],
      });
      const headers = r.headers('sup', tenant);
      expect((await send('GET', base, headers)).statusCode).toBe(403);
      expect(
        (await send('POST', base, headers, { scopeType: 'tenant', action: 'record' })).statusCode,
      ).toBe(403);
      expect(
        (await send('GET', `/v1/tenants/${tenant}/recording-settings`, headers)).statusCode,
      ).toBe(403);
      expect(await h.policies.list({ tenantId: tenant })).toEqual([]);
    });

    it('recording.policy.read reads the policies and the settings but changes nothing (G-10)', async () => {
      r.access.set('support', {
        roles: [{ id: 'viewer', permissions: ['recording.policy.read'] }],
      });
      const headers = r.headers('support', tenant);
      expect((await send('GET', base, headers)).statusCode).toBe(200);
      expect(
        (await send('GET', `/v1/tenants/${tenant}/recording-settings`, headers)).statusCode,
      ).toBe(200);
      expect(
        (await send('POST', base, headers, { scopeType: 'tenant', action: 'record' })).statusCode,
      ).toBe(403);
      expect(
        (
          await send('PUT', `/v1/tenants/${tenant}/recording-settings`, headers, {
            retentionDays: 30,
          })
        ).statusCode,
      ).toBe(403);
      expect(await h.policies.list({ tenantId: tenant })).toEqual([]);
    });

    it('a scoped manage grant does not give tenant-wide policy control', async () => {
      r.access.set('sup', {
        grants: [grant('sup', 'recording.policy.manage', { type: 'queue', id: 'Q1' })],
      });
      const response = await send('GET', base, r.headers('sup', tenant));
      expect(response.statusCode).toBe(403);
    });

    it('refuses a reseller (no such permission for them) and a tenant administrator of another tenant', async () => {
      r.access.set('rsl', { roles: [{ id: 'reseller_admin', permissions: ['tenant.manage'] }] });
      expect((await send('GET', base, r.headers('rsl', 'reseller-1', 'reseller'))).statusCode).toBe(
        403,
      );
      r.access.set('other', { roles: [TENANT_ADMIN_ROLE] });
      expect((await send('GET', base, r.headers('other', 'tenant-b'))).statusCode).toBe(403);
    });

    it("never lets one tenant see or change another's policies", async () => {
      await h.policies.create(
        { tenantId: 'tenant-b' },
        {
          scopeType: 'tenant',
          scopeId: 'tenant-b',
          direction: 'any',
          action: 'record',
          announce: false,
          consentAssetId: null,
        },
      );
      const other = (await h.policies.list({ tenantId: 'tenant-b' }))[0]!;
      const headers = admin();
      expect((await send('GET', base, headers)).json<{ rows: unknown[] }>().rows).toEqual([]);
      const attempt = await send('DELETE', `${base}/${other.id}`, headers);
      expect(attempt.statusCode).toBe(404);
      expect(await h.policies.findById({ tenantId: 'tenant-b' }, other.id)).toBeDefined();
    });

    describe('retention settings', () => {
      const url = `/v1/tenants/${tenant}/recording-settings`;

      it('reports the default, stores a choice, sets the bucket rule, and audits it', async () => {
        const headers = admin();
        expect((await send('GET', url, headers)).json()).toEqual({
          retentionDays: 90,
          failClosed: false,
        });

        const response = await send('PUT', url, headers, { retentionDays: 14 });
        expect(response.statusCode).toBe(200);
        expect(response.json()).toEqual({ retentionDays: 14, failClosed: false });
        expect((await send('GET', url, headers)).json()).toEqual({
          retentionDays: 14,
          failClosed: false,
        });

        const events = await h.db.kysely.selectFrom('outbox').select(['type', 'payload']).execute();
        expect(events.map((e) => e.type)).toEqual(
          expect.arrayContaining(['recording.retention.updated', 'audit.event.recorded']),
        );
      });

      it('rejects a period out of range or not a whole number', async () => {
        const headers = admin();
        for (const retentionDays of [-1, 3651, 1.5, 'ninety']) {
          expect(
            (await send('PUT', url, headers, { retentionDays })).statusCode,
            String(retentionDays),
          ).toBe(400);
        }
      });

      it('turning retention off (0) is accepted', async () => {
        const headers = admin();
        await send('PUT', url, headers, { retentionDays: 5 });
        expect((await send('PUT', url, headers, { retentionDays: 0 })).json()).toEqual({
          retentionDays: 0,
          failClosed: false,
        });
      });
    });

    describe('recording required (S5-12, fail closed)', () => {
      const url = `/v1/tenants/${tenant}/recording-settings`;

      it('is off by default, can be turned on alone, keeps retention, and is audited', async () => {
        const headers = admin();
        await send('PUT', url, headers, { retentionDays: 30 });
        await h.db.kysely.deleteFrom('outbox').execute();
        r.audited.length = 0;

        const response = await send('PUT', url, headers, { failClosed: true });
        expect(response.statusCode, response.body).toBe(200);
        expect(response.json()).toEqual({ retentionDays: 30, failClosed: true });
        expect((await send('GET', url, headers)).json()).toEqual({
          retentionDays: 30,
          failClosed: true,
        });

        const events = await h.db.kysely
          .selectFrom('outbox')
          .select(['type', 'payload', 'tenant_id'])
          .execute();
        const types = events.map((e) => e.type);
        // Only the settings event: retention did not change, so no retention event.
        expect(types).toContain('recording.settings.updated');
        expect(types).not.toContain('recording.retention.updated');
        const settingsEvent = events.find((e) => e.type === 'recording.settings.updated')!;
        const data: unknown =
          typeof settingsEvent.payload === 'string'
            ? JSON.parse(settingsEvent.payload)
            : settingsEvent.payload;
        expect(data).toEqual({ retentionDays: 30, failClosed: true });
        expect(settingsEvent.tenant_id).toBe(tenant);

        const audit = events.find((e) => e.type === 'audit.event.recorded')!;
        expect(JSON.stringify(audit.payload)).toContain('recording.settings.updated');
      });

      it('a tenant with no settings row can turn it on (the default retention is kept)', async () => {
        const response = await send('PUT', url, admin(), { failClosed: true });
        expect(response.json()).toEqual({ retentionDays: 90, failClosed: true });
      });

      it('an empty change, or a flag that is not a boolean, is refused', async () => {
        const headers = admin();
        expect((await send('PUT', url, headers, {})).statusCode).toBe(400);
        expect((await send('PUT', url, headers, { failClosed: 'yes' })).statusCode).toBe(400);
      });

      it('needs recording.policy.manage, and a reseller is refused', async () => {
        r.access.set('reader', { roles: [{ id: 'r', permissions: ['recording.policy.read'] }] });
        const reader = r.headers('reader', tenant);
        expect((await send('PUT', url, reader, { failClosed: true })).statusCode).toBe(403);
        expect((await send('GET', url, reader)).statusCode).toBe(200);

        r.access.set('reseller', { roles: [TENANT_ADMIN_ROLE] });
        const reseller = r.headers('reseller', 'reseller-1', 'reseller');
        expect((await send('PUT', url, reseller, { failClosed: true })).statusCode).toBe(403);
      });

      it('lists the tenants that require recording for telephony-config', async () => {
        await h.settings.update({ tenantId: 'tenant-x' }, { failClosed: true });
        await h.settings.update({ tenantId: 'tenant-y' }, { failClosed: false });
        await h.settings.update({ tenantId: 'tenant-z' }, { retentionDays: 5 });
        expect(await h.settings.listFailClosedTenantIds({})).toEqual(['tenant-x']);
      });
    });
  },
);

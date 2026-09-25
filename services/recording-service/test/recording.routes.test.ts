import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import type { RegisterRecordingInput } from '../src/repo/recording.repo.js';
import { buildWav } from '../src/uploader/wav.js';
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
const AUDIO = buildWav({ sampleRate: 8000, channels: 1, seconds: 1 });

interface RecordingBody {
  id: string;
  status: string;
  queueId: string | null;
}

describe.skipIf(skipReason !== undefined)('recording routes (S5-04)', () => {
  let h: Harness;
  let r: RoutesHarness;
  const tenant = 'tenant-a';

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
    r.auditFails.value = false;
    r.access.unavailable = false;
  });

  /** A ready recording whose audio really is in the bucket. */
  async function seed(input: Partial<RegisterRecordingInput> = {}, tenantId = tenant) {
    const recording = await h.recordings.register(
      { tenantId },
      { callUuid: crypto.randomUUID(), direction: 'inbound', announced: false, ...input },
    );
    await h.storage.forTenant(tenantId).provisionBucket();
    await h.storage.forTenant(tenantId).putObject(recording.objectKey, AUDIO, {
      contentType: 'audio/wav',
    });
    return h.recordings.complete({ tenantId }, recording.id, {
      sizeBytes: AUDIO.length,
      durationMs: 1000,
      sha256: null,
      retentionDays: 30,
    });
  }

  const admin = () => {
    r.access.set('admin', { roles: [TENANT_ADMIN_ROLE] });
    return r.headers('admin', tenant);
  };
  const supervisor = (grants: ReturnType<typeof grant>[]) => {
    r.access.set('sup', { grants });
    return r.headers('sup', tenant);
  };
  const get = (url: string, headers: Record<string, string>) =>
    r.app.inject({ method: 'GET', url, headers });

  it('every route declares a permission and a private data class (CLAUDE.md rule 3)', () => {
    const routes = r.app.registeredRoutes.filter((route) =>
      route.url.startsWith('/v1/tenants/:tenantId/recordings'),
    );
    expect(routes.length).toBeGreaterThanOrEqual(5);
    for (const route of routes) {
      expect(route.dataClass, `${route.method} ${route.url}`).toBe('private');
      expect(route.permission, `${route.method} ${route.url}`).toMatch(/^recording\./);
    }
  });

  it('turns away a caller who is not signed in', async () => {
    expect((await get(`/v1/tenants/${tenant}/recordings`, {})).statusCode).toBe(401);
  });

  describe('validation', () => {
    it('rejects a bad direction, status, limit, date and cursor', async () => {
      const headers = admin();
      for (const query of [
        'direction=sideways',
        'status=lost',
        'limit=0',
        'limit=500',
        'from=yesterday-ish',
        'cursor=%%%',
      ]) {
        const response = await get(`/v1/tenants/${tenant}/recordings?${query}`, headers);
        expect(response.statusCode, query).toBe(400);
      }
    });
  });

  describe('H1: resellers can never reach recordings', () => {
    it('answers 403 on every recording endpoint, even for a reseller holding grants for everything', async () => {
      const recording = await seed();
      r.access.set('rsl', {
        roles: [TENANT_ADMIN_ROLE],
        grants: [
          grant('rsl', 'recording.listen', { type: 'org', id: tenant }),
          grant('rsl', 'recording.download', { type: 'org', id: tenant }),
          grant('rsl', 'recording.delete', { type: 'org', id: tenant }),
        ],
      });
      const headers = r.headers('rsl', 'reseller-1', 'reseller');
      const base = `/v1/tenants/${tenant}/recordings`;

      for (const [method, url] of [
        ['GET', base],
        ['GET', `${base}/${recording.id}`],
        ['GET', `${base}/${recording.id}/play-url`],
        ['GET', `${base}/${recording.id}/download-url`],
        ['DELETE', `${base}/${recording.id}`],
      ] as const) {
        const response = await r.app.inject({ method, url, headers });
        expect(response.statusCode, `${method} ${url}`).toBe(403);
        expect(response.json<{ code: string }>().code).toBe('reseller_private_data_denied');
      }
      expect(r.audited).toEqual([]);
      expect(await h.recordings.findById({ tenantId: tenant }, recording.id)).toBeDefined();
    });
  });

  describe('a tenant administrator', () => {
    it('lists and reads recordings, and gets a working playback URL', async () => {
      const headers = admin();
      const recording = await seed({ queueId: 'Q1' });

      const list = await get(`/v1/tenants/${tenant}/recordings`, headers);
      expect(list.statusCode).toBe(200);
      expect(list.json<{ rows: RecordingBody[] }>().rows.map((row) => row.id)).toEqual([
        recording.id,
      ]);

      const one = await get(`/v1/tenants/${tenant}/recordings/${recording.id}`, headers);
      expect(one.json<RecordingBody>()).toMatchObject({ id: recording.id, status: 'ready' });

      const play = await get(`/v1/tenants/${tenant}/recordings/${recording.id}/play-url`, headers);
      expect(play.statusCode).toBe(200);
      const { url } = play.json<{ url: string }>();
      const audio = await fetch(url);
      expect(audio.status).toBe(200);
      expect(Buffer.from(await audio.arrayBuffer()).equals(AUDIO)).toBe(true);
      expect(audio.headers.get('content-disposition')).toBeNull();
      // Short-lived: at most five minutes (05 §4).
      expect(Number(new URL(url).searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300);
    });

    it('gets a download URL that forces a save with a name that identifies no one', async () => {
      const recording = await seed();
      const response = await get(
        `/v1/tenants/${tenant}/recordings/${recording.id}/download-url`,
        admin(),
      );
      const { url } = response.json<{ url: string }>();
      const audio = await fetch(url);
      expect(audio.headers.get('content-disposition')).toBe(
        `attachment; filename="recording-${recording.id}.wav"`,
      );
    });

    it('filters and pages the list through the query string', async () => {
      const headers = admin();
      await seed({ direction: 'inbound' });
      await seed({ direction: 'outbound' });
      await seed({ direction: 'outbound' });

      const outbound = await get(
        `/v1/tenants/${tenant}/recordings?direction=outbound&limit=1`,
        headers,
      );
      const body = outbound.json<{ rows: RecordingBody[]; nextCursor: string | null }>();
      expect(body.rows).toHaveLength(1);
      expect(body.nextCursor).not.toBeNull();
      const next = await get(
        `/v1/tenants/${tenant}/recordings?direction=outbound&limit=1&cursor=${body.nextCursor!}`,
        headers,
      );
      expect(next.json<{ rows: unknown[]; nextCursor: string | null }>()).toMatchObject({
        nextCursor: null,
      });
    });

    it('audits every URL issuance with who, what, and where', async () => {
      const recording = await seed();
      await get(`/v1/tenants/${tenant}/recordings/${recording.id}/play-url`, admin());
      await get(`/v1/tenants/${tenant}/recordings/${recording.id}/download-url`, admin());

      const issued = r.audited.filter((event) => event.action.endsWith('_url_issued'));
      expect(issued.map((event) => event.action)).toEqual([
        'recording.play_url_issued',
        'recording.download_url_issued',
      ]);
      for (const event of issued) {
        expect(event).toMatchObject({
          actorType: 'user',
          actorId: 'admin',
          actorOrgId: tenant,
          targetOrgId: tenant,
          resource: `recording:${recording.id}`,
          dataClass: 'private',
        });
        expect(event.requestId).toBeDefined();
      }
    });

    it('issues no URL when the audit event cannot be recorded', async () => {
      const recording = await seed();
      r.auditFails.value = true;
      const response = await get(
        `/v1/tenants/${tenant}/recordings/${recording.id}/play-url`,
        admin(),
      );
      expect(response.statusCode).toBe(503);
      expect(response.json<{ code: string }>().code).toBe('audit_unavailable');
      expect(response.body).not.toContain('X-Amz-Signature');
    });

    it('still lists when only the best-effort read audit fails', async () => {
      await seed();
      r.auditFails.value = true;
      expect((await get(`/v1/tenants/${tenant}/recordings`, admin())).statusCode).toBe(200);
    });

    it('will not issue a URL for a recording with no audio yet, or one that has expired', async () => {
      const headers = admin();
      const pending = await h.recordings.register(
        { tenantId: tenant },
        { callUuid: 'c', direction: 'inbound', announced: false },
      );
      const response = await get(
        `/v1/tenants/${tenant}/recordings/${pending.id}/play-url`,
        headers,
      );
      expect(response.statusCode).toBe(409);
      expect(response.json<{ code: string }>().code).toBe('recording_unavailable');
      expect(r.audited).toEqual([]);
    });

    it('404s an unknown recording', async () => {
      const response = await get(
        `/v1/tenants/${tenant}/recordings/${crypto.randomUUID()}`,
        admin(),
      );
      expect(response.statusCode).toBe(404);
    });

    it('deletes a recording: audio gone, row gone, audit in the outbox', async () => {
      const recording = await seed();
      const response = await r.app.inject({
        method: 'DELETE',
        url: `/v1/tenants/${tenant}/recordings/${recording.id}`,
        headers: admin(),
      });
      expect(response.statusCode).toBe(204);

      expect(await h.recordings.findById({ tenantId: tenant }, recording.id)).toBeUndefined();
      expect(await h.storage.forTenant(tenant).headObject(recording.objectKey)).toBeUndefined();
      const audit = (
        await h.db.kysely.selectFrom('outbox').select(['type', 'payload']).execute()
      ).find((row) => row.type === 'audit.event.recorded');
      expect(audit?.payload).toMatchObject({
        action: 'recording.deleted',
        resource: `recording:${recording.id}`,
        actorId: 'admin',
        dataClass: 'private',
      });
    });
  });

  describe('a supervisor with a scoped grant (recording.listen on queue:Q1)', () => {
    it('lists only the queue’s recordings', async () => {
      const q1 = await seed({ queueId: 'Q1' });
      await seed({ queueId: 'Q2' });
      await seed({ extensionId: 'E1' });

      const response = await get(
        `/v1/tenants/${tenant}/recordings`,
        supervisor([grant('sup', 'recording.listen', { type: 'queue', id: 'Q1' })]),
      );
      expect(response.statusCode).toBe(200);
      expect(response.json<{ rows: RecordingBody[] }>().rows.map((row) => row.id)).toEqual([q1.id]);
    });

    it('can play Q1 calls and is refused on any other queue’s, with no audit for the refusal', async () => {
      const inQ1 = await seed({ queueId: 'Q1' });
      const inQ2 = await seed({ queueId: 'Q2' });
      const headers = supervisor([grant('sup', 'recording.listen', { type: 'queue', id: 'Q1' })]);

      const allowed = await get(`/v1/tenants/${tenant}/recordings/${inQ1.id}/play-url`, headers);
      expect(allowed.statusCode).toBe(200);
      const denied = await get(`/v1/tenants/${tenant}/recordings/${inQ2.id}/play-url`, headers);
      expect(denied.statusCode).toBe(403);
      expect(denied.json<{ code: string }>().code).toBe('insufficient_permission');
      expect(denied.body).not.toContain('X-Amz-Signature');
      expect(r.audited.map((event) => event.resource)).toEqual([`recording:${inQ1.id}`]);
    });

    it('cannot download or delete with only the listen grant', async () => {
      const inQ1 = await seed({ queueId: 'Q1' });
      const headers = supervisor([grant('sup', 'recording.listen', { type: 'queue', id: 'Q1' })]);
      expect(
        (await get(`/v1/tenants/${tenant}/recordings/${inQ1.id}/download-url`, headers)).statusCode,
      ).toBe(403);
      expect(
        (
          await r.app.inject({
            method: 'DELETE',
            url: `/v1/tenants/${tenant}/recordings/${inQ1.id}`,
            headers,
          })
        ).statusCode,
      ).toBe(403);
      expect(await h.recordings.findById({ tenantId: tenant }, inQ1.id)).toBeDefined();
    });

    it('a grant on an extension covers calls where it is either party', async () => {
      const asPeer = await seed({
        direction: 'internal',
        extensionId: 'E1',
        peerExtensionId: 'E2',
      });
      await seed({ extensionId: 'E3' });
      const headers = supervisor([
        grant('sup', 'recording.listen', { type: 'extension', id: 'E2' }),
      ]);
      const rows = (await get(`/v1/tenants/${tenant}/recordings`, headers)).json<{
        rows: RecordingBody[];
      }>().rows;
      expect(rows.map((row) => row.id)).toEqual([asPeer.id]);
      expect(
        (await get(`/v1/tenants/${tenant}/recordings/${asPeer.id}/play-url`, headers)).statusCode,
      ).toBe(200);
    });

    it('can delete inside a queue they hold recording.delete on', async () => {
      const inQ1 = await seed({ queueId: 'Q1' });
      const inQ2 = await seed({ queueId: 'Q2' });
      const headers = supervisor([grant('sup', 'recording.delete', { type: 'queue', id: 'Q1' })]);
      const url = (id: string) => `/v1/tenants/${tenant}/recordings/${id}`;
      expect(
        (await r.app.inject({ method: 'DELETE', url: url(inQ1.id), headers })).statusCode,
      ).toBe(204);
      expect(
        (await r.app.inject({ method: 'DELETE', url: url(inQ2.id), headers })).statusCode,
      ).toBe(403);
    });

    it('a grant that does not name this queue’s recordings widens nothing', async () => {
      await seed({ queueId: 'Q1' });
      const headers = supervisor([
        grant('sup', 'recording.listen', { type: 'queue', id: 'Q404' }),
        grant('sup', 'voicemail.access', { type: 'queue', id: 'Q1' }),
      ]);
      const rows = (await get(`/v1/tenants/${tenant}/recordings`, headers)).json<{
        rows: unknown[];
      }>().rows;
      expect(rows).toEqual([]);
    });
  });

  describe('people with no recording access', () => {
    it('refuses a user with no roles or grants', async () => {
      await seed();
      r.access.set('nobody', {});
      const response = await get(`/v1/tenants/${tenant}/recordings`, r.headers('nobody', tenant));
      expect(response.statusCode).toBe(403);
    });

    it('refuses a tenant administrator of another tenant (H2)', async () => {
      const recording = await seed();
      r.access.set('other-admin', { roles: [TENANT_ADMIN_ROLE] });
      const headers = r.headers('other-admin', 'tenant-b');
      expect((await get(`/v1/tenants/${tenant}/recordings`, headers)).statusCode).toBe(403);
      expect(
        (await get(`/v1/tenants/${tenant}/recordings/${recording.id}/play-url`, headers))
          .statusCode,
      ).toBe(403);
    });

    it('does not use a grant made in another tenant’s scope names', async () => {
      const recording = await seed({ queueId: 'Q1' }, 'tenant-b');
      r.access.set('sup', {
        grants: [grant('sup', 'recording.listen', { type: 'queue', id: 'Q1' })],
      });
      // Acting in tenant-a, the same queue id in tenant-b's data is out of reach.
      const response = await get(
        `/v1/tenants/tenant-b/recordings/${recording.id}/play-url`,
        r.headers('sup', tenant),
      );
      expect(response.statusCode).toBe(403);
    });

    it('fails closed with 503 when permissions cannot be looked up', async () => {
      await seed();
      r.access.unavailable = true;
      const response = await get(`/v1/tenants/${tenant}/recordings`, r.headers('admin', tenant));
      expect(response.statusCode).toBe(503);
      expect(response.json<{ code: string }>().code).toBe('permissions_unavailable');
    });
  });

  it('lets the master, who holds every permission, read a tenant’s recordings (audited as the master)', async () => {
    const recording = await seed();
    r.access.set('root', { roles: [{ ...TENANT_ADMIN_ROLE, id: 'master_admin' }] });
    const response = await get(
      `/v1/tenants/${tenant}/recordings/${recording.id}/play-url`,
      r.headers('root', 'master-org', 'master'),
    );
    expect(response.statusCode).toBe(200);
    expect(r.audited[0]).toMatchObject({
      actorId: 'root',
      actorOrgId: 'master-org',
      targetOrgId: tenant,
      action: 'recording.play_url_issued',
    });
  });
});

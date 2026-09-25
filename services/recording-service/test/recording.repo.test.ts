import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { crossTenantProbe, databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import {
  InvalidCursorError,
  RecordingNotFoundError,
  type RegisterRecordingInput,
} from '../src/repo/recording.repo.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());

const sample = (overrides: Partial<RegisterRecordingInput> = {}): RegisterRecordingInput => ({
  callUuid: crypto.randomUUID(),
  direction: 'inbound',
  extensionId: 'E1',
  announced: false,
  ...overrides,
});

describe.skipIf(skipReason !== undefined)('recording repo', () => {
  let h: Harness;

  beforeAll(async () => {
    h = await startHarness();
  });
  afterAll(async () => {
    await h?.close();
  });
  afterEach(async () => {
    await resetSchema(h.db);
  });

  const ready = async (tenantId: string, input: Partial<RegisterRecordingInput> = {}) => {
    const recording = await h.recordings.register({ tenantId }, sample(input));
    return h.recordings.complete({ tenantId }, recording.id, {
      sizeBytes: 1000,
      durationMs: 5000,
      sha256: 'a'.repeat(64),
      retentionDays: 30,
    });
  };

  it('registers a pending recording with an opaque id and a date-laid-out key', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await h.recordings.register({ tenantId }, sample());
    expect(recording).toMatchObject({
      status: 'pending',
      contentType: 'audio/wav',
      sizeBytes: null,
    });
    expect(recording.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(recording.objectKey).toMatch(
      new RegExp(`^recordings/\\d{4}/\\d{2}/\\d{2}/${recording.id}\\.wav$`),
    );
    // Neither the object key nor the id carries the tenant or the call.
    expect(recording.objectKey).not.toContain(tenantId);
    expect(recording.objectKey).not.toContain(recording.callUuid);
    expect(await h.recordings.findById({ tenantId }, recording.id)).toEqual(recording);
  });

  it('completes a recording: ready, sized, retention date set, event enqueued', async () => {
    const tenantId = crypto.randomUUID();
    const done = await ready(tenantId);
    expect(done).toMatchObject({ status: 'ready', sizeBytes: 1000, durationMs: 5000 });
    expect(done.retentionDate?.getTime()).toBe(done.startedAt.getTime() + 30 * 86_400_000);

    const events = await h.db.kysely.selectFrom('outbox').select('type').execute();
    expect(events.map((e) => e.type)).toContain('recording.recording.ready');

    // A retried complete changes nothing and does not emit a second event.
    await h.recordings.complete({ tenantId }, done.id, {
      sizeBytes: 1,
      durationMs: 1,
      sha256: null,
      retentionDays: 1,
    });
    expect(
      (await h.db.kysely.selectFrom('outbox').select('type').execute()).filter(
        (e) => e.type === 'recording.recording.ready',
      ),
    ).toHaveLength(1);
    expect((await h.recordings.findById({ tenantId }, done.id))?.sizeBytes).toBe(1000);
  });

  it('keeps no retention date when retention is off', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await h.recordings.register({ tenantId }, sample());
    const done = await h.recordings.complete({ tenantId }, recording.id, {
      sizeBytes: 5,
      durationMs: null,
      sha256: null,
      retentionDays: 0,
    });
    expect(done.retentionDate).toBeNull();
  });

  it('fails a pending recording, then lets it complete on a later successful upload', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await h.recordings.register({ tenantId }, sample());
    await h.recordings.fail({ tenantId }, recording.id, 'empty_file');
    expect(await h.recordings.findById({ tenantId }, recording.id)).toMatchObject({
      status: 'failed',
      failureReason: 'empty_file',
    });
    await expect(h.recordings.fail({ tenantId }, 'missing', 'x')).rejects.toBeInstanceOf(
      RecordingNotFoundError,
    );
  });

  it('filters by direction, extension (either party), queue, DID, status and time', async () => {
    const tenantId = crypto.randomUUID();
    await ready(tenantId, { direction: 'inbound', extensionId: 'E1', queueId: 'Q1', didId: 'D1' });
    await ready(tenantId, { direction: 'internal', extensionId: 'E2', peerExtensionId: 'E3' });
    await ready(tenantId, { direction: 'outbound', extensionId: 'E1' });
    await h.recordings.register({ tenantId }, sample({ extensionId: 'E9' })); // pending

    const list = (filter: Parameters<typeof h.recordings.list>[1]) =>
      h.recordings.list({ tenantId }, filter).then((page) => page.rows);

    expect(await list({})).toHaveLength(4);
    expect(await list({ direction: 'internal' })).toHaveLength(1);
    expect(await list({ extensionId: 'E1' })).toHaveLength(2);
    expect(await list({ extensionId: 'E3' })).toHaveLength(1); // the peer
    expect(await list({ queueId: 'Q1' })).toHaveLength(1);
    expect(await list({ didId: 'D1' })).toHaveLength(1);
    expect(await list({ status: 'pending' })).toHaveLength(1);
    expect(await list({ from: new Date(Date.now() + 60_000) })).toHaveLength(0);
    expect(await list({ to: new Date(Date.now() + 60_000) })).toHaveLength(4);
  });

  it('restricts a scoped viewer to recordings inside their scopes, and to none without any', async () => {
    const tenantId = crypto.randomUUID();
    await ready(tenantId, { queueId: 'Q1', extensionId: 'E1' });
    await ready(tenantId, { queueId: 'Q2', extensionId: 'E2' });
    await ready(tenantId, { didId: 'D1', extensionId: null });
    await ready(tenantId, { direction: 'internal', extensionId: 'E5', peerExtensionId: 'E6' });

    const seen = async (scopes: { type: 'extension' | 'queue' | 'did'; id: string }[]) =>
      (await h.recordings.list({ tenantId }, { visibleScopes: scopes })).rows.length;

    expect(await seen([{ type: 'queue', id: 'Q1' }])).toBe(1);
    expect(
      await seen([
        { type: 'queue', id: 'Q1' },
        { type: 'did', id: 'D1' },
      ]),
    ).toBe(2);
    expect(await seen([{ type: 'extension', id: 'E6' }])).toBe(1); // as the peer
    expect(await seen([{ type: 'queue', id: 'Q404' }])).toBe(0);
    expect(await seen([])).toBe(0);
  });

  it('pages newest first with a keyset cursor and rejects a malformed one', async () => {
    const tenantId = crypto.randomUUID();
    for (let i = 0; i < 5; i += 1) await ready(tenantId);

    const first = await h.recordings.list({ tenantId }, { limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = await h.recordings.list({ tenantId }, { limit: 2, cursor: first.nextCursor! });
    const third = await h.recordings.list({ tenantId }, { limit: 2, cursor: second.nextCursor! });
    expect(third.rows).toHaveLength(1);
    expect(third.nextCursor).toBeNull();

    const ids = [...first.rows, ...second.rows, ...third.rows].map((r) => r.id);
    expect(new Set(ids).size).toBe(5);
    await expect(h.recordings.list({ tenantId }, { cursor: 'garbage' })).rejects.toBeInstanceOf(
      InvalidCursorError,
    );
  });

  it('removes a recording with its event and audit record together', async () => {
    const tenantId = crypto.randomUUID();
    const done = await ready(tenantId);
    await h.db.kysely.deleteFrom('outbox').execute();

    await h.recordings.remove({ tenantId }, done.id, {
      actorType: 'user',
      actorId: 'u1',
      actorOrgId: tenantId,
      targetOrgId: tenantId,
      action: 'recording.deleted',
      resource: 'placeholder',
      dataClass: 'private',
    });
    expect(await h.recordings.findById({ tenantId }, done.id)).toBeUndefined();

    const rows = await h.db.kysely.selectFrom('outbox').select(['type', 'payload']).execute();
    expect(rows.map((r) => r.type).sort()).toEqual([
      'audit.event.recorded',
      'recording.recording.deleted',
    ]);
    const audit = rows.find((r) => r.type === 'audit.event.recorded');
    expect(audit?.payload).toMatchObject({
      action: 'recording.deleted',
      resource: `recording:${done.id}`,
    });

    await expect(h.recordings.remove({ tenantId }, done.id)).rejects.toBeInstanceOf(
      RecordingNotFoundError,
    );
  });

  it('resolves a spool file by its opaque id across tenants, for the uploader only', async () => {
    const tenantId = crypto.randomUUID();
    const recording = await h.recordings.register({ tenantId }, sample());
    expect((await h.recordings.findByIdForUpload({}, recording.id))?.tenantId).toBe(tenantId);
    expect(await h.recordings.findByIdForUpload({}, crypto.randomUUID())).toBeUndefined();
  });

  describe('retention settings', () => {
    it('defaults to the deployment default, stores a tenant choice, and recomputes ready recordings', async () => {
      const tenantId = crypto.randomUUID();
      const done = await ready(tenantId); // 30 days at completion
      expect(await h.settings.retentionDays({ tenantId })).toBe(90);

      await h.settings.setRetentionDays({ tenantId }, 7);
      expect(await h.settings.retentionDays({ tenantId })).toBe(7);
      const after = await h.recordings.findById({ tenantId }, done.id);
      expect(after?.retentionDate?.getTime()).toBe(done.startedAt.getTime() + 7 * 86_400_000);

      await h.settings.setRetentionDays({ tenantId }, 0);
      expect((await h.recordings.findById({ tenantId }, done.id))?.retentionDate).toBeNull();
      expect(await h.db.kysely.selectFrom('outbox').select('type').execute()).toContainEqual({
        type: 'recording.retention.updated',
      });
    });

    it("never changes another tenant's retention", async () => {
      const a = crypto.randomUUID();
      const b = crypto.randomUUID();
      await h.settings.setRetentionDays({ tenantId: a }, 5);
      expect(await h.settings.retentionDays({ tenantId: b })).toBe(90);
      const doneB = await ready(b);
      await h.settings.setRetentionDays({ tenantId: a }, 1);
      expect(
        (await h.recordings.findById({ tenantId: b }, doneB.id))?.retentionDate,
      ).not.toBeNull();
    });
  });

  // 05 §2.4: every repository test suite includes a cross-tenant probe.
  crossTenantProbe({
    name: 'recordings',
    seed: (tenantId) => h.recordings.register({ tenantId }, sample()).then((row) => row.id),
    list: (tenantId) => h.recordings.list({ tenantId }, {}).then((page) => page.rows),
    findById: (tenantId, id) => h.recordings.findById({ tenantId }, id),
    remove: (tenantId, id) =>
      h.recordings
        .remove({ tenantId }, id)
        .then(() => 1)
        .catch((error: unknown) => {
          if (error instanceof RecordingNotFoundError) return 0;
          throw error;
        }),
  });
});

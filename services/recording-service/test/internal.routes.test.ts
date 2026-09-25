import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { buildWav } from '../src/uploader/wav.js';
import {
  INTERNAL_TOKEN,
  resetSchema,
  startHarness,
  startRoutes,
  type Harness,
  type RoutesHarness,
} from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const AUDIO = buildWav({ sampleRate: 8000, channels: 2, seconds: 2 });
const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');

describe.skipIf(skipReason !== undefined)(
  'recording-service internal routes (S5-01, S5-03)',
  () => {
    let h: Harness;
    let r: RoutesHarness;
    const tenantId = 'tenant-a';

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
    });

    const post = (path: string, payload?: unknown, token: string | null = INTERNAL_TOKEN) =>
      r.app.inject({
        method: 'POST',
        url: `/internal/v1/recordings/${path}`,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });

    const register = async () => {
      const response = await post('register', {
        tenantId,
        callUuid: 'call-1',
        direction: 'inbound',
        extensionId: 'E1',
        announced: false,
      });
      return response.json<{ recordingId: string; fileName: string }>();
    };

    it('requires the internal token on every route', async () => {
      const id = crypto.randomUUID();
      for (const [path, body] of [
        ['evaluate', { tenantId, direction: 'inbound' }],
        ['register', { tenantId, callUuid: 'c', direction: 'inbound', announced: false }],
        [`${id}/upload-url`, undefined],
        [`${id}/complete`, { sizeBytes: 1, md5: 'a'.repeat(32) }],
        [`${id}/fail`, { reason: 'x' }],
      ] as const) {
        expect((await post(path, body, null)).statusCode, path).toBe(401);
        expect((await post(path, body, 'wrong')).statusCode, path).toBe(401);
      }
    });

    it('lists the tenants that require recording (S5-12), token required', async () => {
      await h.settings.update({ tenantId: 'tenant-fc' }, { failClosed: true });
      const get = (token: string | null) =>
        r.app.inject({
          method: 'GET',
          url: '/internal/v1/recordings/fail-closed-tenants',
          headers: token === null ? {} : { authorization: `Bearer ${token}` },
        });
      expect((await get(null)).statusCode).toBe(401);
      expect((await get('wrong')).statusCode).toBe(401);
      const response = await get(INTERNAL_TOKEN);
      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ tenantIds: ['tenant-fc'] });
    });

    describe('evaluate', () => {
      it('answers with the winning policy for the call, and the default when none applies', async () => {
        await h.policies.create(
          { tenantId },
          {
            scopeType: 'tenant',
            scopeId: tenantId,
            direction: 'any',
            action: 'record',
            announce: true,
            consentAssetId: 'asset-1',
          },
        );
        await h.policies.create(
          { tenantId },
          {
            scopeType: 'extension',
            scopeId: 'E9',
            direction: 'any',
            action: 'no_record',
            announce: false,
            consentAssetId: null,
          },
        );

        const recorded = await post('evaluate', {
          tenantId,
          direction: 'inbound',
          extensionIds: ['E1'],
        });
        expect(recorded.json()).toMatchObject({
          record: true,
          announce: true,
          consentAssetId: 'asset-1',
          reason: 'policy',
        });
        const refused = await post('evaluate', {
          tenantId,
          direction: 'inbound',
          extensionIds: ['E9'],
        });
        expect(refused.json()).toMatchObject({ record: false, announce: false });

        const other = await post('evaluate', { tenantId: 'tenant-b', direction: 'inbound' });
        expect(other.json()).toEqual({
          record: false,
          announce: false,
          consentAssetId: null,
          policyId: null,
          reason: 'default',
        });
      });

      it('validates the body', async () => {
        expect((await post('evaluate', { tenantId, direction: 'sideways' })).statusCode).toBe(400);
        expect((await post('evaluate', { direction: 'inbound' })).statusCode).toBe(400);
      });
    });

    describe('register, upload-url, complete', () => {
      it('registers a pending recording whose file name is its opaque id', async () => {
        const { recordingId, fileName } = await register();
        expect(fileName).toBe(`${recordingId}.wav`);
        expect(fileName).not.toContain(tenantId);
        expect(fileName).not.toContain('call-1');
        expect((await h.recordings.findById({ tenantId }, recordingId))?.status).toBe('pending');
      });

      it('walks a recording through upload and verification into ready', async () => {
        const { recordingId } = await register();
        const target = (await post(`${recordingId}/upload-url`)).json<{
          uploadUrl: string;
          objectKey: string;
          contentType: string;
        }>();
        expect(
          (
            await fetch(target.uploadUrl, {
              method: 'PUT',
              headers: { 'content-type': target.contentType },
              body: AUDIO,
            })
          ).ok,
        ).toBe(true);

        const done = await post(`${recordingId}/complete`, {
          sizeBytes: AUDIO.length,
          md5: md5(AUDIO),
          sha256: createHash('sha256').update(AUDIO).digest('hex'),
          durationMs: 2000,
        });
        expect(done.statusCode).toBe(200);
        expect(done.json()).toMatchObject({ status: 'ready', sizeBytes: AUDIO.length });
        expect(done.json<{ retentionDate: string | null }>().retentionDate).not.toBeNull();

        const row = await h.recordings.findById({ tenantId }, recordingId);
        expect(row).toMatchObject({ status: 'ready', durationMs: 2000 });
        // Already uploaded: no second upload URL.
        expect((await post(`${recordingId}/upload-url`)).statusCode).toBe(409);
      });

      it('uses the tenant’s retention period for the new recording', async () => {
        await h.settings.setRetentionDays({ tenantId }, 3);
        const { recordingId } = await register();
        const target = (await post(`${recordingId}/upload-url`)).json<{ uploadUrl: string }>();
        await fetch(target.uploadUrl, { method: 'PUT', body: AUDIO });
        await post(`${recordingId}/complete`, { sizeBytes: AUDIO.length, md5: md5(AUDIO) });
        const row = (await h.recordings.findById({ tenantId }, recordingId))!;
        expect(row.retentionDate!.getTime()).toBe(row.startedAt.getTime() + 3 * 86_400_000);
      });

      it('refuses to complete when nothing arrived, the size differs, or the checksum differs', async () => {
        const { recordingId } = await register();
        const missing = await post(`${recordingId}/complete`, {
          sizeBytes: AUDIO.length,
          md5: md5(AUDIO),
        });
        expect(missing.statusCode).toBe(409);
        expect(missing.json<{ code: string }>().code).toBe('object_missing');

        const target = (await post(`${recordingId}/upload-url`)).json<{ uploadUrl: string }>();
        await fetch(target.uploadUrl, { method: 'PUT', body: AUDIO });

        const wrongSize = await post(`${recordingId}/complete`, {
          sizeBytes: AUDIO.length + 1,
          md5: md5(AUDIO),
        });
        expect(wrongSize.json<{ code: string }>().code).toBe('size_mismatch');
        const wrongSum = await post(`${recordingId}/complete`, {
          sizeBytes: AUDIO.length,
          md5: md5(Buffer.from('other')),
        });
        expect(wrongSum.statusCode).toBe(409);
        expect(wrongSum.json<{ code: string }>().code).toBe('checksum_mismatch');

        // None of those made it playable.
        expect((await h.recordings.findById({ tenantId }, recordingId))?.status).toBe('pending');
      });

      it('answers 404 for an unknown or malformed recording id', async () => {
        for (const id of [crypto.randomUUID(), 'not-a-uuid']) {
          expect((await post(`${id}/upload-url`)).statusCode, id).toBe(404);
          expect(
            (await post(`${id}/complete`, { sizeBytes: 1, md5: 'a'.repeat(32) })).statusCode,
            id,
          ).toBe(404);
        }
      });

      it('validates the completion body', async () => {
        const { recordingId } = await register();
        expect(
          (await post(`${recordingId}/complete`, { sizeBytes: 1, md5: 'nothex' })).statusCode,
        ).toBe(400);
        expect((await post(`${recordingId}/complete`, { md5: 'a'.repeat(32) })).statusCode).toBe(
          400,
        );
      });

      it('marks a recording failed when the uploader reports it', async () => {
        const { recordingId } = await register();
        expect((await post(`${recordingId}/fail`, { reason: 'empty_file' })).statusCode).toBe(204);
        expect(await h.recordings.findById({ tenantId }, recordingId)).toMatchObject({
          status: 'failed',
          failureReason: 'empty_file',
        });
      });
    });
  },
);

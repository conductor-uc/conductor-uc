import { createHash } from 'node:crypto';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';
import { createServer, type Server } from '@cuc/http';

import { createPendingSweep } from '../src/pending-sweep.js';
import { registerUploadRoutes } from '../src/routes/upload.routes.js';
import { resetSchema, startHarness, type Harness } from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const TOKEN = 'test-internal-service-token';

describe.skipIf(skipReason !== undefined)(
  'voicemail-service node-uploader routes against a real MinIO (S5-16)',
  () => {
    let h: Harness;
    let app: Server;

    beforeAll(async () => {
      h = await startHarness();
      app = await createServer({ serviceName: 'voicemail-service', logger: h.logger });
      registerUploadRoutes(app, {
        messages: h.messages,
        storage: h.storage,
        logger: h.logger,
        internalServiceToken: TOKEN,
      });
      await app.ready();
    });

    afterAll(async () => {
      await app?.close();
      await h?.close();
    });

    afterEach(async () => {
      await resetSchema(h.db);
    });

    const md5 = (bytes: Buffer) => createHash('md5').update(bytes).digest('hex');
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    function post(path: string, payload?: unknown, token: string | null = TOKEN) {
      return app.inject({
        method: 'POST',
        url: `/internal/v1/voicemail/messages/${path}`,
        headers: token === null ? {} : { authorization: `Bearer ${token}` },
        ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }),
      });
    }

    async function pendingMessage() {
      const tenantId = crypto.randomUUID();
      const mailbox = await h.mailboxes.create(
        { tenantId },
        { extensionId: crypto.randomUUID(), pin: '1234' },
      );
      const { message } = await h.messages.create({ tenantId }, mailbox.id, {
        callerIdNumber: '+15005550001',
      });
      return { tenantId, mailbox, message };
    }

    /** What the uploader does: ask for a URL, then PUT with the file's MD5 so S3 checks it too. */
    async function upload(id: string, bytes: Buffer): Promise<void> {
      const target = await post(`${id}/upload-url`);
      expect(target.statusCode).toBe(200);
      const { uploadUrl, contentType }: { uploadUrl: string; contentType: string } = target.json();
      expect(contentType).toBe('audio/wav');
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': contentType,
          'content-md5': Buffer.from(md5(bytes), 'hex').toString('base64'),
        },
        body: bytes,
      });
      expect(put.ok).toBe(true);
    }

    const wav = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4000, 7)]);

    it('401s every route without the internal token', async () => {
      const { message } = await pendingMessage();
      for (const [path, body] of [
        [`${message.id}/upload-url`, undefined],
        [`${message.id}/complete`, { sizeBytes: 1, md5: 'a'.repeat(32) }],
        [`${message.id}/fail`, { reason: 'x' }],
      ] as const) {
        expect((await post(path, body, null)).statusCode).toBe(401);
        expect((await post(path, body, 'wrong')).statusCode).toBe(401);
      }
    });

    it('404s an id that is not a message id, or one no message has', async () => {
      expect((await post('not-a-uuid/upload-url')).statusCode).toBe(404);
      expect((await post(`${crypto.randomUUID()}/upload-url`)).statusCode).toBe(404);
      expect((await post(`${crypto.randomUUID()}/fail`, { reason: 'empty_file' })).statusCode).toBe(
        404,
      );
    });

    it('upload-url, a real presigned PUT, then complete: verified in storage, ready, events emitted', async () => {
      const { tenantId, mailbox, message } = await pendingMessage();
      await upload(message.id, wav);

      const completed = await post(`${message.id}/complete`, {
        sizeBytes: wav.length,
        md5: md5(wav),
        sha256: sha256(wav),
        durationMs: 2500,
      });
      expect(completed.statusCode).toBe(200);
      expect(completed.json()).toMatchObject({
        id: message.id,
        status: 'ready',
        sizeBytes: wav.length,
      });

      expect(await h.messages.findById({ tenantId }, message.id)).toMatchObject({
        status: 'ready',
        sizeBytes: wav.length,
        durationMs: 2500,
        sha256: sha256(wav),
      });
      const stored = await h.storage.forTenant(tenantId).getObject(message.objectKey);
      expect(stored.equals(wav)).toBe(true);

      // The same events the old FS-driven completion emitted: voicemail-to-email and MWI.
      const events = await h.db.kysely
        .selectFrom('outbox')
        .select(['type', 'payload'])
        .where('tenant_id', '=', tenantId)
        .execute();
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'voicemail.message.created',
          payload: { messageId: message.id, mailboxId: mailbox.id },
        }),
      );
      expect(events).toContainEqual(
        expect.objectContaining({
          type: 'voicemail.mailbox.mwi_changed',
          payload: { mailboxId: mailbox.id },
        }),
      );

      // Already there: both routes say so, which the uploader takes as "done".
      const again = await post(`${message.id}/upload-url`);
      expect(again.statusCode).toBe(409);
      expect(again.json()).toMatchObject({ code: 'already_uploaded' });
      const completeAgain = await post(`${message.id}/complete`, {
        sizeBytes: wav.length,
        md5: md5(wav),
      });
      expect(completeAgain.statusCode).toBe(409);
      expect(completeAgain.json()).toMatchObject({ code: 'already_uploaded' });
    });

    it('refuses to complete when the object is missing, the wrong size, or the wrong checksum', async () => {
      const { tenantId, message } = await pendingMessage();

      const missing = await post(`${message.id}/complete`, {
        sizeBytes: wav.length,
        md5: md5(wav),
      });
      expect(missing.statusCode).toBe(409);
      expect(missing.json()).toMatchObject({ code: 'object_missing' });

      await upload(message.id, wav);
      const wrongSize = await post(`${message.id}/complete`, {
        sizeBytes: wav.length + 1,
        md5: md5(wav),
      });
      expect(wrongSize.json()).toMatchObject({ code: 'size_mismatch' });
      const wrongSum = await post(`${message.id}/complete`, {
        sizeBytes: wav.length,
        md5: 'f'.repeat(32),
      });
      expect(wrongSum.json()).toMatchObject({ code: 'checksum_mismatch' });

      expect((await h.messages.findById({ tenantId }, message.id))?.status).toBe('pending');
      const events = await h.db.kysely
        .selectFrom('outbox')
        .select('type')
        .where('tenant_id', '=', tenantId)
        .execute();
      expect(events).toEqual([]);
    });

    it('fail marks a message failed with its reason, and never a ready one', async () => {
      const { tenantId, message } = await pendingMessage();
      const failed = await post(`${message.id}/fail`, { reason: 'empty_file' });
      expect(failed.statusCode).toBe(204);
      expect(await h.messages.findById({ tenantId }, message.id)).toMatchObject({
        status: 'failed',
        failureReason: 'empty_file',
      });

      const other = await pendingMessage();
      await upload(other.message.id, wav);
      await post(`${other.message.id}/complete`, { sizeBytes: wav.length, md5: md5(wav) });
      expect((await post(`${other.message.id}/fail`, { reason: 'late' })).statusCode).toBe(204);
      expect(
        (await h.messages.findById({ tenantId: other.tenantId }, other.message.id))?.status,
      ).toBe('ready');
    });

    it('still takes the audio of a message the pending sweep gave up on', async () => {
      const { tenantId, message } = await pendingMessage();
      const sweep = createPendingSweep({
        messages: h.messages,
        logger: h.logger,
        // Three days and an hour from now: the message is older than the 72 h limit.
        now: () => new Date(Date.now() + 73 * 60 * 60 * 1000),
        pendingMaxAgeHours: 72,
      });
      expect(await sweep.runOnce()).toBe(1);
      expect(await h.messages.findById({ tenantId }, message.id)).toMatchObject({
        status: 'failed',
        failureReason: 'never_uploaded',
      });

      await upload(message.id, wav);
      const completed = await post(`${message.id}/complete`, {
        sizeBytes: wav.length,
        md5: md5(wav),
      });
      expect(completed.statusCode).toBe(200);
      expect(await h.messages.findById({ tenantId }, message.id)).toMatchObject({
        status: 'ready',
        failureReason: null,
      });
    });

    it('the pending sweep leaves young pending messages alone', async () => {
      const { tenantId, message } = await pendingMessage();
      const sweep = createPendingSweep({
        messages: h.messages,
        logger: h.logger,
        now: () => new Date(),
        pendingMaxAgeHours: 72,
      });
      expect(await sweep.runOnce()).toBe(0);
      expect((await h.messages.findById({ tenantId }, message.id))?.status).toBe('pending');
    });
  },
);

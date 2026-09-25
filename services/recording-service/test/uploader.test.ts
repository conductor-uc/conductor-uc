import { createHash } from 'node:crypto';
import {
  appendFile,
  chmod,
  mkdtemp,
  readFile,
  readdir,
  rm,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Logger } from '@cuc/logger';
import { databaseOrSkipReason, s3OrSkipReason } from '@cuc/testing';

import { createRecordingApi } from '../src/uploader/client.js';
import { createUploader, renderMetrics } from '../src/uploader/uploader.js';
import { buildWav } from '../src/uploader/wav.js';
import {
  INTERNAL_TOKEN,
  resetSchema,
  urlOf,
  startHarness,
  startRoutes,
  type Harness,
  type RoutesHarness,
} from './harness.js';

const skipReason = (await databaseOrSkipReason()) ?? (await s3OrSkipReason());
const tenantId = 'tenant-up';
const MINUTE = 60_000;

/** Records what the uploader logs, so alerts can be asserted. */
function capturingLogger() {
  const lines: { level: string; fields: Record<string, unknown>; message: string }[] = [];
  const make = (level: string) => (fields: unknown, message?: string) => {
    lines.push({
      level,
      fields: (typeof fields === 'object' && fields !== null ? fields : {}) as Record<
        string,
        unknown
      >,
      message: message ?? (typeof fields === 'string' ? fields : ''),
    });
  };
  const logger = {
    trace: make('trace'),
    debug: make('debug'),
    info: make('info'),
    warn: make('warn'),
    error: make('error'),
    fatal: make('fatal'),
    child: () => logger,
  } as unknown as Logger;
  return { logger, lines };
}

describe.skipIf(skipReason !== undefined)(
  'node uploader against a real service and MinIO (S5-03)',
  () => {
    let h: Harness;
    let r: RoutesHarness;
    let baseUrl: string;
    let spool: string;
    /** The uploader's clock; tests move it to skip backoff. */
    let clock: number;

    beforeAll(async () => {
      h = await startHarness();
      r = await startRoutes(h);
      baseUrl = await r.app.listen({ port: 0, host: '127.0.0.1' });
    });
    afterAll(async () => {
      await r?.app.close();
      await h?.close();
    });

    const fresh = async () => {
      spool = await mkdtemp(join(tmpdir(), 'cuc-spool-'));
      clock = Date.now();
    };
    afterEach(async () => {
      await resetSchema(h.db);
      await rm(spool, { recursive: true, force: true });
    });

    type FetchLike = typeof fetch;

    function build(
      options: { apiFetch?: FetchLike; storageFetch?: FetchLike; logger?: Logger } = {},
    ) {
      return createUploader({
        spoolDir: spool,
        api: createRecordingApi({
          baseUrl,
          internalServiceToken: INTERNAL_TOKEN,
          ...(options.apiFetch === undefined ? {} : { fetchImpl: options.apiFetch }),
        }),
        logger: options.logger ?? capturingLogger().logger,
        now: () => clock,
        settleMs: 1_000,
        abandonedMs: 10 * MINUTE,
        stuckMs: 60 * MINUTE,
        backoffBaseMs: 1_000,
        backoffMaxMs: 8_000,
        random: () => 0.5, // no jitter
        stuckLogIntervalMs: 0,
        ...(options.storageFetch === undefined ? {} : { fetchImpl: options.storageFetch }),
      });
    }

    /** Registers a recording and writes its spool file, last touched `ageMs` ago. */
    async function spoolFile(
      audio: Buffer,
      ageMs = 5 * MINUTE,
    ): Promise<{ id: string; path: string; audio: Buffer }> {
      const recording = await h.recordings.register(
        { tenantId },
        { callUuid: crypto.randomUUID(), direction: 'inbound', announced: false },
      );
      const path = join(spool, `${recording.id}.wav`);
      await writeFile(path, audio);
      const touched = new Date(clock - ageMs);
      await utimes(path, touched, touched);
      return { id: recording.id, path, audio };
    }

    const wav = (seconds = 2, options: { open?: boolean } = {}) =>
      buildWav({ sampleRate: 8000, channels: 2, seconds, ...options });
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
    const status = async (id: string) => (await h.recordings.findById({ tenantId }, id))?.status;
    const spoolNames = () => readdir(spool);

    it('uploads a finished recording, verifies it, records its size, duration and sha256, and empties the spool', async () => {
      await fresh();
      const file = await spoolFile(wav(3));

      const result = await build().scanOnce();
      expect(result).toMatchObject({ uploaded: 1, failed: 0 });

      const row = (await h.recordings.findById({ tenantId }, file.id))!;
      expect(row).toMatchObject({
        status: 'ready',
        sizeBytes: file.audio.length,
        durationMs: 3000,
      });
      expect(row.sha256).toBe(sha256(file.audio));
      const stored = await h.storage.forTenant(tenantId).getObject(row.objectKey);
      expect(stored.equals(file.audio)).toBe(true);
      // No file remains on the node.
      expect(await spoolNames()).toEqual([]);
    });

    it('leaves a file that is still being written, and takes one whose header closed or that was abandoned', async () => {
      await fresh();
      const justWritten = await spoolFile(wav(1), 200); // touched 200 ms ago
      const stillOpen = await spoolFile(wav(1, { open: true }), 2 * MINUTE); // header never closed
      const abandoned = await spoolFile(wav(1, { open: true }), 11 * MINUTE); // FreeSWITCH died
      const closed = await spoolFile(wav(1), 2 * MINUTE);

      const result = await build().scanOnce();
      expect(result).toMatchObject({ uploaded: 2 });
      expect((await spoolNames()).sort()).toEqual(
        [`${justWritten.id}.wav`, `${stillOpen.id}.wav`].sort(),
      );
      expect(await status(abandoned.id)).toBe('ready');
      expect(await status(closed.id)).toBe('ready');
      expect(await status(stillOpen.id)).toBe('pending');
    });

    it('retries with backoff after the service fails, and deletes the file only once it succeeds', async () => {
      await fresh();
      const file = await spoolFile(wav());
      let refuse = 2;
      const flaky: FetchLike = (input, init) => {
        if (urlOf(input).endsWith('/upload-url') && refuse > 0) {
          refuse -= 1;
          return Promise.resolve(new Response('{}', { status: 503 }));
        }
        return fetch(input, init);
      };
      const uploader = build({ apiFetch: flaky });

      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 1 });
      expect(await spoolNames()).toEqual([`${file.id}.wav`]);

      // Too soon: the backoff (1s, no jitter) has not passed, so the file is not even tried.
      clock += 500;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 0, skipped: 1 });

      // The second try fails too; its wait doubles (2s).
      clock += 600;
      expect(await uploader.scanOnce()).toMatchObject({ failed: 1 });
      clock += 1_500;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, skipped: 1 });
      expect(await status(file.id)).toBe('pending');

      clock += 1_000;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 1 });
      expect(await spoolNames()).toEqual([]);
      expect(await status(file.id)).toBe('ready');
      expect(uploader.metrics()).toMatchObject({
        uploadedTotal: 1,
        failedAttemptsTotal: 2,
        spoolFiles: 0,
      });
    });

    it('keeps the file and retries when storage is unreachable or refuses the PUT', async () => {
      await fresh();
      const file = await spoolFile(wav());
      let mode: 'down' | 'refuse' | 'ok' = 'down';
      const storageFetch: FetchLike = (input, init) => {
        if (mode === 'down') return Promise.reject(new TypeError('connect ECONNREFUSED'));
        if (mode === 'refuse') return Promise.resolve(new Response('no', { status: 403 }));
        return fetch(input, init);
      };
      const uploader = build({ storageFetch });

      expect(await uploader.scanOnce()).toMatchObject({ failed: 1 });
      mode = 'refuse';
      clock += 5_000;
      expect(await uploader.scanOnce()).toMatchObject({ failed: 1 });
      expect(await spoolNames()).toEqual([`${file.id}.wav`]);
      mode = 'ok';
      clock += 10_000;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 1 });
      expect(await status(file.id)).toBe('ready');
    });

    it('detects a corrupted transfer (checksum mismatch at storage), keeps the file, and re-uploads it intact', async () => {
      await fresh();
      const file = await spoolFile(wav());
      let corrupted = 0;
      const corrupting: FetchLike = async (input, init) => {
        if (init?.method === 'PUT' && corrupted === 0) {
          corrupted += 1;
          // The header still carries the MD5 of the real file, but the bytes are altered in flight.
          const bytes = Buffer.from(await new Response(init.body as ReadableStream).arrayBuffer());
          bytes[bytes.length - 1] = bytes[bytes.length - 1]! ^ 0xff;
          const { duplex: _duplex, ...rest } = init as RequestInit & { duplex?: string };
          return fetch(input, { ...rest, body: bytes });
        }
        return fetch(input, init);
      };
      const uploader = build({ storageFetch: corrupting });

      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 1 });
      expect(corrupted).toBe(1);
      expect(await spoolNames()).toEqual([`${file.id}.wav`]);
      expect(await status(file.id)).toBe('pending');

      clock += 5_000;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 1 });
      const stored = await h.storage
        .forTenant(tenantId)
        .getObject((await h.recordings.findById({ tenantId }, file.id))!.objectKey);
      expect(stored.equals(file.audio)).toBe(true);
    });

    it('keeps the file when the service refuses to verify it (checksum differs), then succeeds', async () => {
      await fresh();
      const file = await spoolFile(wav());
      let lied = false;
      const lyingApi: FetchLike = (input, init) => {
        if (urlOf(input).endsWith('/complete') && !lied) {
          lied = true;
          const body = JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as {
            md5: string;
          };
          body.md5 = 'f'.repeat(32);
          return fetch(input, { ...init, body: JSON.stringify(body) });
        }
        return fetch(input, init);
      };
      const uploader = build({ apiFetch: lyingApi });

      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 1 });
      expect(await spoolNames()).toEqual([`${file.id}.wav`]);
      expect(await status(file.id)).toBe('pending');

      clock += 5_000;
      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 1 });
      expect(await spoolNames()).toEqual([]);
    });

    it('does not delete a file that changed while it was uploading', async () => {
      await fresh();
      const file = await spoolFile(wav());
      let grown = false;
      const growing: FetchLike = async (input, init) => {
        const response = await fetch(input, init);
        if (init?.method === 'PUT' && !grown) {
          grown = true;
          await appendFile(file.path, Buffer.alloc(16)); // FreeSWITCH still writing
        }
        return response;
      };
      const uploader = build({ storageFetch: growing });

      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 1 });
      expect(await spoolNames()).toEqual([`${file.id}.wav`]);
    });

    it('raises the stuck-file alert (error log and metric) for a file on the node too long, and keeps it', async () => {
      await fresh();
      const { logger, lines } = capturingLogger();
      const down: FetchLike = () => Promise.resolve(new Response('{}', { status: 503 }));
      const old = await spoolFile(wav(), 61 * MINUTE);
      const recent = await spoolFile(wav(), 2 * MINUTE);
      void recent;
      const uploader = build({ apiFetch: down, logger });

      await uploader.scanOnce();
      expect(uploader.metrics()).toMatchObject({ spoolFiles: 2, stuckFiles: 1 });
      expect(uploader.metrics().oldestFileAgeSeconds).toBeGreaterThanOrEqual(61 * 60);
      const alert = lines.find((line) => line.fields['alert'] === 'recording_upload_stuck');
      expect(alert).toMatchObject({ level: 'error' });
      expect(alert?.fields['recordingId']).toBe(old.id);
      expect(await spoolNames()).toHaveLength(2);
      // The alert carries an opaque id and an age, nothing about the tenant or the call.
      expect(JSON.stringify(alert?.fields)).not.toContain(tenantId);

      const text = renderMetrics(uploader.metrics());
      expect(text).toContain('cuc_recording_spool_stuck_files 1');
      expect(text).toContain('cuc_recording_spool_files 2');
    });

    it('clears the alert once the outage ends and the backlog uploads', async () => {
      await fresh();
      let down = true;
      const outage: FetchLike = (input, init) =>
        down ? Promise.resolve(new Response('{}', { status: 503 })) : fetch(input, init);
      await spoolFile(wav(), 61 * MINUTE);
      const uploader = build({ apiFetch: outage });

      await uploader.scanOnce();
      expect(uploader.metrics().stuckFiles).toBe(1);
      down = false;
      clock += 10_000;
      await uploader.scanOnce();
      expect(uploader.metrics()).toMatchObject({ stuckFiles: 0, spoolFiles: 0 });
    });

    it('cleans up: uploads a backlog, drops duplicates and empty files, ignores foreign files', async () => {
      await fresh();
      const a = await spoolFile(wav());
      const b = await spoolFile(wav(1));
      const c = await spoolFile(wav(1));
      // A duplicate: the service already holds this recording.
      const dup = await spoolFile(wav());
      await build().scanOnce(); // uploads all four
      expect(await spoolNames()).toEqual([]);
      await writeFile(dup.path, dup.audio);
      const touched = new Date(clock - 5 * MINUTE);
      await utimes(dup.path, touched, touched);
      // An empty file for a fresh recording, and files that are not recordings at all.
      const empty = await spoolFile(Buffer.alloc(0), 11 * MINUTE); // never got media, and past the abandoned cutoff
      await writeFile(join(spool, 'notes.txt'), 'not a recording');
      const partial = `${crypto.randomUUID()}.wav.part`;
      await writeFile(join(spool, partial), 'partial');

      const result = await build().scanOnce();
      expect(result.uploaded).toBe(0);
      expect((await spoolNames()).sort()).toEqual(['notes.txt', partial].sort());
      expect(await status(empty.id)).toBe('failed');
      expect(await h.recordings.findById({ tenantId }, empty.id)).toMatchObject({
        failureReason: 'empty_file',
      });
      for (const done of [a, b, c, dup]) expect(await status(done.id)).toBe('ready');
      expect(await readFile(join(spool, 'notes.txt'), 'utf8')).toBe('not a recording');
    });

    it('alerts when a stored recording cannot be deleted from the spool, and only retries the delete', async () => {
      // Seen live: a sticky-bit spool where the uploader may not delete FreeSWITCH's files.
      await fresh();
      const file = await spoolFile(wav());
      let apiCalls = 0;
      const counting: FetchLike = (input, init) => {
        apiCalls += 1;
        return fetch(input, init);
      };
      const { logger, lines } = capturingLogger();
      const uploader = build({ apiFetch: counting, logger });

      await chmod(spool, 0o555);
      try {
        expect(await uploader.scanOnce()).toMatchObject({ uploaded: 1, failed: 0 });
        expect(await status(file.id)).toBe('ready');
        expect(await spoolNames()).toEqual([`${file.id}.wav`]);
        const alert = lines.find((l) => l.fields['alert'] === 'recording_spool_delete_failed');
        expect(alert?.level).toBe('error');
        expect(uploader.metrics()).toMatchObject({ undeletableFiles: 1, uploadedTotal: 1 });
        expect(renderMetrics(uploader.metrics())).toContain(
          'cuc_recording_spool_undeletable_files 1',
        );

        // Later scans do not upload it again or ask the service about it.
        const asked = apiCalls;
        expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 0 });
        expect(apiCalls).toBe(asked);
      } finally {
        await chmod(spool, 0o755);
      }

      // Once the delete is possible, it happens, and the alert clears.
      await uploader.scanOnce();
      expect(await spoolNames()).toEqual([]);
      expect(uploader.metrics()).toMatchObject({ undeletableFiles: 0, uploadedTotal: 1 });
    });

    it('holds a file whose recording the service does not know, and alerts if it stays', async () => {
      await fresh();
      const orphan = join(spool, `${crypto.randomUUID()}.wav`);
      await writeFile(orphan, wav());
      const touched = new Date(clock - 61 * MINUTE);
      await utimes(orphan, touched, touched);
      const { logger, lines } = capturingLogger();
      const uploader = build({ logger });

      expect(await uploader.scanOnce()).toMatchObject({ uploaded: 0, failed: 1 });
      expect(await spoolNames()).toHaveLength(1);
      expect(uploader.metrics().stuckFiles).toBe(1);
      expect(lines.some((l) => l.fields['alert'] === 'recording_upload_stuck')).toBe(true);
    });

    it('uploads several files in one pass, concurrently', async () => {
      await fresh();
      const files = await Promise.all([1, 2, 3, 4, 5].map((n) => spoolFile(wav(n))));
      const result = await build().scanOnce();
      expect(result.uploaded).toBe(5);
      for (const file of files) expect(await status(file.id)).toBe('ready');
      expect(await spoolNames()).toEqual([]);
    });
  },
);

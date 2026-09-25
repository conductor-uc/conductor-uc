import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { open, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';

import type { Logger } from '@cuc/logger';

import { AlreadyUploadedError, TransientUploadError, type RecordingApi } from './client.js';
import { inspectWav } from './wav.js';

/** `<recording id>.wav`, the only names the uploader touches: FreeSWITCH writes exactly this. */
const SPOOL_FILE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.wav$/;
/** A file with no room for a WAV header holds no audio. */
const MIN_AUDIO_FILE_BYTES = 45;

export interface UploaderOptions {
  readonly spoolDir: string;
  readonly api: RecordingApi;
  readonly logger: Logger;
  /** Injected so tests drive time; production passes `Date.now`. */
  readonly now?: () => number;
  /** A file untouched this long is done being written, provided its header is consistent. */
  readonly settleMs: number;
  /** A file untouched this long is uploaded even if its header never closed (FreeSWITCH died mid-call). */
  readonly abandonedMs: number;
  /** A file still on the node this long after it was last written raises the stuck alert. */
  readonly stuckMs: number;
  readonly backoffBaseMs: number;
  readonly backoffMaxMs: number;
  /** How many files upload at once. */
  readonly concurrency?: number;
  /** 0..1, for backoff jitter. Tests pass a constant. */
  readonly random?: () => number;
  /** Minimum time between two stuck-file log lines for the same file. */
  readonly stuckLogIntervalMs?: number;
  readonly fetchImpl?: typeof fetch;
}

interface FileState {
  attempts: number;
  nextAttemptAt: number;
  lastError: string | null;
  lastStuckLogAt: number;
  /** The service already holds this recording (or was told it is empty); only the local copy is left to delete. */
  settled: boolean;
  lastDeleteErrorLogAt: number;
}

export interface UploaderMetrics {
  /** Files in the spool right now. */
  readonly spoolFiles: number;
  readonly spoolBytes: number;
  /** Files past `stuckMs`: the alert signal. Zero when healthy. */
  readonly stuckFiles: number;
  /** Files the service already holds that could not be deleted from the spool: also an alert. */
  readonly undeletableFiles: number;
  readonly oldestFileAgeSeconds: number;
  readonly uploadedTotal: number;
  readonly failedAttemptsTotal: number;
}

export interface ScanResult {
  readonly uploaded: number;
  readonly failed: number;
  readonly skipped: number;
  readonly stuck: number;
}

/**
 * The node's recording uploader (S5-03; 03 §6): watches the spool directory, and for each
 * finished file asks recording-service for a presigned PUT, uploads it, has the service verify
 * what arrived (size and MD5), and only then deletes the local file. It holds no storage or
 * database credentials, and the spool is transient: nothing here is a durable copy (D-011).
 *
 * A file leaves the spool only after the service has confirmed the stored object matches. Any
 * failure leaves it in place for the next attempt, spaced by exponential backoff with jitter.
 * A file that stays past `stuckMs` raises the alert (an error log line and a non-zero
 * `stuckFiles` metric).
 */
export function createUploader(options: UploaderOptions) {
  const { spoolDir, api, logger } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const fetchImpl = options.fetchImpl ?? fetch;
  const concurrency = options.concurrency ?? 2;
  const stuckLogIntervalMs = options.stuckLogIntervalMs ?? 5 * 60 * 1000;

  const states = new Map<string, FileState>();
  let scanning = false;
  let timer: NodeJS.Timeout | undefined;
  let uploadedTotal = 0;
  let failedAttemptsTotal = 0;
  let snapshot: UploaderMetrics = {
    spoolFiles: 0,
    spoolBytes: 0,
    stuckFiles: 0,
    undeletableFiles: 0,
    oldestFileAgeSeconds: 0,
    uploadedTotal: 0,
    failedAttemptsTotal: 0,
  };

  function stateFor(name: string): FileState {
    let state = states.get(name);
    if (state === undefined) {
      state = {
        attempts: 0,
        nextAttemptAt: 0,
        lastError: null,
        lastStuckLogAt: 0,
        settled: false,
        lastDeleteErrorLogAt: 0,
      };
      states.set(name, state);
    }
    return state;
  }

  function backoffMs(attempts: number): number {
    const exponential = Math.min(options.backoffMaxMs, options.backoffBaseMs * 2 ** (attempts - 1));
    // +/- 20%, so nodes that failed together do not retry in lockstep.
    return Math.round(exponential * (0.8 + random() * 0.4));
  }

  async function fingerprint(path: string): Promise<{ md5: string; sha256: string }> {
    const md5 = createHash('md5');
    const sha256 = createHash('sha256');
    for await (const chunk of createReadStream(path) as AsyncIterable<Buffer>) {
      md5.update(chunk);
      sha256.update(chunk);
    }
    return { md5: md5.digest('hex'), sha256: sha256.digest('hex') };
  }

  async function readHeader(path: string): Promise<Buffer> {
    const handle = await open(path, 'r');
    try {
      const buffer = Buffer.alloc(512);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
      return buffer.subarray(0, bytesRead);
    } finally {
      await handle.close();
    }
  }

  /**
   * Deletes a spool file whose recording the service already holds. True when it is gone. A failure
   * is not an upload failure (the service must not be asked again) but it is an alert: the node is
   * keeping audio it must not keep (CLAUDE.md rule 5), and the spool fills. Seen live: a spool
   * directory with the sticky bit, where the uploader may not delete FreeSWITCH's files.
   */
  async function removeLocal(name: string, state: FileState): Promise<boolean> {
    try {
      await unlink(join(spoolDir, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true;
      state.settled = true;
      state.lastError = error instanceof Error ? error.message : String(error);
      const current = now();
      if (current - state.lastDeleteErrorLogAt >= stuckLogIntervalMs) {
        state.lastDeleteErrorLogAt = current;
        logger.error(
          {
            alert: 'recording_spool_delete_failed',
            recordingId: name.slice(0, -4),
            code: (error as NodeJS.ErrnoException).code,
            err: state.lastError,
          },
          'uploader: a recording is safely stored but could not be deleted from the node',
        );
      }
      return false;
    }
  }

  /** Uploads one file. Resolves 'uploaded' / 'dropped' (the service knows it is empty) or throws to be retried. The caller deletes it. */
  async function upload(
    name: string,
    path: string,
    size: number,
    mtimeMs: number,
  ): Promise<'uploaded' | 'dropped'> {
    const recordingId = name.slice(0, -'.wav'.length);
    const header = await readHeader(path);
    const wav = inspectWav(header, size);

    if (size < MIN_AUDIO_FILE_BYTES) {
      // No audio was ever written (the call never got media). Tell the service and drop it.
      await api.fail(recordingId, 'empty_file');
      logger.info({ recordingId }, 'uploader: dropping an empty spool file');
      return 'dropped';
    }

    const { md5, sha256 } = await fingerprint(path);
    const target = await api.requestUploadUrl(recordingId);

    let response: Response;
    try {
      response = await fetchImpl(target.uploadUrl, {
        method: 'PUT',
        headers: {
          'content-type': target.contentType,
          'content-length': String(size),
          // S3 recomputes the MD5 of what arrived and rejects the upload if it differs.
          'content-md5': Buffer.from(md5, 'hex').toString('base64'),
        },
        body: Readable.toWeb(createReadStream(path)),
        duplex: 'half',
      });
    } catch (error) {
      throw new TransientUploadError(
        `storage could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!response.ok) {
      throw new TransientUploadError(`storage refused the upload (${String(response.status)}).`);
    }

    // The service compares its object's size and ETag with what we sent before it says yes.
    await api.complete(recordingId, { sizeBytes: size, md5, sha256, durationMs: wav.durationMs });

    // The file must be exactly what was uploaded: one that changed since was still being written.
    const after = await stat(path);
    if (after.size !== size || after.mtimeMs !== mtimeMs) {
      throw new TransientUploadError('the file changed while it was being uploaded.');
    }
    return 'uploaded';
  }

  async function processFile(
    name: string,
    size: number,
    mtimeMs: number,
    result: { uploaded: number; failed: number },
  ): Promise<void> {
    const state = stateFor(name);
    if (state.settled) {
      // Only the delete is left; the service is not asked again.
      if (await removeLocal(name, state)) {
        states.delete(name);
        logger.info({ recordingId: name.slice(0, -4) }, 'uploader: spool file deleted on retry');
      }
      return;
    }
    try {
      const outcome = await upload(name, join(spoolDir, name), size, mtimeMs);
      if (outcome === 'uploaded') {
        uploadedTotal += 1;
        result.uploaded += 1;
        logger.info(
          { recordingId: name.slice(0, -4), bytes: size },
          'uploader: recording uploaded',
        );
      }
      if (await removeLocal(name, state)) states.delete(name);
    } catch (error) {
      if (error instanceof AlreadyUploadedError) {
        // The service already holds this recording; the spool copy is a duplicate.
        if (await removeLocal(name, state)) {
          states.delete(name);
          logger.warn(
            { recordingId: name.slice(0, -4) },
            'uploader: dropped a duplicate spool file',
          );
        }
        return;
      }
      state.attempts += 1;
      state.lastError = error instanceof Error ? error.message : String(error);
      failedAttemptsTotal += 1;
      result.failed += 1;
      // A recording the service has never heard of may be registered a moment later; a
      // corrupt upload should be redone. Both simply wait out the backoff.
      const wait = backoffMs(state.attempts);
      state.nextAttemptAt = now() + wait;
      logger.warn(
        {
          recordingId: name.slice(0, -4),
          attempts: state.attempts,
          retryInMs: wait,
          err: state.lastError,
          kind: error instanceof Error ? error.name : 'UnexpectedError',
        },
        'uploader: upload failed; will retry',
      );
    }
  }

  /** One pass over the spool. Safe to call while a previous pass runs: the second returns at once. */
  async function scanOnce(): Promise<ScanResult> {
    const result = { uploaded: 0, failed: 0, skipped: 0, stuck: 0 };
    if (scanning) return result;
    scanning = true;
    try {
      let names: string[];
      try {
        names = (await readdir(spoolDir)).filter((name) => SPOOL_FILE.test(name));
      } catch (error) {
        logger.error(
          { err: error instanceof Error ? error.message : String(error) },
          'uploader: cannot read the spool directory',
        );
        return result;
      }

      const current = now();
      const ready: { name: string; size: number; mtimeMs: number }[] = [];
      const present = new Set(names);
      for (const name of [...states.keys()]) if (!present.has(name)) states.delete(name);

      for (const name of names) {
        let info;
        try {
          info = await stat(join(spoolDir, name));
        } catch {
          continue; // removed between readdir and stat
        }
        const age = current - info.mtimeMs;

        if (age < options.settleMs) {
          result.skipped += 1;
          continue;
        }
        if (age < options.abandonedMs) {
          const header = await readHeader(join(spoolDir, name)).catch(() => Buffer.alloc(0));
          if (!inspectWav(header, info.size).complete) {
            result.skipped += 1; // still being written
            continue;
          }
        }
        if (stateFor(name).nextAttemptAt > current) {
          result.skipped += 1;
          continue;
        }
        ready.push({ name, size: info.size, mtimeMs: info.mtimeMs });
      }

      let next = 0;
      const workers = Array.from({ length: Math.min(concurrency, ready.length) }, async () => {
        while (next < ready.length) {
          const item = ready[next++]!;
          await processFile(item.name, item.size, item.mtimeMs, result);
        }
      });
      await Promise.all(workers);

      // What remains after this pass is what the alert is about: files that uploaded are gone.
      const after = now();
      const remaining = (await readdir(spoolDir).catch(() => [] as string[])).filter((name) =>
        SPOOL_FILE.test(name),
      );
      let remainingBytes = 0;
      let remainingOldestMs = 0;
      let stuckFiles = 0;
      let undeletableFiles = 0;
      for (const name of remaining) {
        if (states.get(name)?.settled === true) undeletableFiles += 1;
        const info = await stat(join(spoolDir, name)).catch(() => undefined);
        if (info === undefined) continue;
        remainingBytes += info.size;
        const age = after - info.mtimeMs;
        remainingOldestMs = Math.max(remainingOldestMs, age);
        if (age < options.stuckMs) continue;
        stuckFiles += 1;
        const state = stateFor(name);
        if (after - state.lastStuckLogAt >= stuckLogIntervalMs) {
          state.lastStuckLogAt = after;
          logger.error(
            {
              alert: 'recording_upload_stuck',
              recordingId: name.slice(0, -4),
              ageSeconds: Math.round(age / 1000),
              attempts: state.attempts,
              lastError: state.lastError,
            },
            'uploader: a recording has been on the node too long without uploading',
          );
        }
      }
      result.stuck = stuckFiles;
      snapshot = {
        spoolFiles: remaining.length,
        spoolBytes: remainingBytes,
        stuckFiles,
        undeletableFiles,
        oldestFileAgeSeconds: Math.round(remainingOldestMs / 1000),
        uploadedTotal,
        failedAttemptsTotal,
      };
      return result;
    } finally {
      scanning = false;
    }
  }

  return {
    scanOnce,
    metrics: (): UploaderMetrics => snapshot,

    start(intervalMs: number): void {
      timer = setInterval(() => {
        scanOnce().catch((error: unknown) => {
          logger.error(
            { err: error instanceof Error ? error.message : String(error) },
            'uploader: scan failed',
          );
        });
      }, intervalMs);
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type Uploader = ReturnType<typeof createUploader>;

/** Prometheus text exposition of the uploader's metrics. `cuc_recording_spool_stuck_files > 0` is the alert. */
export function renderMetrics(metrics: UploaderMetrics): string {
  const lines = [
    '# HELP cuc_recording_spool_files Recordings waiting in the node spool.',
    '# TYPE cuc_recording_spool_files gauge',
    `cuc_recording_spool_files ${String(metrics.spoolFiles)}`,
    '# HELP cuc_recording_spool_bytes Bytes waiting in the node spool.',
    '# TYPE cuc_recording_spool_bytes gauge',
    `cuc_recording_spool_bytes ${String(metrics.spoolBytes)}`,
    '# HELP cuc_recording_spool_stuck_files Recordings on the node longer than the stuck threshold. Alert when above zero.',
    '# TYPE cuc_recording_spool_stuck_files gauge',
    `cuc_recording_spool_stuck_files ${String(metrics.stuckFiles)}`,
    '# HELP cuc_recording_spool_undeletable_files Recordings already stored that could not be deleted from the node spool. Alert when above zero.',
    '# TYPE cuc_recording_spool_undeletable_files gauge',
    `cuc_recording_spool_undeletable_files ${String(metrics.undeletableFiles)}`,
    '# HELP cuc_recording_spool_oldest_file_age_seconds Age of the oldest spool file.',
    '# TYPE cuc_recording_spool_oldest_file_age_seconds gauge',
    `cuc_recording_spool_oldest_file_age_seconds ${String(metrics.oldestFileAgeSeconds)}`,
    '# HELP cuc_recording_uploaded_total Recordings uploaded since this process started.',
    '# TYPE cuc_recording_uploaded_total counter',
    `cuc_recording_uploaded_total ${String(metrics.uploadedTotal)}`,
    '# HELP cuc_recording_upload_failures_total Failed upload attempts since this process started.',
    '# TYPE cuc_recording_upload_failures_total counter',
    `cuc_recording_upload_failures_total ${String(metrics.failedAttemptsTotal)}`,
    '',
  ];
  return lines.join('\n');
}

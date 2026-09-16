import type { Database } from '@cuc/db';
import { createConsumer, type Bus, type EventConsumer } from '@cuc/events';
import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import { mediaWorkerEvents } from '../events.js';
import type { PbxConfigClient } from '../pbx-config-client.js';
import type { MediaWorkerDb } from '../schema.js';
import { TranscodeError, transcodeToWav, type TranscodePaths } from '../transcode.js';

interface FinalizeRequestedData {
  readonly mediaAssetId: string;
}

export interface MediaAssetConsumerOptions {
  /** How long one pull waits for a message (`@cuc/events`' default: 1s). Longer in tests. */
  readonly pullTimeoutMs?: number;
}

/** Where a transcoded variant lands: right next to the raw upload, not a prefix this service invents on its own (it does not know pbx-config-service's own `RAW_OBJECT_PREFIX` convention, and should not need to). */
function siblingKey(objectKey: string, filename: string): string {
  const lastSlash = objectKey.lastIndexOf('/');
  const dir = lastSlash === -1 ? '' : objectKey.slice(0, lastSlash);
  return dir === '' ? filename : `${dir}/${filename}`;
}

/**
 * The `PBX` stream consumer for `pbx.media_asset.finalize_requested` (S2-07)
 * — this service's entire reason to exist. Fetches the raw upload
 * (`@cuc/storage`'s `getObject`, never pbx-config-service's database
 * directly — S2-07's own isolation decision), runs it through `ffmpeg`
 * (`transcode.ts`), writes both WAV variants back, and reports the result
 * to pbx-config-service over its internal API (`pbx-config-client.ts`).
 *
 * A bad upload (`TranscodeError` — `ffmpeg`/`ffprobe` itself rejected the
 * bytes) is a *permanent*, data-dependent failure: retrying via JetStream
 * redelivery would just fail the same way every time, so it is reported
 * through `:fail` and the handler returns normally (acked, not retried —
 * the tenant's own `:finalize` is what retries this, after fixing the
 * upload). Anything else — pbx-config-service or S3 unreachable, disk
 * issues on this host — is left to throw, so the built-in
 * redeliver-with-backoff (`@cuc/events`' `createConsumer`) can recover from
 * what might just be transient.
 */
export function createMediaAssetConsumer(
  db: Database<MediaWorkerDb>,
  bus: Bus,
  logger: Logger,
  storage: Storage,
  pbxConfigClient: PbxConfigClient,
  transcodePaths: TranscodePaths,
  options: MediaAssetConsumerOptions = {},
): EventConsumer {
  return createConsumer<MediaWorkerDb>({
    db: db.kysely,
    bus,
    logger,
    registry: mediaWorkerEvents,
    durable: 'media-worker',
    subjects: ['pbx.media_asset.finalize_requested'],
    ...(options.pullTimeoutMs === undefined ? {} : { pullTimeoutMs: options.pullTimeoutMs }),
    handler: async (envelope) => {
      const tenantId = envelope.orgContext.tenantId;
      if (tenantId === undefined) {
        logger.warn(
          { eventId: envelope.id },
          'finalize_requested event with no tenantId; skipping',
        );
        return;
      }
      const { mediaAssetId } = envelope.data as FinalizeRequestedData;
      const log = logger.child({ tenantId, mediaAssetId });

      const asset = await pbxConfigClient.findMediaAsset(tenantId, mediaAssetId);
      if (asset === undefined) {
        // Not a retry target: either a stale/duplicate event for an asset
        // since deleted, or a race this codebase accepts elsewhere too
        // (`projection.ts`'s own "not found (or superseded) ... skipping").
        log.warn('media asset not found in pbx-config-service; skipping');
        return;
      }

      const tenantStorage = storage.forTenant(tenantId);
      let raw: Buffer;
      try {
        raw = await tenantStorage.getObject(asset.objectKey);
      } catch (error) {
        log.error({ err: error }, 'could not read the raw upload; reporting failure');
        await pbxConfigClient.failMediaAsset(
          tenantId,
          mediaAssetId,
          `raw upload could not be read: ${error instanceof Error ? error.message : String(error)}`,
        );
        return;
      }

      let transcoded;
      try {
        transcoded = await transcodeToWav(raw, transcodePaths);
      } catch (error) {
        if (!(error instanceof TranscodeError)) throw error;
        log.warn({ err: error }, 'transcode rejected the upload; reporting failure');
        await pbxConfigClient.failMediaAsset(tenantId, mediaAssetId, error.message);
        return;
      }

      const variant8kKey = siblingKey(asset.objectKey, '8k.wav');
      const variant16kKey = siblingKey(asset.objectKey, '16k.wav');
      await tenantStorage.putObject(variant8kKey, transcoded.wav8k, { contentType: 'audio/wav' });
      await tenantStorage.putObject(variant16kKey, transcoded.wav16k, { contentType: 'audio/wav' });

      await pbxConfigClient.completeMediaAsset(tenantId, mediaAssetId, {
        durationMs: transcoded.durationMs,
        sha256: transcoded.sha256,
        sizeBytes: transcoded.sizeBytes,
        variant8kKey,
        variant16kKey,
      });
      log.info({ durationMs: transcoded.durationMs }, 'media asset transcoded');
    },
  });
}

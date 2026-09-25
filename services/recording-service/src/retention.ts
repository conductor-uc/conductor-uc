import type { Logger } from '@cuc/logger';
import { tenantShortId, type Storage } from '@cuc/storage';

import { lifecycleExpirationDays } from './domain/retention.js';
import type { RecordingRepo } from './repo/recording.repo.js';

export interface RetentionJobOptions {
  readonly recordings: RecordingRepo;
  readonly storage: Storage;
  readonly logger: Logger;
  /** Injected so tests drive time; production passes `() => new Date()`. */
  readonly now: () => Date;
  /** Most recordings one pass expires. */
  readonly batchSize: number;
  /** How long a `pending` recording may wait for its upload before it is marked failed. */
  readonly pendingMaxAgeHours: number;
}

export interface RetentionResult {
  readonly expired: number;
  /** Recordings whose audio could not be deleted this pass; they are retried next pass. */
  readonly deleteFailures: number;
  readonly stalePending: number;
}

/** Background context: no actor, so no tenant. Every row is then handled in its own tenant's scope. */
const JOB_CONTEXT = {};

/**
 * The retention sweep (S5-05): deletes the audio of every ready recording past its retention
 * date, then marks its row `expired` (metadata stays, so a CDR's recording id still resolves
 * to "expired" rather than to nothing). The audio is deleted first: if that fails the row
 * stays `ready` and the next pass retries, so a row never claims deleted audio still exists
 * nor the reverse.
 *
 * The S3 lifecycle rule (`applyLifecycleBackstop`) is a second line, set a day later than the
 * database's retention; it exists for the case where this job is down for days.
 */
export function createRetentionJob(options: RetentionJobOptions) {
  const { recordings, storage, logger } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function runOnce(): Promise<RetentionResult> {
    const now = options.now();
    let expired = 0;
    let deleteFailures = 0;

    const due = await recordings.findDueForExpiry(JOB_CONTEXT, now, options.batchSize);
    for (const recording of due) {
      try {
        await storage.forTenant(recording.tenantId).deleteObject(recording.objectKey);
      } catch (error) {
        deleteFailures += 1;
        logger.error(
          {
            err: error instanceof Error ? error.message : String(error),
            recordingId: recording.id,
          },
          'retention: could not delete a recording’s audio; will retry next pass',
        );
        continue;
      }
      await recordings.markExpired({ tenantId: recording.tenantId }, recording.id);
      expired += 1;
    }

    const cutoff = new Date(now.getTime() - options.pendingMaxAgeHours * 60 * 60 * 1000);
    const stalePending = await recordings.failStalePending(JOB_CONTEXT, cutoff);

    if (expired > 0 || deleteFailures > 0 || stalePending > 0) {
      logger.info({ expired, deleteFailures, stalePending }, 'retention: sweep finished');
    }
    return { expired, deleteFailures, stalePending };
  }

  return {
    runOnce,

    start(intervalMs: number): void {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        runOnce()
          .catch((error: unknown) => {
            logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'retention: sweep failed',
            );
          })
          .finally(() => {
            running = false;
          });
      }, intervalMs);
      timer.unref();
    },

    stop(): void {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
    },
  };
}

export type RetentionJob = ReturnType<typeof createRetentionJob>;

const LIFECYCLE_RULE_PREFIX = 'recording-retention';

/**
 * Sets (or, with retention off, removes) the tenant's S3 lifecycle rule for `recordings/`
 * (05 §4: "retention runs on lifecycle rules set from the tenant's retention policy"). The
 * rule id carries the tenant so that, under prefix-per-tenant storage where all tenants share
 * one bucket, tenants' rules do not replace each other. Best effort: it is a backstop, so a
 * failure is logged and the retention setting is still saved.
 */
export async function applyLifecycleBackstop(
  storage: Storage,
  logger: Logger,
  tenantId: string,
  retentionDays: number,
): Promise<void> {
  const id = `${LIFECYCLE_RULE_PREFIX}-${tenantShortId(tenantId)}`;
  const days = lifecycleExpirationDays(retentionDays);
  try {
    const scoped = storage.forTenant(tenantId);
    if (days === null) {
      await scoped.removeLifecycleRule(id);
    } else {
      await scoped.provisionBucket();
      await scoped.setLifecycleRule({ id, prefix: 'recordings/', expirationDays: days });
    }
  } catch (error) {
    logger.warn(
      { err: error instanceof Error ? error.message : String(error), tenantId },
      'retention: could not set the S3 lifecycle rule; the retention sweep still applies',
    );
  }
}

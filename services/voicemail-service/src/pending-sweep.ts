import type { Logger } from '@cuc/logger';

import type { MessageRepo } from './repo/message.repo.js';

export interface PendingSweepOptions {
  readonly messages: MessageRepo;
  readonly logger: Logger;
  /** Injected so tests drive time; production passes `() => new Date()`. */
  readonly now: () => Date;
  /** How long a `pending` message may wait for its audio before it is marked failed. */
  readonly pendingMaxAgeHours: number;
}

/** Background context: no actor, so no tenant. */
const JOB_CONTEXT = {};

/**
 * The pending-message sweep (S5-16), recording-service's `failStalePending` for voicemail.
 * A message row is created before the caller is recorded, and becomes ready only when the
 * node uploader delivers its audio. One whose audio never comes (the caller hung up before
 * anything was written, or the node died with the file) would otherwise stay `pending`
 * forever; this marks it `failed` (`never_uploaded`) after `pendingMaxAgeHours`. Pending
 * messages are never listed either way; this keeps the table honest. A file that does arrive
 * later still completes (`MessageRepo.complete` accepts a failed message).
 */
export function createPendingSweep(options: PendingSweepOptions) {
  const { messages, logger } = options;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  async function runOnce(): Promise<number> {
    const cutoff = new Date(options.now().getTime() - options.pendingMaxAgeHours * 60 * 60 * 1000);
    const stale = await messages.failStalePending(JOB_CONTEXT, cutoff);
    if (stale > 0)
      logger.info({ stale }, 'pending sweep: marked messages that never arrived failed');
    return stale;
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
              'pending sweep: failed',
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

export type PendingSweep = ReturnType<typeof createPendingSweep>;

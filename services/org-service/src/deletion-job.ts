import type { Logger } from '@cuc/logger';

import type { OrgRepo } from './repo/org.repo.js';

/** How often the job looks for deletions whose grace period is over: hourly. */
export const DELETION_INTERVAL_MS = 60 * 60 * 1000;

/**
 * S1-16 (G-11 (3)): once an org's 30 days are up, it is deleted
 * (`org.{type}.deleted`), and every service removes its data. Runs at
 * startup and then hourly; safe in several copies at once, since each org is
 * claimed with a conditional update (`finishDueDeletions`).
 */
export function createDeletionJob(options: {
  readonly repo: Pick<OrgRepo, 'finishDueDeletions'>;
  readonly logger: Logger;
  readonly now?: () => Date;
}) {
  const { repo, logger } = options;
  const now = options.now ?? (() => new Date());
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<string[]> | undefined;

  function runOnce(): Promise<string[]> {
    running ??= repo
      .finishDueDeletions(now())
      .then((deleted) => {
        if (deleted.length > 0) {
          logger.info({ orgIds: deleted }, `org deletion: ${String(deleted.length)} deleted`);
        }
        return deleted;
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  }

  function runLogged(): void {
    runOnce().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'org deletion: pass failed; will retry on the next one',
      );
    });
  }

  return {
    runOnce,
    start(intervalMs: number): void {
      runLogged();
      timer = setInterval(runLogged, intervalMs);
      timer.unref();
    },
    async stop(): Promise<void> {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}

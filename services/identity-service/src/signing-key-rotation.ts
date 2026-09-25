import type { Logger } from '@cuc/logger';

import type { RotationResult, SigningKeyRepo } from './repo/signing-key.repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** How often the age is checked. Hourly is plenty for a 90-day rotation. */
export const SIGNING_KEY_CHECK_INTERVAL_MS = 60 * 60 * 1000;
/** The first check, shortly after startup rather than an hour into it. */
export const SIGNING_KEY_FIRST_CHECK_DELAY_MS = 30 * 1000;

export interface SigningKeyRotatorOptions {
  readonly signingKeys: Pick<SigningKeyRepo, 'rotateIfOlderThan'>;
  /** `SIGNING_KEY_ROTATION_DAYS`. The caller does not start the rotator at 0. */
  readonly rotationDays: number;
  readonly logger: Logger;
  /** Injected so tests drive time; production leaves it out. */
  readonly now?: () => Date;
}

/**
 * Automatic signing-key rotation (G-116, 07 §2): checks now and then whether
 * the current key is older than `SIGNING_KEY_ROTATION_DAYS` and, if so,
 * rotates it. Every copy of identity-service runs this; the age check and the
 * rotation share one transaction with the current key's row locked, so the
 * copies rotate once between them (`rotateIfOlderThan`).
 *
 * No copy keeps signing with the retired key: `current()` reads the current
 * key from the database for every token it signs. The retired key stays in
 * the JWKS for `SIGNING_KEY_OVERLAP_DAYS`, so tokens it signed moments before
 * keep verifying until they expire.
 */
export function createSigningKeyRotator(options: SigningKeyRotatorOptions) {
  const { signingKeys, rotationDays, logger } = options;
  const now = options.now ?? (() => new Date());
  let firstTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RotationResult | null> | undefined;

  async function check(): Promise<RotationResult | null> {
    const at = now();
    const result = await signingKeys.rotateIfOlderThan(rotationDays, at);
    if (result !== null) {
      logger.info(
        {
          previousKeyId: result.previousKeyId,
          keyId: result.current.id,
          previousKeyAgeDays:
            result.previousCreatedAt === null
              ? null
              : Math.floor((at.getTime() - result.previousCreatedAt.getTime()) / DAY_MS),
          rotationDays,
        },
        'signing key rotated: the previous key was older than SIGNING_KEY_ROTATION_DAYS',
      );
    }
    return result;
  }

  /** One check. Overlapping calls in this process share it. */
  function runOnce(): Promise<RotationResult | null> {
    running ??= check().finally(() => {
      running = undefined;
    });
    return running;
  }

  function runLogged(): void {
    runOnce().catch((error: unknown) => {
      logger.error(
        { err: error instanceof Error ? error.message : String(error) },
        'signing key rotation check failed; will retry on the next one',
      );
    });
  }

  return {
    runOnce,

    start(
      intervalMs = SIGNING_KEY_CHECK_INTERVAL_MS,
      firstDelayMs = SIGNING_KEY_FIRST_CHECK_DELAY_MS,
    ): void {
      firstTimer = setTimeout(runLogged, firstDelayMs);
      firstTimer.unref();
      timer = setInterval(runLogged, intervalMs);
      timer.unref();
    },

    /** Stops the timers and waits for a check in progress, so shutdown can close the pool after. */
    async stop(): Promise<void> {
      if (firstTimer !== undefined) clearTimeout(firstTimer);
      if (timer !== undefined) clearInterval(timer);
      firstTimer = undefined;
      timer = undefined;
      await running?.catch(() => undefined);
    },
  };
}

export type SigningKeyRotator = ReturnType<typeof createSigningKeyRotator>;

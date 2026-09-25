import type { Logger } from '@cuc/logger';

import type { RotationStep, SigningKeyRepo } from './repo/signing-key.repo.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

/**
 * How often the rotation is checked. Short enough that a staged key is
 * promoted within a few minutes of its publish-ahead period ending; each
 * check is one small transaction.
 */
export const SIGNING_KEY_CHECK_INTERVAL_MS = 5 * MINUTE_MS;
/** The first check, shortly after startup rather than a full interval into it. */
export const SIGNING_KEY_FIRST_CHECK_DELAY_MS = 30 * 1000;

export interface SigningKeyRotatorOptions {
  readonly signingKeys: Pick<SigningKeyRepo, 'advance'>;
  /**
   * `SIGNING_KEY_ROTATION_DAYS`. At 0 no key is staged automatically, but a
   * key staged by the operator command is still promoted on time.
   */
  readonly rotationDays: number;
  /** `SIGNING_KEY_PUBLISH_AHEAD_MINUTES`. */
  readonly publishAheadMinutes: number;
  readonly logger: Logger;
  /** Injected so tests drive time; production leaves it out. */
  readonly now?: () => Date;
}

/**
 * Automatic, publish-ahead signing-key rotation (G-116, 07 §2). Every few
 * minutes:
 *
 * 1. When the current key is `SIGNING_KEY_ROTATION_DAYS` old and no next key
 *    exists, a next key is *staged*: published in the JWKS, not yet signing.
 * 2. When a staged key has been published for
 *    `SIGNING_KEY_PUBLISH_AHEAD_MINUTES`, it is *promoted*: it signs from then
 *    on, and the previous key is retired but stays published for
 *    `SIGNING_KEY_OVERLAP_DAYS`.
 *
 * With the publish-ahead period longer than api-gateway's
 * `JWKS_CACHE_MAX_AGE_MS`, every gateway has refetched the JWKS, and so holds
 * the new key, before the first token it signs arrives.
 *
 * Every copy of identity-service runs this. Each step runs on locked rows in
 * one transaction (`advance`), so the copies stage and promote exactly once
 * between them, and `current()` keeps returning the old key until promotion.
 */
export function createSigningKeyRotator(options: SigningKeyRotatorOptions) {
  const { signingKeys, rotationDays, publishAheadMinutes, logger } = options;
  const now = options.now ?? (() => new Date());
  let firstTimer: NodeJS.Timeout | undefined;
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<RotationStep> | undefined;

  async function check(): Promise<RotationStep> {
    const at = now();
    const step = await signingKeys.advance({
      stage: rotationDays > 0 ? rotationDays : 'never',
      publishAheadMinutes,
      now: at,
    });
    if (step.action === 'staged') {
      logger.info(
        {
          currentKeyId: step.currentKeyId,
          nextKeyId: step.next.id,
          promotesAfter: new Date(
            step.next.publishedAt.getTime() + publishAheadMinutes * MINUTE_MS,
          ),
          rotationDays,
        },
        'signing key staged: the next key is published and will sign after the publish-ahead period',
      );
    } else if (step.action === 'promoted') {
      logger.info(
        {
          previousKeyId: step.previousKeyId,
          keyId: step.currentKeyId,
          previousKeyAgeDays: Math.floor(
            (at.getTime() - step.previousCreatedAt.getTime()) / DAY_MS,
          ),
        },
        'signing key rotated: the next key now signs; the previous one stays published for the overlap',
      );
    }
    return step;
  }

  /** One check. Overlapping calls in this process share it. */
  function runOnce(): Promise<RotationStep> {
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

import type { Logger } from '@cuc/logger';
import type { Storage } from '@cuc/storage';

import type { Engine } from './domain/transcription.js';
import type { MessageRepo } from './repo/message.repo.js';
import type { TranscriptionProvider } from './transcription/provider.js';

export interface TranscriberOptions {
  readonly messages: MessageRepo;
  readonly storage: Storage;
  /** The engines the operator configured, by name. */
  readonly engines: ReadonlyMap<Engine, TranscriptionProvider>;
  readonly logger: Logger;
  /** Injected so tests drive time; production passes `() => new Date()`. */
  readonly now: () => Date;
  /** A message taken this long ago and never finished (its transcriber died) is taken again. */
  readonly staleAfterMs?: number;
  /** How many times a message is tried before it is marked failed. */
  readonly maxAttempts?: number;
}

/** Background context: no actor, so no tenant. */
const JOB_CONTEXT = {};

/**
 * S5-06 (O-3): the transcriber. A message becomes `pending` when it is ready and its tenant or
 * mailbox asked for transcription (`MessageRepo.complete`); this takes pending messages one at a
 * time, reads the audio from the tenant's storage, sends it to the engine named for it, and
 * stores the text. Kept apart from the upload and from event handling, because an engine may
 * take many seconds. Several replicas may run it: each message is taken by one
 * (`claimTranscription`).
 *
 * A failure is tried again, up to `maxAttempts`, then the message is marked `failed`; the
 * voicemail itself is unaffected. The audio and the text are private-class data: the log names
 * the message and the engine, never either.
 */
export function createTranscriber(options: TranscriberOptions) {
  const { messages, storage, engines, logger } = options;
  const staleAfterMs = options.staleAfterMs ?? 10 * 60 * 1000;
  const maxAttempts = options.maxAttempts ?? 3;
  let timer: NodeJS.Timeout | undefined;
  let running = false;

  /** Transcribes one waiting message. Resolves true when there was one. */
  async function runOnce(): Promise<boolean> {
    const now = options.now();
    const job = await messages.claimTranscription(
      JOB_CONTEXT,
      now,
      new Date(now.getTime() - staleAfterMs),
    );
    if (job === undefined) return false;
    const ctx = { tenantId: job.tenantId };
    const provider = engines.get(job.engine);
    if (provider === undefined) {
      // The engine was configured when the message arrived and is not now.
      await messages.finishTranscription(ctx, job.id, null);
      logger.warn({ messageId: job.id, engine: job.engine }, 'transcription engine gone');
      return true;
    }
    try {
      const audio = await storage.forTenant(job.tenantId).getObject(job.objectKey);
      const text = await provider.transcribe(audio);
      await messages.finishTranscription(ctx, job.id, text);
      logger.info({ messageId: job.id, engine: job.engine }, 'voicemail transcribed');
    } catch (error) {
      const retry = job.attempts < maxAttempts;
      await messages.finishTranscription(ctx, job.id, null, retry);
      logger.warn(
        {
          messageId: job.id,
          engine: job.engine,
          attempt: job.attempts,
          retry,
          err: error instanceof Error ? error.message : String(error),
        },
        'voicemail transcription failed',
      );
    }
    return true;
  }

  /** Every waiting message, one after another. */
  async function drain(): Promise<number> {
    let done = 0;
    while (await runOnce()) done += 1;
    return done;
  }

  return {
    runOnce,
    drain,

    start(intervalMs: number): void {
      timer = setInterval(() => {
        if (running) return;
        running = true;
        drain()
          .catch((error: unknown) => {
            logger.error(
              { err: error instanceof Error ? error.message : String(error) },
              'transcriber: failed',
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

export type Transcriber = ReturnType<typeof createTranscriber>;

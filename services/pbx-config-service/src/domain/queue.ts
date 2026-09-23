import { DESTINATION_TYPES, type DestinationType } from './dids.js';

/**
 * Pure business logic for queues (S2-13; 05 §3.3; `mod_callcenter`). No DB
 * here — `repo/queue.repo.ts` is where this meets actual rows.
 */

/**
 * `mod_callcenter`'s own `strategy` param values (developer.signalwire.com/
 * freeswitch's mod_callcenter docs) — not this codebase's invention, but
 * also not verified against a real FreeSWITCH process (docs/decisions.md,
 * same "no live FS process reachable" caveat G-35/G-36/G-41/G-43 already
 * flag for other FS-facing surfaces this codebase has built).
 */
export const QUEUE_STRATEGIES = [
  'ring-all',
  'longest-idle-agent',
  'round-robin',
  'top-down',
  'agent-with-least-talk-time',
  'agent-with-fewest-calls',
  'sequentially-by-agent-order',
  'random',
] as const;
export type QueueStrategy = (typeof QUEUE_STRATEGIES)[number];

const MAX_LABEL_LENGTH = 255;
const MIN_WAIT_SECONDS = 0;
const MAX_WAIT_SECONDS = 24 * 60 * 60;
const MIN_ANNOUNCE_FREQUENCY_SECONDS = 10;
const MAX_ANNOUNCE_FREQUENCY_SECONDS = 600;

export class InvalidQueueError extends Error {
  override readonly name = 'InvalidQueueError';
}

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidQueueError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

export function validateStrategy(strategy: string): QueueStrategy {
  if (!(QUEUE_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new InvalidQueueError(
      `strategy must be one of: ${QUEUE_STRATEGIES.join(', ')} (got '${strategy}').`,
    );
  }
  return strategy as QueueStrategy;
}

/** 0 means unlimited (`mod_callcenter`'s own `max-wait-time` convention) — not validated as "must be positive". */
export function validateMaxWaitSeconds(seconds: number): number {
  if (!Number.isInteger(seconds) || seconds < MIN_WAIT_SECONDS || seconds > MAX_WAIT_SECONDS) {
    throw new InvalidQueueError(
      `max_wait_seconds must be an integer between ${String(MIN_WAIT_SECONDS)} and ${String(MAX_WAIT_SECONDS)}.`,
    );
  }
  return seconds;
}

/**
 * `announcePosition` and `announceFrequencySeconds` travel together: a
 * frequency with position announcements off is a config nobody asked for
 * and would silently do nothing, and announcements on with no frequency has
 * no interval to announce at. Same "both or neither" discipline `domain/
 * ring-group.ts`'s `validateNoAnswerDestination` already applies to its own
 * paired fields.
 */
export function validateAnnouncePosition(
  announcePosition: boolean,
  announceFrequencySeconds: number | null | undefined,
): number | null {
  if (!announcePosition) {
    if (announceFrequencySeconds !== null && announceFrequencySeconds !== undefined) {
      throw new InvalidQueueError(
        'announce_frequency_seconds was given without announce_position being true.',
      );
    }
    return null;
  }
  if (announceFrequencySeconds === null || announceFrequencySeconds === undefined) {
    throw new InvalidQueueError(
      'announce_position is true but announce_frequency_seconds was not given.',
    );
  }
  if (
    !Number.isInteger(announceFrequencySeconds) ||
    announceFrequencySeconds < MIN_ANNOUNCE_FREQUENCY_SECONDS ||
    announceFrequencySeconds > MAX_ANNOUNCE_FREQUENCY_SECONDS
  ) {
    throw new InvalidQueueError(
      `announce_frequency_seconds must be an integer between ${String(MIN_ANNOUNCE_FREQUENCY_SECONDS)} and ${String(MAX_ANNOUNCE_FREQUENCY_SECONDS)}.`,
    );
  }
  return announceFrequencySeconds;
}

/** Same shape and reasoning as `domain/ring-group.ts`'s `validateNoAnswerDestination` — reused here rather than duplicated, since both are "an optional DID-shaped fallback destination". */
export function validateNoAgentDestination(
  type: string | null | undefined,
  id: string | null | undefined,
): { type: DestinationType; id: string } | null {
  if (type === null || type === undefined) {
    if (id !== null && id !== undefined) {
      throw new InvalidQueueError(
        'no_agent_destination_id was given without no_agent_destination_type.',
      );
    }
    return null;
  }
  if (id === null || id === undefined || id.trim().length === 0) {
    throw new InvalidQueueError(
      'no_agent_destination_type was given without no_agent_destination_id.',
    );
  }
  if (!(DESTINATION_TYPES as readonly string[]).includes(type)) {
    throw new InvalidQueueError(
      `no_agent_destination_type must be one of: ${DESTINATION_TYPES.join(', ')} (got '${type}').`,
    );
  }
  return { type: type as DestinationType, id };
}

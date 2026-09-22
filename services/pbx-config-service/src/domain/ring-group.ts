import { DESTINATION_TYPES, type DestinationType } from './dids.js';

/**
 * Pure business logic for ring/hunt groups (S2-08; 05 §3.3). No DB here —
 * `repo/ring-group.repo.ts` is where this meets actual rows.
 */

export const RING_STRATEGIES = ['simultaneous', 'sequential', 'round_robin', 'random'] as const;
export type RingStrategy = (typeof RING_STRATEGIES)[number];

/** The round-robin counter lives in Redis, on the node that actually dials (telephony-config's `/fs/dialplan`), not here — this service only stores which strategy is configured. */
const MIN_RING_TIMEOUT_SECONDS = 5;
const MAX_RING_TIMEOUT_SECONDS = 300;
const MAX_LABEL_LENGTH = 255;
const MIN_MEMBERS = 1;
const MAX_MEMBERS = 64;

export class InvalidRingGroupError extends Error {
  override readonly name = 'InvalidRingGroupError';
}

export function validateLabel(label: string): string {
  const trimmed = label.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_LABEL_LENGTH) {
    throw new InvalidRingGroupError(
      `label must be 1-${String(MAX_LABEL_LENGTH)} characters after trimming.`,
    );
  }
  return trimmed;
}

export function validateStrategy(strategy: string): RingStrategy {
  if (!(RING_STRATEGIES as readonly string[]).includes(strategy)) {
    throw new InvalidRingGroupError(
      `strategy must be one of: ${RING_STRATEGIES.join(', ')} (got '${strategy}').`,
    );
  }
  return strategy as RingStrategy;
}

/** Ring order is significant (sequential/round-robin/random all hunt through this same order) — duplicates would ring one member twice and never reach another. */
export function validateMemberExtensionIds(ids: readonly string[]): string[] {
  if (ids.length < MIN_MEMBERS || ids.length > MAX_MEMBERS) {
    throw new InvalidRingGroupError(
      `A ring group needs ${String(MIN_MEMBERS)}-${String(MAX_MEMBERS)} members (got ${String(ids.length)}).`,
    );
  }
  if (new Set(ids).size !== ids.length) {
    throw new InvalidRingGroupError('member_extension_ids must not contain duplicates.');
  }
  return [...ids];
}

export function validateRingTimeoutSeconds(seconds: number): number {
  if (
    !Number.isInteger(seconds) ||
    seconds < MIN_RING_TIMEOUT_SECONDS ||
    seconds > MAX_RING_TIMEOUT_SECONDS
  ) {
    throw new InvalidRingGroupError(
      `ring_timeout_seconds must be an integer between ${String(MIN_RING_TIMEOUT_SECONDS)} and ${String(MAX_RING_TIMEOUT_SECONDS)}.`,
    );
  }
  return seconds;
}

/**
 * The no-answer destination reuses the exact same `DestinationType` union a
 * DID's own destination does (`domain/dids.ts`) — a ring group can name any
 * of them at the data-model level, the same "honest miss at dial time, not a
 * rejected write" story G-25 already tells for DIDs. Only `extension`
 * resolves to a real fallback bridge today (`xml.ts`'s
 * `buildRingGroupDialplanDocument`); everything else is accepted here and
 * left for whichever later stage gives it an owning subsystem.
 */
export function validateNoAnswerDestination(
  type: string | null | undefined,
  id: string | null | undefined,
): { type: DestinationType; id: string } | null {
  if (type === null || type === undefined) {
    if (id !== null && id !== undefined) {
      throw new InvalidRingGroupError(
        'no_answer_destination_id was given without no_answer_destination_type.',
      );
    }
    return null;
  }
  if (id === null || id === undefined || id.trim().length === 0) {
    throw new InvalidRingGroupError(
      'no_answer_destination_type was given without no_answer_destination_id.',
    );
  }
  if (!(DESTINATION_TYPES as readonly string[]).includes(type)) {
    throw new InvalidRingGroupError(
      `no_answer_destination_type must be one of: ${DESTINATION_TYPES.join(', ')} (got '${type}').`,
    );
  }
  return { type: type as DestinationType, id };
}

/**
 * Pure business logic for agents and queue tiers (S2-13; 05 §3.3;
 * `mod_callcenter`). No DB here — `repo/agent.repo.ts` is where this meets
 * actual rows.
 */

const MIN_MAX_NO_ANSWER = 0;
const MAX_MAX_NO_ANSWER = 20;
const MIN_SECONDS = 0;
const MAX_WRAP_UP_SECONDS = 3600;
const MAX_REJECT_DELAY_SECONDS = 300;
const MIN_TIER_LEVEL = 1;
const MAX_TIER_LEVEL = 100;
const MIN_TIER_POSITION = 1;
const MAX_TIER_POSITION = 100;

export class InvalidAgentError extends Error {
  override readonly name = 'InvalidAgentError';
}

/** 0 means `mod_callcenter`'s own "no limit" convention for `max-no-answer`, not an invalid value. */
export function validateMaxNoAnswer(value: number): number {
  if (!Number.isInteger(value) || value < MIN_MAX_NO_ANSWER || value > MAX_MAX_NO_ANSWER) {
    throw new InvalidAgentError(
      `max_no_answer must be an integer between ${String(MIN_MAX_NO_ANSWER)} and ${String(MAX_MAX_NO_ANSWER)}.`,
    );
  }
  return value;
}

export function validateWrapUpSeconds(value: number): number {
  if (!Number.isInteger(value) || value < MIN_SECONDS || value > MAX_WRAP_UP_SECONDS) {
    throw new InvalidAgentError(
      `wrap_up_seconds must be an integer between ${String(MIN_SECONDS)} and ${String(MAX_WRAP_UP_SECONDS)}.`,
    );
  }
  return value;
}

export function validateRejectDelaySeconds(value: number): number {
  if (!Number.isInteger(value) || value < MIN_SECONDS || value > MAX_REJECT_DELAY_SECONDS) {
    throw new InvalidAgentError(
      `reject_delay_seconds must be an integer between ${String(MIN_SECONDS)} and ${String(MAX_REJECT_DELAY_SECONDS)}.`,
    );
  }
  return value;
}

/** Lower sorts first — mod_callcenter tries tier 1 before tier 2 only once tier 1 has no available agent (`tier-rules-apply`). */
export function validateTierLevel(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TIER_LEVEL || value > MAX_TIER_LEVEL) {
    throw new InvalidAgentError(
      `level must be an integer between ${String(MIN_TIER_LEVEL)} and ${String(MAX_TIER_LEVEL)}.`,
    );
  }
  return value;
}

/** Ordering within a tier level, for the strategies that care about agent order (`top-down`, `sequentially-by-agent-order`). */
export function validateTierPosition(value: number): number {
  if (!Number.isInteger(value) || value < MIN_TIER_POSITION || value > MAX_TIER_POSITION) {
    throw new InvalidAgentError(
      `position must be an integer between ${String(MIN_TIER_POSITION)} and ${String(MAX_TIER_POSITION)}.`,
    );
  }
  return value;
}

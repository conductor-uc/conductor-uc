/**
 * Pure business logic for {{entity}} (09 §1: domain code should be pure where
 * possible). No DB, no HTTP — those live in repo/ and routes/.
 */

const NAME_PATTERN = /^[\p{L}\p{N} .,'-]{1,128}$/u;

export class Invalid{{Entity}}NameError extends Error {
  override readonly name = 'Invalid{{Entity}}NameError';
}

/** Trims and validates a proposed name, throwing if it cannot be accepted. */
export function normalize{{Entity}}Name(input: string): string {
  const trimmed = input.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new Invalid{{Entity}}NameError(
      `'${input}' is not a valid name: 1-128 characters, letters, numbers, and . , ' - only.`,
    );
  }
  return trimmed;
}

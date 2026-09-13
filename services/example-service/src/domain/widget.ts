/**
 * Pure business logic for widget (09 §1: domain code should be pure where
 * possible). No DB, no HTTP — those live in repo/ and routes/.
 */

const NAME_PATTERN = /^[\p{L}\p{N} .,'-]{1,128}$/u;

export class InvalidWidgetNameError extends Error {
  override readonly name = 'InvalidWidgetNameError';
}

/** Trims and validates a proposed name, throwing if it cannot be accepted. */
export function normalizeWidgetName(input: string): string {
  const trimmed = input.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new InvalidWidgetNameError(
      `'${input}' is not a valid name: 1-128 characters, letters, numbers, and . , ' - only.`,
    );
  }
  return trimmed;
}

import type { FlowGraphInput } from '@cuc/callflow-ir';

/**
 * Pure business logic for flow (09 §1: domain code should be pure where
 * possible). No DB, no HTTP — those live in repo/ and routes/.
 */

const NAME_PATTERN = /^[\p{L}\p{N} .,'-]{1,128}$/u;

export class InvalidFlowNameError extends Error {
  override readonly name = 'InvalidFlowNameError';
}

/** Trims and validates a proposed name, throwing if it cannot be accepted. */
export function normalizeFlowName(input: string): string {
  const trimmed = input.trim();
  if (!NAME_PATTERN.test(trimmed)) {
    throw new InvalidFlowNameError(
      `'${input}' is not a valid name: 1-128 characters, letters, numbers, and . , ' - only.`,
    );
  }
  return trimmed;
}

/** A brand-new flow's starting draft: no nodes, no entry points — `:validate` will say so. */
export const EMPTY_DRAFT_GRAPH: FlowGraphInput = { entryPoints: {}, nodes: [], edges: [] };

/**
 * Pure business logic for outbound routes (S2-04; 05 §3.4: "`outbound_routes`
 * | `id`, `tenant_id`, `priority`, `pattern` (prefix or regex), `trunk_ids`
 * (ordered), `strip`, `prepend`"). No DB here — `repo/outbound-route.repo.ts`
 * is where this meets actual rows.
 *
 * `pattern` is a plain E.164 prefix, not a full regex: `drouting`'s own
 * `dr_rules.prefix` matching is a prefix trie, not a regex engine (confirmed
 * against a real OpenSIPs instance — its own startup log names the matching
 * structure a "prefix tree"), and this projection (`projection.ts`) writes
 * a route's pattern straight into that column. 05 §3.4's "prefix or regex"
 * wording is aspirational for a later stage; supporting real regex patterns
 * would mean routing outside `drouting` entirely. Flagged as a gap
 * (docs/decisions.md) rather than silently building a regex engine or
 * silently dropping the word from the doc.
 */

export class InvalidOutboundRouteError extends Error {
  override readonly name = 'InvalidOutboundRouteError';
}

// A prefix to match against an already-E.164-normalized dialed number:
// either empty (matches everything — the tenant's default/catch-all route)
// or a leading '+' followed by digits. Never a partial/interior fragment —
// `drouting`'s own prefix matching is always anchored at the start.
const PATTERN = /^(\+\d*)?$/;

export function validatePattern(pattern: string): string {
  const trimmed = pattern.trim();
  if (!PATTERN.test(trimmed)) {
    throw new InvalidOutboundRouteError(
      `'${pattern}' is not a valid outbound route pattern: an E.164 prefix (e.g. '+1', '+44') or empty for catch-all.`,
    );
  }
  return trimmed;
}

export function validatePriority(priority: number): number {
  if (!Number.isInteger(priority) || priority < 0) {
    throw new InvalidOutboundRouteError('priority must be a non-negative integer.');
  }
  return priority;
}

/** At least one trunk, no duplicates — order matters (failover sequence, 03 §2.1). */
export function validateTrunkIds(trunkIds: readonly string[]): string[] {
  if (trunkIds.length === 0) {
    throw new InvalidOutboundRouteError('At least one trunk is required.');
  }
  const seen = new Set<string>();
  for (const id of trunkIds) {
    if (seen.has(id)) {
      throw new InvalidOutboundRouteError(`Trunk '${id}' is listed more than once.`);
    }
    seen.add(id);
  }
  return [...trunkIds];
}

export function validateStrip(strip: number): number {
  if (!Number.isInteger(strip) || strip < 0) {
    throw new InvalidOutboundRouteError('strip must be a non-negative integer.');
  }
  return strip;
}

/** `null`/omitted means "prepend nothing" — distinct from the empty string only in intent, not behavior. */
export function validatePrepend(prepend: string | null | undefined): string | null {
  if (prepend === undefined || prepend === null || prepend === '') return null;
  return prepend;
}

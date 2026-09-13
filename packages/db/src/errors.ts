/**
 * True when `error` is a MariaDB duplicate-key violation
 * (`ER_DUP_ENTRY` / errno 1062 / SQLSTATE 23000) — a unique index or primary
 * key was violated.
 *
 * The intended use is turning a race into a normal outcome rather than a crash:
 * insert optimistically, and when this returns true, treat it as "someone else
 * just did this" rather than retrying or propagating a raw driver error.
 * `@cuc/events`'s consumer uses this to detect an event already recorded in
 * `consumed_events`; a repository enforcing a partial-unique invariant (a
 * single master org, for example) uses it the same way.
 *
 * The check walks `error.cause`, because Kysely wraps driver errors and the
 * driver's own code can be one level down.
 */
export function isDuplicateKeyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; errno?: unknown; cause?: unknown };

  if (candidate.code === 'ER_DUP_ENTRY' || candidate.errno === 1062) return true;
  return candidate.cause === undefined ? false : isDuplicateKeyError(candidate.cause);
}

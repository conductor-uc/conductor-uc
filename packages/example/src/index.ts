/**
 * Placeholder package that exists so the toolchain has something to lint,
 * typecheck, test, and build (S0-01). Replace or delete it once the real
 * `packages/*` libraries land in S0-02 onwards.
 */

/** Returns the workspace package name, used by the scaffold smoke test. */
export function packageName(): string {
  return '@cuc/example';
}

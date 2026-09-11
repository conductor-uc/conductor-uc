import { defineConfig } from 'vitest/config';

/**
 * Settings every workspace package's Vitest config extends.
 *
 * Turborepo runs each package's suite concurrently, so on a small CI runner the
 * whole workspace's test files compete for a handful of cores. Both settings
 * below exist to keep that predictable:
 *
 * - `isolate: false` reuses a worker across test files instead of spawning one
 *   per file. Spawn cost dominates here — the files are small — and no suite
 *   relies on a fresh module registry: tests construct their own server, logger,
 *   or config object rather than mutating a module-level singleton. A package
 *   that does need isolation should set `isolate: true` and say why.
 * - `testTimeout` is well above what any test needs on an idle machine, because
 *   the 5s default is a coin flip under that contention, and a flaky suite is
 *   worse than a slow one.
 */
export const sharedTestConfig = defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    isolate: false,
    testTimeout: 20_000,
  },
});

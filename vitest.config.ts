import { defineConfig, mergeConfig } from 'vitest/config';

import { sharedTestConfig } from './vitest.shared.js';

/**
 * Workspace-wide Vitest entry point: `pnpm vitest` from the repository root runs
 * every workspace package's suite in one process. In CI each package is run on
 * its own through `turbo run test`, so this config only aggregates projects.
 */
export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      projects: ['packages/*', 'services/*', 'tools/*', 'tests/*'],
    },
  }),
);

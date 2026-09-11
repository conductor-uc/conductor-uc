import { defineConfig } from 'vitest/config';

/**
 * Workspace-wide Vitest entry point: `pnpm vitest` from the repository root
 * runs every workspace package's suite. In CI each package is run on its own
 * through `turbo run test`, so this config only aggregates projects.
 */
export default defineConfig({
  test: {
    projects: ['packages/*', 'services/*', 'tools/*', 'tests/*'],
  },
});

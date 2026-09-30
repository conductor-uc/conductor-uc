import { defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

/**
 * S4-09: the capacity benchmark (`pnpm bench`), apart from the everyday SIP tests. It loads the
 * development stack's media nodes with many calls at once and samples their CPU, so it runs
 * alone and is never retried (a retry would average two different loads).
 */
export default defineConfig({
  test: {
    ...sharedTestConfig.test,
    name: '@cuc/tests-sip-bench',
    include: ['bench/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 400_000,
    hookTimeout: 400_000,
    retry: 0,
    globalSetup: ['./src/global-setup.ts'],
  },
});

import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/tests-e2e',
      // One journey against one stack of real processes; its steps depend on
      // each other and must run in order.
      fileParallelism: false,
      testTimeout: 60_000,
      hookTimeout: 180_000,
    },
  }),
);

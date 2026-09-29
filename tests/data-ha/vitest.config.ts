import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/tests-data-ha',
      // One data tier, failed over member by member; the steps depend on
      // each other and must run in order.
      fileParallelism: false,
      testTimeout: 180_000,
      hookTimeout: 180_000,
    },
  }),
);

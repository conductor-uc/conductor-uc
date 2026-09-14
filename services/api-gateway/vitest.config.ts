import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/api-gateway',
      // Rate-limit tests share Redis counters keyed by a per-suite prefix, but
      // still run against one server process — safest run serially.
      fileParallelism: false,
    },
  }),
);

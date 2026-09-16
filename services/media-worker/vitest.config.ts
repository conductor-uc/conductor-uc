import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/media-worker',
      // Suites share one JetStream server when TEST_NATS_URL points at one, and
      // streams are named after domains, so files must not run concurrently.
      fileParallelism: false,
      // Real ffmpeg subprocess runs comfortably exceed vitest's default 5s.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);

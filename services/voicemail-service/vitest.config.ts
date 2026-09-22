import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/voicemail-service',
      // Suites share one JetStream server when TEST_NATS_URL points at one, and
      // streams are named after domains, so files must not run concurrently.
      fileParallelism: false,
    },
  }),
);

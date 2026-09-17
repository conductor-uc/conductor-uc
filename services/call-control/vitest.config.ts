import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/call-control',
      // Suites share one JetStream server when TEST_NATS_URL points at one, and
      // streams are named after domains, so files must not run concurrently.
      // The ESL reconnect test also drives real TCP sockets against a fake
      // server on a loop, which is slower than a pure in-process test.
      fileParallelism: false,
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);

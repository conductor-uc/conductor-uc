import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/events',
      // These suites share one JetStream server whenever TEST_NATS_URL points at
      // one, and streams are named after domains — so two files running at once
      // both use `PBX`, and each one's `beforeEach` purge deletes the other's
      // messages. Running the files in sequence is what makes a shared server
      // safe; without TEST_NATS_URL each suite starts its own and this costs
      // nothing.
      fileParallelism: false,
    },
  }),
);

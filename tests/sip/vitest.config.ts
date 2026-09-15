import { mergeConfig, defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

export default mergeConfig(
  sharedTestConfig,
  defineConfig({
    test: {
      name: '@cuc/tests-sip',
      // Each scenario dials real registered endpoints and waits on real SIP
      // transaction timers; running two at once would have two SIPp
      // processes racing for the same registered AORs.
      fileParallelism: false,
      // A full register+call+bye round trip over real UDP with SIPp's own
      // transaction timers comfortably exceeds vitest's default 5s.
      testTimeout: 30000,
      hookTimeout: 30000,
    },
  }),
);

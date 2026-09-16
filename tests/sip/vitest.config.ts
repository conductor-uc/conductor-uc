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
      // transaction timers comfortably exceeds vitest's default 5s. Raised
      // from 30s (S2-06, docs/decisions.md G-34): `run-scenario.ts`'s own
      // internal container-log/-exit timeouts were widened to 25s/40s after
      // repeated CI flakiness, and a test with no per-test override (most of
      // them) must still have headroom past whichever of those it waits on,
      // not get cut off by this file's own limit first.
      testTimeout: 60000,
      hookTimeout: 60000,
    },
  }),
);

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
      // from 30s (S2-06, docs/decisions.md G-34), then from 60s (G-39):
      // `run-scenario.ts`'s own internal container-log/-exit timeouts were
      // widened to 45s/90s there, but this file's own limit was missed in
      // that same pass — 60s < 90s meant a test could get cut off by
      // *this* limit before its own internal wait ever reached its new
      // ceiling, which is exactly what happened live (scenarios.test.ts
      // failed with vitest's own "Test timed out in 60000ms", not a
      // waitForContainerExit error, right after G-39 shipped). A test with
      // no per-test override (most of them) must have headroom past
      // whichever of run-scenario.ts's own waits it depends on, not get
      // cut off by this file's own limit first.
      testTimeout: 120_000,
      hookTimeout: 120_000,
    },
  }),
);

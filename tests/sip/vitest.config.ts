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
      // G-34/G-39's flakiness, at a level no harness timeout can reach:
      // across four consecutive CI runs on the self-hosted runner, 11-13 of
      // these 13 tests passed every time but a *different* one failed each
      // run (emergency_calling on one, scenarios + toll_fraud on the next,
      // trunk_did_routing on another) — and the whole suite passes 13/13
      // locally against a real compose stack. The failures are real SIP
      // transactions not completing inside the SIPp scenarios' *own*
      // internal timers (a UAS waiting out its full 60s call timeout for a
      // BYE that never arrives), so widening this file's or
      // run-scenario.ts's timeouts cannot help: the deadline being missed
      // lives inside the scenario XML, not in the harness around it. Same
      // run also showed trunk_did_routing taking 53s where it takes ~24s
      // elsewhere — the runner's own load, not any one test.
      //
      // Retrying is safe here by construction: `startUas`/
      // `startBackgroundUas` force-remove any same-named container from a
      // prior attempt before starting (their own doc comments call this out
      // for exactly this "crashed prior run" case), and every test clears
      // the registrations it depends on before dialing.
      //
      // `src/setup.ts` is what makes a retry a real second chance rather
      // than a replay: it clears any FS channels a failed attempt left
      // behind, which is why the first cut of this `retry` alone did not
      // help (all three attempts failed identically — see that file).
      retry: 2,
      setupFiles: ['./src/setup.ts'],
    },
  }),
);

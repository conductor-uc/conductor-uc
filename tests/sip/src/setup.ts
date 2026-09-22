import { beforeEach } from 'vitest';

import { fsCli, sipInfraOrSkipReason } from './run-scenario.js';

/**
 * Hangs up every channel still up on the FreeSWITCH node before each test.
 *
 * Why this exists: a failing call test can leave FS holding channels that
 * were never torn down — confirmed live in CI, where `scenarios.test.ts`'s
 * own "completes a real call end to end" failed with its UAS waiting out a
 * full 60s call timer for a BYE that never arrived, and FS's log for that
 * same call showed *neither* leg ever reaching `Hangup`/`Session Ended`
 * (every passing call in the same run shows both). Those leftover channels
 * then outlive the test that created them.
 *
 * That is what made `retry` (vitest.config.ts) useless for exactly the
 * failure it was added for: attempt 1 fails and leaves the zombie channels
 * behind, so attempts 2 and 3 dial into an FS still holding the previous
 * attempt's state and fail identically — observed as `(retry x2)` with all
 * three attempts failing while every other test in the same file passed in
 * ~2.6s. Clearing first makes each attempt start from the same clean node
 * state the first one got, so a retry is a real second chance rather than a
 * replay of the same poisoned state.
 *
 * `hupall` is safe to run here: `fileParallelism: false` plus vitest's own
 * sequential execution within a file means no other scenario's call is in
 * flight at the moment a test begins. Tests that deliberately hold a call
 * open (toll-fraud's channel-limit case, emergency calling's) set it up and
 * assert on it *inside* one test, so this never cuts one short.
 *
 * Skipped entirely when the compose stack isn't up — the suite's own
 * `describe.skipIf(skipReason)` guards already no-op every test in that
 * case, and this must not be the thing that fails instead.
 */
const skipReason = await sipInfraOrSkipReason();

beforeEach(async () => {
  if (skipReason !== undefined) return;
  // Never fail a test on cleanup: a node that can't be reached here will
  // surface as the test's own failure a moment later, with far better
  // context than a hook error would give.
  await fsCli('hupall NORMAL_CLEARING').catch(() => undefined);
});

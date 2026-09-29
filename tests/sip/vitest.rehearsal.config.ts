import { defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

/**
 * S4-11: the deployment rehearsal (`infra/deploy/rehearsal/rehearse.sh test`), apart from the
 * everyday SIP tests. It runs against the rehearsal's servers, not the development stack, and
 * kills whole servers, so it is never retried.
 */
export default defineConfig({
  test: {
    ...sharedTestConfig.test,
    name: '@cuc/tests-sip-rehearsal',
    include: ['rehearsal/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 300_000,
    hookTimeout: 300_000,
    retry: 0,
  },
});

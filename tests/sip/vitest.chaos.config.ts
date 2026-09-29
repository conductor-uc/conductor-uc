import { defineConfig } from 'vitest/config';

import { sharedTestConfig } from '../../vitest.shared.js';

/**
 * S4-08: the chaos suite (`pnpm chaos`), apart from the everyday SIP tests. It needs the chaos
 * environment (`infra/compose/docker-compose.chaos.yml`), kills members of the running stack
 * one at a time, and is never retried: a retry would hide a slow failover.
 *
 * Not `mergeConfig` over the shared settings, as the other configs are: it concatenates arrays,
 * which added the everyday `test/**` files to this run (found in the first run).
 */
export default defineConfig({
  test: {
    ...sharedTestConfig.test,
    name: '@cuc/tests-sip-chaos',
    include: ['chaos/**/*.test.ts'],
    fileParallelism: false,
    testTimeout: 400_000,
    hookTimeout: 400_000,
    retry: 0,
    globalSetup: ['./src/global-setup.ts'],
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    name: '@cuc/example',
    include: ['test/**/*.test.ts'],
    environment: 'node',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/shared/**/*.test.ts', 'worker/**/*.test.ts', 'apps/web/src/**/*.test.ts'],
    testTimeout: 20000,
    hookTimeout: 30000,
    pool: 'forks',
  },
});

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 600000,
    hookTimeout: 60000,
    retry: 2,
    pool: 'forks',
    singleFork: true,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      thresholds: {
        lines: 70,
        functions: 70,
        branches: 55,
        statements: 70,
      },
    },
  },
});

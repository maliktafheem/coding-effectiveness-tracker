import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    testTimeout: 600000,
    hookTimeout: 60000,
    pool: 'forks',
    singleFork: true,
    coverage: {
      provider: 'v8',
      reporter: ['lcov', 'text'],
      thresholds: {
        lines: 70,
        functions: 70,
        // Branches: 60 reflects current full-suite coverage (~61%). Raised
        // from the temporary 55 after adding analytics/trends coverage.
        // src/scoring/config.ts and src/importers/*.ts remain the
        // largest drags; raising to 65 requires dedicated tests there.
        branches: 60,
        statements: 70,
      },
    },
  },
});

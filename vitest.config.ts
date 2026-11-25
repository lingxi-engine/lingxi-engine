import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts', 'src/memory/__tests__/**/*.test.ts'],
    environment: "node",
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary', 'lcov'],
      reportsDirectory: 'coverage',
      // Only TypeScript sources: src/ also hosts .py probes and Android .java
      // files which v8 coverage cannot parse (PARSE_ERROR).
      include: ['src/**/*.ts'],
      exclude: [
        'src/tests/**',
        'src/**/__tests__/**',
        'src/**/*.test.ts',
        'src/**/*.d.ts',
        'src/types/**',
      ],
      // Ratchet thresholds: set just below the CI-VERIFIED baseline.\n      // LESSON (fac8d45 red): raising these from a WINDOWS-local measurement\n      // (19.35/17.48/19.95/20.52) broke CI — Linux v8 coverage runs lower.\n      // Rule: only raise after reading the actual CI coverage output, never\n      // from a local number alone. Reverted to last CI-green floor 15/13/15/15.
      // Coverage may only go UP — lower these never, raise them as tests grow.
      thresholds: {
        statements: 15,
        branches: 13,
        functions: 15,
        lines: 15,
      },
    },
  },
});

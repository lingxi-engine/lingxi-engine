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
      // Ratchet thresholds: set just below the measured baseline.\n      // 2026-11-25 re-raised: measured 19.35/17.48/19.95/20.52 (stmt/br/fn/ln)\n      // after model-health tests (+15) landed; ~2pt margin for cross-platform v8.
      // Coverage may only go UP — lower these never, raise them as tests grow.
      thresholds: {
        statements: 17,
        branches: 15,
        functions: 17,
        lines: 17,
      },
    },
  },
});

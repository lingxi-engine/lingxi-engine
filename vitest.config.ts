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
      // Ratchet thresholds: set just below the measured baseline (v2.0.42).
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

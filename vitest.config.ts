import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts', 'src/memory/__tests__/**/*.test.ts'],
    environment: "node",
    testTimeout: 20000,
  },
});
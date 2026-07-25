import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      include: ['src/**'],
      // Generated code is asserted by the parity test, not by line coverage —
      // including it would inflate the number into meaninglessness.
      exclude: ['src/core/api/generated/**', '**/*.test.*'],
      thresholds: {
        lines: 85,
        functions: 85,
        branches: 75,
      },
    },
  },
})

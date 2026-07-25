import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'src/**/*.test.tsx', 'tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov'],
      // Only `src/core` is measured, and the number is a gate rather than decoration.
      //
      // The CLI, commands and TUI are verified by spawning the built binary — that is the only
      // way to assert exit codes, stream discipline and what actually reaches the wire. V8
      // coverage cannot see into a child process, so those files score near zero however
      // thoroughly they are tested: before this was scoped, the suite reported 47% while 1119
      // tests passed, and the declared 85% threshold was never run by `bun run test` at all.
      // A gate that cannot pass is not a gate.
      //
      // What guards the unmeasured layers instead: tests/parity.test.ts (153 operations ↔ 153
      // reachable commands), tests/contract/** and tests/e2e/** (the whole surface driven
      // through the real binary against a stub API).
      include: ['src/core/**'],
      // Generated code is asserted by the parity test, not by line coverage —
      // including it would inflate the number into meaninglessness.
      exclude: ['src/core/api/generated/**', '**/*.test.*'],
      // Set just under what the suite achieves today, so a real regression trips them and
      // ordinary refactoring does not.
      thresholds: {
        statements: 82,
        lines: 85,
        functions: 78,
        branches: 78,
      },
    },
  },
})

import { defineConfig } from "vitest/config";

/**
 * One configuration for every package. The worker count is capped at 3 (the
 * maintainer's machine runs other suites in parallel); VITEST_MAX_WORKERS,
 * VITEST_MAX_FORKS or VITEST_MAX_THREADS may lower it, never raise it.
 */
function workerCap(): number {
  const requested = [
    process.env.VITEST_MAX_WORKERS,
    process.env.VITEST_MAX_FORKS,
    process.env.VITEST_MAX_THREADS,
  ]
    .map((value) => Number.parseInt(value ?? "", 10))
    .filter((value) => Number.isInteger(value) && value > 0);
  return Math.min(3, ...requested);
}

export default defineConfig({
  test: {
    include: ["packages/*/test/**/*.test.ts", "scripts/test/**/*.test.ts"],
    pool: "threads",
    maxWorkers: workerCap(),
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // `pnpm test:coverage` (CI): 90 % lines for the engine and the protocol (design 10.7).
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/testing.ts", "packages/*/src/bin.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        "packages/engine/src/**": { lines: 90 },
        "packages/protocol/src/**": { lines: 90 },
      },
    },
  },
});

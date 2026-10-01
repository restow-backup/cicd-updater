import { defineConfig } from "vitest/config";

/**
 * The end-to-end suite (pnpm e2e): real Docker inside a Docker-in-Docker host
 * (e2e/lib/host.ts). Strictly sequential: one scenario file, one Compose project at a
 * time, each torn down before the next starts.
 */
export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ["scenarios/**/*.test.ts"],
    globalSetup: ["lib/global-setup.ts"],
    fileParallelism: false,
    maxWorkers: 1,
    pool: "forks",
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
    reporters: ["verbose"],
  },
});

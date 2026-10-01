import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Import boundaries (design 10.1). The sidecar holds the Docker socket, so
 * what it runs is kept to the repository and a short list of dependencies;
 * the protocol package runs in any runtime (no Node built-ins).
 */

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const ALLOWED: Record<string, RegExp[]> = {
  protocol: [/^zod$/],
  feed: [/^node:/, /^zod$/, /^@cicd-updater\/protocol$/],
  engine: [/^node:/, /^zod$/, /^@cicd-updater\/protocol$/],
  sidecar: [
    /^node:/,
    /^zod$/,
    /^hono(\/.*)?$/,
    /^@hono\/node-server(\/conninfo)?$/,
    /^yaml$/,
    /^@cicd-updater\/(protocol|feed|engine|release-tools)$/,
  ],
  "release-tools": [/^node:/, /^zod$/, /^yaml$/, /^@cicd-updater\/(protocol|feed)$/],
  sdk: [/^node:/, /^zod$/, /^react$/, /^@cicd-updater\/(protocol|feed)$/],
};

const IMPORT = /(?:\bfrom\s+|\bimport\s*\(\s*|\bimport\s+)["']([^"']+)["']/g;

async function sources(dir: string): Promise<string[]> {
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sources(full)));
    } else if (
      /\.tsx?$/.test(entry.name) &&
      !entry.name.endsWith(".test.ts") &&
      entry.name !== "testing.ts"
    ) {
      files.push(full);
    }
  }
  return files;
}

describe("package boundaries", () => {
  for (const [pkg, allowed] of Object.entries(ALLOWED)) {
    it(`${pkg} imports only its allowlist and its own files`, async () => {
      const files = await sources(path.join(ROOT, "packages", pkg, "src"));
      expect(files.length, pkg).toBeGreaterThan(0);
      for (const file of files) {
        const text = await fs.readFile(file, "utf8");
        for (const match of text.matchAll(IMPORT)) {
          const specifier = match[1] as string;
          if (specifier.startsWith("./") || specifier.startsWith("../")) {
            expect(
              specifier.startsWith("../../"),
              `${file} reaches out of its package: ${specifier}`,
            ).toBe(false);
            continue;
          }
          expect(
            allowed.some((pattern) => pattern.test(specifier)),
            `${path.relative(ROOT, file)} imports ${specifier}`,
          ).toBe(true);
        }
      }
    });
  }

  it("keeps Node built-ins out of the SDK's runtime-agnostic entry points", async () => {
    for (const entry of ["protocol.ts", "semver.ts", "messages.ts", "maintenance.ts", "react.ts"]) {
      const file = path.join(ROOT, "packages", "sdk", "src", entry);
      const text = await fs.readFile(file, "utf8").catch(() => null);
      if (text === null) continue;
      expect(text, entry).not.toMatch(/from ["']node:/);
    }
  });
});

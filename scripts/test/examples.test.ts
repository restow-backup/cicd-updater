import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { envCheck, parsePolicy } from "@cicd-updater/release-tools";
import { loadConfig } from "@cicd-updater/sidecar";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The shipped examples stay consistent with the contracts (design 10.7 `schemas`,
 * 11): every updater.yaml (production and demo) passes the sidecar's own loader,
 * every Compose variable is documented in .env.example, the release policies parse,
 * the managed services exist in the Compose file and take their image from their
 * image variable, and the sidecar service follows the normative example (2.6).
 */

const root = join(import.meta.dirname, "..", "..");
const examplesDir = join(root, "examples");
const examples = readdirSync(examplesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: unknown;
  labels?: Record<string, string>;
  volumes?: string[];
}

function compose(example: string): { services: Record<string, ComposeService> } {
  return parse(readFileSync(join(examplesDir, example, "docker-compose.yml"), "utf8"));
}

describe("examples", () => {
  it("are the three of the design", () => {
    expect(examples).toEqual(["node-postgres", "python-postgres", "static-site"]);
  });

  describe.each(examples)("%s", (example) => {
    const dir = join(examplesDir, example);

    it.each(["updater.yaml", "demo/updater.yaml"])(
      "%s passes the sidecar's loader",
      async (file) => {
        const loaded = await loadConfig(
          { CICD_UPDATER_COMPOSE__PROJECT_DIR: `/opt/${example}` },
          join(dir, file),
        );
        expect(loaded.ok ? [] : loaded.problems).toEqual([]);
      },
    );

    it("documents every Compose variable in .env.example", () => {
      const files = [
        "docker-compose.yml",
        "docker-compose.smoke.yml",
        "demo/docker-compose.demo.yml",
      ];
      const result = envCheck(
        files.map((file) => readFileSync(join(dir, file), "utf8")),
        readFileSync(join(dir, ".env.example"), "utf8"),
      );
      expect(result.missing).toEqual([]);
    });

    it("has a release policy that parses", () => {
      expect(() =>
        parsePolicy(readFileSync(join(dir, ".cicd-updater/release-policy.yaml"), "utf8")),
      ).not.toThrow();
    });

    it("manages services that exist and take their image from their variable", async () => {
      const loaded = await loadConfig(
        { CICD_UPDATER_COMPOSE__PROJECT_DIR: `/opt/${example}` },
        join(dir, "updater.yaml"),
      );
      if (!loaded.ok) {
        throw new Error("invalid configuration");
      }
      const { services } = compose(example);
      for (const service of loaded.config.services) {
        expect(services[service.name], service.name).toBeDefined();
        expect(services[service.name]?.image).toMatch(new RegExp(`^\\$\\{${service.imageVar}[:}]`));
      }
    });

    it("runs the sidecar opt-in, unpublished, labelled and with the same project path", () => {
      const updater = compose(example).services.updater;
      expect(updater?.profiles).toEqual(["updater"]);
      expect(updater?.ports).toBeUndefined();
      expect(updater?.labels?.["io.github.restow-backup.cicd-updater.role"]).toBe("sidecar");
      expect(updater?.image).not.toMatch(/APP_IMAGE|WEB_IMAGE/);
      expect(updater?.volumes).toContain("/var/run/docker.sock:/var/run/docker.sock");
      expect(
        updater?.volumes?.some((volume) => /^\$\{PROJECT_DIR[^}]*\}:\$\{PROJECT_DIR/.test(volume)),
      ).toBe(true);
    });
  });
});

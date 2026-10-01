import { readFileSync } from "node:fs";
import { join } from "node:path";
import { envCheck, parsePolicy } from "@cicd-updater/release-tools";
import { loadConfig } from "@cicd-updater/sidecar";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

/**
 * The web app template stays consistent with the contracts, like the examples
 * (examples.test.ts): its updater.yaml passes the sidecar's own loader, every Compose
 * variable is documented in its .env.example, the release policy parses, and the sidecar
 * service of the Compose fragment follows the normative example. Its TypeScript and
 * JavaScript files are type-checked against the SDK sources (templates/tsconfig.json).
 */

const dir = join(import.meta.dirname, "..", "..", "templates", "web-app");
const read = (file: string) => readFileSync(join(dir, file), "utf8");

interface ComposeService {
  image?: string;
  profiles?: string[];
  ports?: unknown;
  labels?: Record<string, string>;
  volumes?: string[];
  networks?: string[];
  healthcheck?: { test?: string[] };
}

const fragment = parse(read("compose/docker-compose.updater.yml")) as {
  services: Record<string, ComposeService>;
  volumes: Record<string, unknown>;
};

describe("templates/web-app", () => {
  it("updater.yaml passes the sidecar's loader", async () => {
    const loaded = await loadConfig(
      { CICD_UPDATER_COMPOSE__PROJECT_DIR: "/opt/myapp" },
      join(dir, "updater.yaml"),
    );
    expect(loaded.ok ? [] : loaded.problems).toEqual([]);
  });

  it("documents every Compose variable in .env.example", () => {
    const result = envCheck(
      [read("compose/docker-compose.updater.yml"), read("compose/docker-compose.smoke.yml")],
      read(".env.example"),
    );
    expect(result.missing).toEqual([]);
  });

  it("has a release policy that parses", () => {
    expect(() => parsePolicy(read("release/release-policy.yaml"))).not.toThrow();
  });

  it("runs the sidecar opt-in, unpublished, labelled, checked and with the same project path", () => {
    const updater = fragment.services.updater;
    expect(updater?.profiles).toEqual(["updater"]);
    expect(updater?.ports).toBeUndefined();
    expect(updater?.labels?.["io.github.restow-backup.cicd-updater.role"]).toBe("sidecar");
    expect(updater?.image).toMatch(/^\$\{CICD_UPDATER_IMAGE[:}]/);
    expect(updater?.healthcheck?.test).toEqual(["CMD", "cicd-updater", "healthcheck"]);
    expect(updater?.volumes).toEqual(
      expect.arrayContaining([
        "/var/run/docker.sock:/var/run/docker.sock",
        "updater-state:/state",
        "updater-shared:/shared",
        "updater-verify:/verify",
      ]),
    );
    expect(
      updater?.volumes?.some((volume) => /^\$\{PROJECT_DIR[^}]*\}:\$\{PROJECT_DIR/.test(volume)),
    ).toBe(true);
    expect(Object.keys(fragment.volumes).sort()).toEqual([
      "updater-shared",
      "updater-state",
      "updater-verify",
    ]);
  });

  it("mounts the token read-only into the managed backend only", async () => {
    const loaded = await loadConfig(
      { CICD_UPDATER_COMPOSE__PROJECT_DIR: "/opt/myapp" },
      join(dir, "updater.yaml"),
    );
    if (!loaded.ok) {
      throw new Error("invalid configuration");
    }
    const readers = Object.entries(fragment.services).filter(([name, service]) =>
      name === "updater" ? false : service.volumes?.some((v) => v.startsWith("updater-shared:")),
    );
    expect(readers.map(([name]) => name)).toEqual([loaded.config.services[0]?.name]);
    expect(readers[0]?.[1].volumes).toContain("updater-shared:/run/cicd-updater:ro");
  });
});

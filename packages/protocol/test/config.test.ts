import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  applyEnvOverrides,
  canonicalJson,
  envNameOf,
  overridableKeys,
  startGroups,
  toUpperSnake,
  validateConfig,
  writableKeys,
} from "../src/index.js";

const example = parse(
  readFileSync(new URL("./fixtures/updater.yaml", import.meta.url), "utf8"),
) as Record<string, unknown>;

/** A small valid configuration to vary. */
function base(): Record<string, unknown> {
  return {
    version: 1,
    compose: { projectDir: "/opt/notes" },
    release: { feed: { type: "github", url: "https://github.com/acme/notes" } },
    trust: {
      mode: "keyless",
      keyless: { github: { repository: "acme/notes", workflow: ".github/workflows/release.yml" } },
    },
    services: [{ name: "api", image: "app", imageVar: "APP_IMAGE" }],
  };
}

function problemsOf(input: unknown): string[] {
  const result = validateConfig(input);
  return result.ok ? [] : result.problems.map((problem) => `${problem.path}: ${problem.message}`);
}

function with_(change: (config: Record<string, any>) => void): Record<string, unknown> {
  const config = base() as Record<string, any>;
  change(config);
  return config;
}

describe("updater.yaml", () => {
  it("accepts the complete example of the design and fills the defaults", () => {
    const result = validateConfig(example);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    if (!result.ok) return;
    const config = result.config;
    expect(config.server).toEqual({ listen: "0.0.0.0:8090", allowPublishedPort: false });
    expect(config.auth.sharedDir).toBe("/shared");
    expect(config.state).toEqual({ dir: "/state", historyLimit: 20, eventLimit: 500 });
    expect(config.trust.verifier).toEqual({
      isolate: true,
      workDir: "/verify",
      timeoutSeconds: 300,
    });
    expect(config.services[2]).toMatchObject({
      name: "web",
      startOrder: 3,
      stopBeforeUpdate: false,
      stopOnAttention: true,
      optional: false,
    });
    expect(config.hooks.backup).toMatchObject({
      type: "postgres",
      lockWaitSeconds: 120,
      retention: { keep: 3, maxAgeDays: 14 },
    });
    expect(config.hooks.migrationProbe).toMatchObject({
      preset: "node-pg-migrate",
      fingerprint: true,
    });
    expect(config.hooks.health.http).toMatchObject({
      sendToken: true,
      expectStatus: [200],
      versionJsonPath: "$.version",
    });
    expect(config.hooks.smoke.checks[0]).toEqual({
      type: "http",
      url: "http://web:8080/",
      expectStatus: [200],
      bodyContains: null,
      sendToken: false,
    });
    expect(config.rollback.policy).toBe("probe");
    expect(config.schedule).toEqual({ maxLeadSeconds: 1_209_600, lateStartToleranceSeconds: 600 });
    expect(writableKeys(config)).toEqual(["APP_IMAGE", "WEB_IMAGE"]);
    expect(
      startGroups(config).map((group) => [group.group, group.services.map((s) => s.name)]),
    ).toEqual([
      [1, ["api"]],
      [2, ["worker"]],
      [3, ["web"]],
    ]);
  });

  it("rejects unknown keys everywhere (typos must not disable safety settings)", () => {
    expect(problemsOf({ ...base(), rollbak: { policy: "always" } })).toEqual([
      "(root): unknown key: rollbak",
    ]);
    expect(
      problemsOf(
        with_((c) => {
          c.services[0].stopBeforeUpdte = false;
        }),
      ),
    ).toEqual(["services.0: unknown key: stopBeforeUpdte"]);
    expect(
      problemsOf(
        with_((c) => {
          c.trust.verifier = { isolated: false };
        }),
      ),
    ).toEqual(["trust.verifier: unknown key: isolated"]);
  });

  it("collects all problems at once with their paths", () => {
    const problems = problemsOf({
      version: 2,
      compose: { projectDir: "relative/dir" },
      release: { feed: { type: "github", url: "http://github.com/a/b" } },
      services: [],
    });
    expect(problems.length).toBeGreaterThanOrEqual(4);
    expect(problems.some((p) => p.startsWith("version:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("compose.projectDir:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("release.feed.url:"))).toBe(true);
    expect(problems.some((p) => p.startsWith("services:"))).toBe(true);
  });

  describe("trust modes", () => {
    it("defaults to keyless and refuses to start without an identity", () => {
      const problems = problemsOf(
        with_((c) => {
          delete c.trust;
        }),
      );
      expect(problems).toEqual([
        "trust.keyless: keyless mode needs exactly one of github, gitlab or issuer + identityTemplate (docs/trust-modes.md)",
      ]);
    });

    it("accepts each keyless form and refuses two at once", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.trust.keyless = { gitlab: { project: "group/sub/notes" } };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.keyless = {
              issuer: "https://issuer.example.com",
              identityTemplate: "https://ci.example.com/notes@{tag}",
            };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.keyless.gitlab = { project: "g/p" };
          }),
        ),
      ).toEqual(["trust.keyless: set exactly one identity form, found github and gitlab"]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.keyless = { issuer: "https://issuer.example.com" };
          }),
        ),
      ).toEqual(["trust.keyless: the generic form needs both issuer and identityTemplate"]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.keyless = {
              issuer: "https://i.example.com",
              identityTemplate: "https://ci.example.com/notes@.*",
            };
          }),
        ),
      ).toEqual(["trust.keyless.identityTemplate: must contain {tag}"]);
    });

    it("key mode needs 1 to 5 public keys and refuses keyless settings", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "key", key: { publicKeyFiles: ["/keys/cosign.pub"] } };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "key" };
          }),
        ),
      ).toEqual(["trust.key.publicKeyFiles: key mode needs 1 to 5 public key files"]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.mode = "key";
            c.trust.key = { publicKeyFiles: ["/k.pub"] };
          }),
        ),
      ).toEqual(["trust.keyless: is a setting of keyless mode; the mode is key"]);
      const six = Array.from({ length: 6 }, (_, i) => `/keys/${i}.pub`);
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "key", key: { publicKeyFiles: six } };
          }),
        )[0],
      ).toMatch(/^trust\.key\.publicKeyFiles:/);
    });

    it("none mode must be acknowledged and never falls back silently", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "none" };
          }),
        ),
      ).toEqual([
        "trust.none.acknowledgeUnsigned: must be true with mode none: signatures are then not checked (docs/trust-modes.md)",
      ]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "none", none: { acknowledgeUnsigned: false } };
          }),
        ),
      ).toHaveLength(1);
      expect(
        problemsOf(
          with_((c) => {
            c.trust = { mode: "none", none: { acknowledgeUnsigned: true } };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.trust.none = { acknowledgeUnsigned: true };
          }),
        ),
      ).toEqual(["trust.none: is a setting of none mode; the mode is keyless"]);
    });
  });

  describe("services and keys", () => {
    it("refuses duplicate services, the sidecar itself and keys shared across images", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.services.push({ name: "api", image: "app", imageVar: "APP_IMAGE" });
          }),
        ),
      ).toEqual(["services.1.name: service api is listed twice"]);
      expect(
        problemsOf(
          with_((c) => {
            c.self = { service: "api" };
          }),
        ),
      ).toEqual(["services.0.name: the sidecar's own service cannot be managed"]);
      expect(
        problemsOf(
          with_((c) => {
            c.services.push({ name: "web", image: "web", imageVar: "APP_IMAGE" });
          }),
        ),
      ).toEqual([
        "services.1.imageVar: APP_IMAGE is shared with a service of image app; services share a key only with the same image",
      ]);
      expect(
        problemsOf(
          with_((c) => {
            c.env = { versionVar: "APP_IMAGE" };
          }),
        ),
      ).toEqual(["env.versionVar: must differ from every services[].imageVar"]);
    });

    it("validates names and variables", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.services[0].imageVar = "app_image";
          }),
        )[0],
      ).toMatch(/^services\.0\.imageVar/);
      expect(
        problemsOf(
          with_((c) => {
            c.services[0].name = "-api";
          }),
        )[0],
      ).toMatch(/^services\.0\.name/);
      expect(
        problemsOf(
          with_((c) => {
            c.services[0].startOrder = 10;
          }),
        )[0],
      ).toMatch(/^services\.0\.startOrder/);
    });

    it("lists the writable keys: every imageVar plus versionVar", () => {
      const result = validateConfig(
        with_((c) => {
          c.services.push({ name: "worker", image: "app", imageVar: "APP_IMAGE", startOrder: 2 });
          c.env = { versionVar: "APP_VERSION" };
        }),
      );
      expect(result.ok && writableKeys(result.config)).toEqual(["APP_IMAGE", "APP_VERSION"]);
    });
  });

  describe("hooks", () => {
    it("requires the service of a database backup and refuses settings of other types", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "postgres" } };
          }),
        ),
      ).toEqual(["hooks.backup.service: is required with backup type postgres"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "volume", volumes: ["data"], service: "db" } };
          }),
        ),
      ).toEqual(["hooks.backup.service: is not used with backup type volume"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "volume" } };
          }),
        ),
      ).toEqual(["hooks.backup.volumes: lists 1 to 16 volumes with backup type volume"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "postgres", service: "db", flavor: "mariadb" } };
          }),
        ),
      ).toEqual(["hooks.backup.flavor: is used only with backup type mysql"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "command" } };
          }),
        ),
      ).toEqual(["hooks.backup.command: is required with backup type command"]);
    });

    it("forces quiesce for volume backups", () => {
      const result = validateConfig(
        with_((c) => {
          c.hooks = { backup: { type: "volume", volumes: ["data"] } };
        }),
      );
      expect(result.ok && result.config.hooks.backup.quiesce).toBe(true);
    });

    it("pins the image of a command backup by digest and validates age recipients", () => {
      const command = { image: "ghcr.io/acme/backup:1", argv: ["dump"] };
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "command", command } };
          }),
        )[0],
      ).toMatch(/^hooks\.backup\.command\.image/);
      const pinned = { ...command, image: `ghcr.io/acme/backup:1@sha256:${"a".repeat(64)}` };
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { backup: { type: "command", command: pinned } };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              backup: {
                type: "postgres",
                service: "db",
                encryption: { ageRecipients: ["ssh-ed25519 AAAA"] },
              },
            };
          }),
        )[0],
      ).toMatch(/^hooks\.backup\.encryption\.ageRecipients\.0/);
    });

    it("needs exactly one of preset and query for database probes", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { migrationProbe: { type: "postgres", service: "db" } };
          }),
        ),
      ).toEqual(["hooks.migrationProbe: set exactly one of preset or query"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              migrationProbe: {
                type: "postgres",
                service: "db",
                preset: "drizzle",
                query: "SELECT 1",
              },
            };
          }),
        ),
      ).toEqual(["hooks.migrationProbe: set exactly one of preset or query"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              migrationProbe: { type: "postgres", service: "db", query: "DELETE FROM x" },
            };
          }),
        ),
      ).toEqual(["hooks.migrationProbe.query: must be one SELECT statement"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              migrationProbe: { type: "postgres", service: "db", query: "SELECT 1; DROP TABLE x" },
            };
          }),
        ),
      ).toEqual(["hooks.migrationProbe.query: must be one SELECT statement"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              migrationProbe: { type: "mysql", service: "db", preset: "node-pg-migrate" },
            };
          }),
        ),
      ).toEqual(["hooks.migrationProbe.preset: preset node-pg-migrate has no mysql query"]);
    });

    it("derives the rollback policy from the probe and refuses probe without one", () => {
      const withoutProbe = validateConfig(base());
      expect(withoutProbe.ok && withoutProbe.config.rollback.policy).toBe("never");
      const withProbe = validateConfig(
        with_((c) => {
          c.hooks = { migrationProbe: { type: "postgres", service: "db", preset: "prisma" } };
        }),
      );
      expect(withProbe.ok && withProbe.config.rollback.policy).toBe("probe");
      expect(
        problemsOf(
          with_((c) => {
            c.rollback = { policy: "probe" };
          }),
        ),
      ).toEqual(["rollback.policy: probe needs hooks.migrationProbe"]);
      const always = validateConfig(
        with_((c) => {
          c.rollback = { policy: "always" };
        }),
      );
      expect(always.ok && always.config.rollback.policy).toBe("always");
    });

    it("checks health settings against the type and the start groups", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { health: { type: "http" } };
          }),
        ),
      ).toEqual(["hooks.health.http: is required with health type http"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = {
              health: {
                type: "http",
                http: { url: "http://api:3000/healthz", versionJsonPath: "version" },
              },
            };
          }),
        )[0],
      ).toMatch(/^hooks\.health\.http\.versionJsonPath/);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { health: { afterGroup: 2 } };
          }),
        ),
      ).toEqual(["hooks.health.afterGroup: must be the startOrder of a managed service"]);
      expect(
        problemsOf(
          with_((c) => {
            c.hooks = { migrate: { service: "db", argv: ["migrate"] } };
          }),
        ),
      ).toEqual(["hooks.migrate.service: must be one of the managed services"]);
    });
  });

  describe("feeds and paths", () => {
    it("validates feed URLs per provider", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed.url = "https://github.com/acme";
          }),
        ),
      ).toEqual(["release.feed.url: must be https://github.com/<owner>/<repo>"]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed = { type: "gitea", url: "https://git.example.com/forge/acme/notes" };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed = { type: "gitlab", url: "https://gitlab.example.com/g/sub/notes" };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed = {
              type: "static",
              url: "https://downloads.example.com/notes/index.json?x=1",
            };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed = { type: "file" };
          }),
        ),
      ).toEqual(["release.feed.path: is required with feed type file"]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed = { type: "file", path: "/feed", url: "https://x.example.com/a/b" };
          }),
        ),
      ).toEqual(["release.feed.url: is not used with feed type file; remove it"]);
      expect(
        problemsOf(
          with_((c) => {
            c.release.feed.url = "https://user:pw@github.com/acme/notes";
          }),
        )[0],
      ).toMatch(/^release\.feed\.url/);
    });

    it("refuses paths with .., commas, colons and relative paths where absolute ones are required", () => {
      for (const dir of ["/opt/../etc", "/opt/a,b", "/opt/a:b", "opt/notes"]) {
        expect(
          problemsOf(
            with_((c) => {
              c.compose.projectDir = dir;
            }),
          )[0],
          dir,
        ).toMatch(/^compose\.projectDir/);
      }
      expect(
        problemsOf(
          with_((c) => {
            c.compose.files = ["../other/compose.yml"];
          }),
        )[0],
      ).toMatch(/^compose\.files\.0/);
      expect(
        problemsOf(
          with_((c) => {
            c.compose.envFile = "/etc/passwd";
          }),
        )[0],
      ).toMatch(/^compose\.envFile/);
    });

    it("validates the tag pattern, listen address and source allowlist", () => {
      expect(
        problemsOf(
          with_((c) => {
            c.release.tagPattern = "{version}-{version}";
          }),
        )[0],
      ).toMatch(/^release\.tagPattern/);
      expect(
        problemsOf(
          with_((c) => {
            c.release.tagPattern = "release/{version}";
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.server = { listen: "updater:8090" };
          }),
        )[0],
      ).toMatch(/^server\.listen/);
      expect(
        problemsOf(
          with_((c) => {
            c.server = { listen: "0.0.0.0:70000" };
          }),
        )[0],
      ).toMatch(/^server\.listen/);
      expect(
        problemsOf(
          with_((c) => {
            c.source = { allowlist: ["github.com/acme"] };
          }),
        )[0],
      ).toMatch(/^source\.allowlist\.0/);
      expect(
        problemsOf(
          with_((c) => {
            c.source = { allowlist: ["github.com/acme/notes", "git.example.com"] };
          }),
        ),
      ).toEqual([]);
      expect(
        problemsOf(
          with_((c) => {
            c.source = { allowlist: ["GitHub.com"] };
          }),
        )[0],
      ).toMatch(/^source\.allowlist\.0/);
      expect(
        problemsOf(
          with_((c) => {
            c.source = { build: { other: {} } };
          }),
        ),
      ).toEqual(["source.build.other: is not the image of a managed service"]);
    });
  });
});

describe("environment overrides", () => {
  it("names variables after the key path", () => {
    expect(toUpperSnake("projectDir")).toBe("PROJECT_DIR");
    expect(envNameOf(["compose", "projectDir"])).toBe("CICD_UPDATER_COMPOSE__PROJECT_DIR");
    expect(envNameOf(["release", "feed", "url"])).toBe("CICD_UPDATER_RELEASE__FEED__URL");
    expect(envNameOf(["trust", "key", "transparencyLog"])).toBe(
      "CICD_UPDATER_TRUST__KEY__TRANSPARENCY_LOG",
    );
  });

  it("covers scalar keys and string lists, but not services, images, commands, checks or builds", () => {
    const names = overridableKeys().map((key) => key.envName);
    expect(names).toContain("CICD_UPDATER_COMPOSE__PROJECT_DIR");
    expect(names).toContain("CICD_UPDATER_TRUST__KEY__PUBLIC_KEY_FILES");
    expect(names).toContain("CICD_UPDATER_HOOKS__HEALTH__HTTP__URL");
    expect(names).toContain("CICD_UPDATER_ROLLBACK__POLICY");
    for (const forbidden of [
      /^CICD_UPDATER_SERVICES/,
      /^CICD_UPDATER_IMAGES/,
      /__COMMAND(__|$)/,
      /__ARGV$/,
      /__CHECKS/,
      /__CONDITIONS/,
      /^CICD_UPDATER_SOURCE__BUILD/,
    ]) {
      expect(
        names.filter((name) => forbidden.test(name)),
        String(forbidden),
      ).toEqual([]);
    }
    expect(names).toContain("CICD_UPDATER_HOOKS__HEALTH__SERVICES_GRACE_SECONDS");
    expect(names).not.toContain("CICD_UPDATER_VERSION");
  });

  it("converts values and applies them over the file", () => {
    const result = applyEnvOverrides(base(), {
      CICD_UPDATER_CONFIG: "/etc/cicd-updater/updater.yaml",
      CICD_UPDATER_COMPOSE__PROJECT_DIR: "/srv/notes",
      CICD_UPDATER_SERVER__ALLOW_PUBLISHED_PORT: "true",
      CICD_UPDATER_DOCKER__MIN_FREE_MB: "4096",
      CICD_UPDATER_COMPOSE__PROFILES: " updater , extra ,",
      CICD_UPDATER_COMPOSE__PROJECT_NAME: "",
      CICD_UPDATER_RELEASE__CHANNEL: "beta",
      PATH: "/usr/bin",
    });
    expect(result.problems).toEqual([]);
    expect(result.applied).toHaveLength(6);
    const validated = validateConfig(result.document);
    expect(validated.ok).toBe(true);
    if (!validated.ok) return;
    expect(validated.config.compose).toMatchObject({
      projectDir: "/srv/notes",
      profiles: ["updater", "extra"],
      projectName: null,
    });
    expect(validated.config.server.allowPublishedPort).toBe(true);
    expect(validated.config.docker.minFreeMb).toBe(4096);
    expect(validated.config.release.channel).toBe("beta");
  });

  it("creates missing sections and sets nested keys", () => {
    const document = base();
    delete document.trust;
    const result = applyEnvOverrides(document, {
      CICD_UPDATER_TRUST__MODE: "key",
      CICD_UPDATER_TRUST__KEY__PUBLIC_KEY_FILES: "/keys/a.pub,/keys/b.pub",
    });
    const validated = validateConfig(result.document);
    expect(validated.ok && validated.config.trust.key?.publicKeyFiles).toEqual([
      "/keys/a.pub",
      "/keys/b.pub",
    ]);
  });

  it("reports unknown variables, bad values and empty required values", () => {
    const result = applyEnvOverrides(base(), {
      CICD_UPDATER_COMPOSE__PROJECTDIR: "/x",
      CICD_UPDATER_SERVICES: "[]",
      CICD_UPDATER_SERVER__ALLOW_PUBLISHED_PORT: "yes",
      CICD_UPDATER_DOCKER__MIN_FREE_MB: "1e3",
      CICD_UPDATER_COMPOSE__PROJECT_DIR: "",
    });
    expect(result.problems.map((problem) => problem.path)).toEqual([
      "CICD_UPDATER_COMPOSE__PROJECTDIR",
      "CICD_UPDATER_COMPOSE__PROJECT_DIR (compose.projectDir)",
      "CICD_UPDATER_DOCKER__MIN_FREE_MB (docker.minFreeMb)",
      "CICD_UPDATER_SERVER__ALLOW_PUBLISHED_PORT (server.allowPublishedPort)",
      "CICD_UPDATER_SERVICES",
    ]);
  });

  it("does not modify the input document", () => {
    const document = base();
    const before = JSON.stringify(document);
    applyEnvOverrides(document, { CICD_UPDATER_COMPOSE__PROJECT_DIR: "/srv" });
    expect(JSON.stringify(document)).toBe(before);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level and drops undefined", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { z: 1, y: 2 }], c: undefined } })).toBe(
      '{"a":{"d":[3,{"y":2,"z":1}]},"b":1}',
    );
  });
});

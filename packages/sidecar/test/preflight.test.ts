import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { BackupStore, EnvFile, Redactor } from "@cicd-updater/engine";
import { baseConfig, FakeClock, FakeSourceBuilder } from "@cicd-updater/engine/testing";
import { type UpdaterConfigInput, validateConfig, writableKeys } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { apiAtLeast, CliDocker, runDoctor, type SelfInfo, SidecarPreflight } from "../src/index.js";
import { ScriptedRunner } from "./helpers.js";

let dir: string;
let projectDir: string;
let stateDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-preflight-"));
  projectDir = path.join(dir, "project");
  stateDir = path.join(dir, "state");
  await fs.mkdir(projectDir);
  await fs.mkdir(stateDir);
  await fs.writeFile(path.join(projectDir, "compose.yaml"), "services: {}\n");
  await fs.writeFile(
    path.join(projectDir, ".env"),
    "APP_IMAGE=ghcr.io/acme/notes:1.0.0\nWEB_IMAGE=ghcr.io/acme/notes-web:1.0.0\n",
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const SELF: SelfInfo = {
  container: {
    id: "f".repeat(64),
    imageId: "sha256:self",
    imageRef: "ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:abc",
    labels: {},
    publishedPorts: [],
    mounts: [],
    state: "running",
  },
  projectName: "notes",
  workingDir: "",
  service: "updater",
  hasRoleLabel: true,
  imageId: "sha256:self",
  imageRef: "ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:abc",
  publishedPorts: [],
  verifyVolume: "notes_updater-verify",
};

/** A Docker world that answers like a healthy project. */
function healthyRunner(
  options: { selfFollows?: boolean; hardcoded?: boolean; apiVersion?: string } = {},
): ScriptedRunner {
  return new ScriptedRunner()
    .answer(() => ({ stdout: "" }))
    .when(["version", "--format", "{{json .Server}}"], {
      stdout: JSON.stringify({ Version: "27.5.1", ApiVersion: options.apiVersion ?? "1.47" }),
    })
    .when(["info", "--format", "{{json .}}"], {
      stdout: JSON.stringify({ Architecture: "x86_64", DriverStatus: [] }),
    })
    .answer((spec) => {
      if (!spec.argv.includes("config")) return undefined;
      const env = spec.env ?? {};
      return {
        stdout: JSON.stringify({
          services: {
            api: {
              image: options.hardcoded
                ? "ghcr.io/acme/notes:1.0.0"
                : (env.APP_IMAGE ?? "ghcr.io/acme/notes:1.0.0"),
            },
            worker: { image: env.APP_IMAGE ?? "ghcr.io/acme/notes:1.0.0" },
            web: { image: env.WEB_IMAGE ?? "ghcr.io/acme/notes-web:1.0.0" },
            updater: {
              image: options.selfFollows
                ? (env.APP_IMAGE ?? "x")
                : "ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:abc",
            },
          },
        }),
      };
    });
}

function preflight(
  runner: ScriptedRunner,
  self: SelfInfo,
  change: (input: UpdaterConfigInput) => void = () => undefined,
) {
  const input = baseConfig(projectDir);
  input.state = { dir: stateDir };
  input.docker = { minFreeMb: 0 };
  change(input);
  const result = validateConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const config = result.config;
  const redactor = new Redactor();
  const docker = new CliDocker({
    runner,
    redactor,
    compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
    timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
  });
  const clock = new FakeClock();
  return {
    clock,
    subject: new SidecarPreflight({
      config,
      docker,
      envFile: new EnvFile(path.join(projectDir, ".env"), writableKeys(config)),
      backups: new BackupStore(path.join(stateDir, "backups"), "notes"),
      source: new FakeSourceBuilder("notes"),
      clock,
      redactor,
      projectName: "notes",
      selfInfo: () => ({
        ...self,
        workingDir: self.workingDir === "" ? projectDir : self.workingDir,
      }),
      protectedBackups: () => new Set(),
    }),
  };
}

describe("preflight", () => {
  it("is ready for a healthy project and reports Docker facts", async () => {
    const { subject } = preflight(healthyRunner(), SELF);
    const capabilities = await subject.check({ deep: true });
    expect(capabilities.blockers).toEqual([]);
    expect(capabilities.ready).toBe(true);
    expect(capabilities.docker).toEqual({
      serverVersion: "27.5.1",
      apiVersion: "1.47",
      architecture: "linux/amd64",
      imageStore: "classic",
    });
    expect(capabilities.compose).toMatchObject({
      projectName: "notes",
      files: ["compose.yaml"],
      envFile: ".env",
    });
    expect(capabilities.warnings).toEqual([]);
  });

  it("collects every blocker with a detail", async () => {
    const self: SelfInfo = {
      ...SELF,
      workingDir: "/elsewhere",
      publishedPorts: ["8090/tcp"],
      verifyVolume: null,
      hasRoleLabel: false,
      imageRef: "ghcr.io/restow-backup/cicd-updater:1.0.0",
    };
    const { subject } = preflight(
      healthyRunner({ selfFollows: true, hardcoded: true, apiVersion: "1.41" }),
      self,
      (input) => {
        input.docker = { minFreeMb: 100_000_000 };
      },
    );
    const capabilities = await subject.check({ deep: true });
    expect(capabilities.ready).toBe(false);
    expect(capabilities.blockers.map((blocker) => blocker.code).sort()).toEqual(
      [
        "api_exposed",
        "compose_unsupported",
        "disk_space",
        "docker_too_old",
        "project_mismatch",
        "updater_image_unpinned",
        "verifier_unavailable",
      ].sort(),
    );
    expect(
      capabilities.blockers.find((blocker) => blocker.code === "compose_unsupported")?.detail,
    ).toContain("api");
    expect(capabilities.warnings.map((warning) => warning.code).sort()).toEqual([
      "self_label_missing",
      "updater_image_not_digest_pinned",
    ]);
  });

  it("blocks when Docker does not answer, the Compose file is missing or the env file cannot be written", async () => {
    await fs.rm(path.join(projectDir, "compose.yaml"));
    await fs.rm(path.join(projectDir, ".env"));
    const down = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    }));
    const capabilities = await preflight(down, { ...SELF, container: null }).subject.check({
      deep: true,
    });
    expect(capabilities.blockers.map((blocker) => blocker.code)).toEqual([
      "docker_unreachable",
      "compose_missing",
      "env_unwritable",
    ]);
    expect(capabilities.blockers[0]?.detail).toContain("Cannot connect");
  });

  it("finds another sidecar of the same project", async () => {
    const other = "a".repeat(64);
    const runner = healthyRunner()
      .when(
        [
          "ps",
          "-q",
          "--no-trunc",
          "--filter",
          "label=io.github.restow-backup.cicd-updater.role=sidecar",
        ],
        { stdout: `${SELF.container?.id}\n${other}\n` },
      )
      .when(["container", "inspect", "--format", "{{json .}}", other], {
        stdout: JSON.stringify({
          Id: other,
          Config: { Labels: { "com.docker.compose.project": "notes" } },
        }),
      });
    const capabilities = await preflight(runner, SELF).subject.check({ deep: false });
    expect(capabilities.blockers.map((blocker) => blocker.code)).toEqual(["multiple_updaters"]);
  });

  it("warns about trust mode none, a missing app check, a probe without backup and source mode", async () => {
    const { subject } = preflight(healthyRunner(), SELF, (input) => {
      input.trust = { mode: "none", none: { acknowledgeUnsigned: true } };
      input.hooks = { ...input.hooks, health: { type: "none" }, backup: { type: "none" } };
      input.source = { allowlist: ["github.com/acme/notes"] };
    });
    const capabilities = await subject.check({ deep: true });
    expect(capabilities.warnings.map((warning) => warning.code)).toEqual([
      "trust_mode_none",
      "health_without_app_check",
      "backup_none_with_probe",
      "source_mode_enabled",
    ]);
  });

  it("caches for 30 seconds and probes Compose again only on deep checks", async () => {
    const runner = healthyRunner();
    const { subject, clock } = preflight(runner, SELF);
    await subject.get();
    const probes = () =>
      runner.specs.filter(
        (spec) => spec.argv.includes("config") && spec.env && Object.keys(spec.env).length > 0,
      ).length;
    expect(probes()).toBe(1);
    await subject.get();
    expect(runner.specs.filter((spec) => spec.argv.includes("version")).length).toBe(1);
    clock.advance(31_000);
    await subject.get();
    expect(probes()).toBe(1);
    await subject.get(true);
    expect(probes()).toBe(2);
    subject.invalidate();
  });

  it("compares Engine API versions numerically", () => {
    expect(apiAtLeast("1.43", "1.43")).toBe(true);
    expect(apiAtLeast("1.100", "1.43")).toBe(true);
    expect(apiAtLeast("1.42", "1.43")).toBe(false);
    expect(apiAtLeast(null, "1.43")).toBe(false);
  });
});

describe("doctor", () => {
  it("exits 2 when the configuration is invalid", async () => {
    const report = await runDoctor({
      loaded: {
        ok: false,
        file: "/etc/cicd-updater/updater.yaml",
        problems: [{ path: "version", message: "must be 1" }],
      },
      docker: null,
      self: null,
      redactor: new Redactor(),
    });
    expect(report.exitCode).toBe(2);
    expect(report.checks).toEqual([
      {
        name: "configuration",
        status: "fail",
        detail: "version: must be 1",
        where: "/etc/cicd-updater/updater.yaml",
      },
    ]);
  });

  it("checks every prerequisite and names file and key", async () => {
    const input = baseConfig(projectDir);
    input.state = { dir: stateDir };
    input.docker = { minFreeMb: 0, socket: path.join(dir, "docker.sock") };
    const result = validateConfig(input);
    if (!result.ok) throw new Error("config");
    const runner = healthyRunner();
    const docker = new CliDocker({
      runner,
      redactor: new Redactor(),
      compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
      timeouts: { pullSeconds: 1, upSeconds: 1, composeSeconds: 10, stopSeconds: 1 },
    });
    const report = await runDoctor({
      loaded: {
        ok: true,
        file: "/etc/cicd-updater/updater.yaml",
        config: result.config,
        configHash: "a".repeat(64),
        overrides: [],
      },
      docker,
      self: { ...SELF, workingDir: projectDir },
      redactor: new Redactor(),
      fetch: (async () => new Response("{}")) as unknown as typeof fetch,
      feedFetch: async () => new Response(JSON.stringify([{ tag_name: "v1.1.0", assets: [] }])),
    });
    const byName = Object.fromEntries(report.checks.map((check) => [check.name, check]));
    expect(byName["docker socket"]).toMatchObject({
      status: "fail",
      where: "/etc/cicd-updater/updater.yaml: docker.socket",
    });
    expect(byName["docker engine"]?.status).toBe("ok");
    expect(byName["compose configuration"]?.status).toBe("ok");
    expect(byName["env file"]?.status).toBe("ok");
    expect(byName["release feed"]).toMatchObject({
      status: "ok",
      detail: "1 releases, newest 1.1.0",
    });
    expect(byName.sigstore?.status).toBe("ok");
    expect(byName["registry access"]?.status).toBe("ok");
    expect(report.exitCode).toBe(1);
  });
});

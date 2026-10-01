import * as os from "node:os";
import * as path from "node:path";
import { OpsError, PullError, Redactor } from "@cicd-updater/engine";
import { describe, expect, it } from "vitest";
import {
  CliDocker,
  classifyPullFailure,
  freeBytes,
  parseComposePs,
  parseSize,
  platformOf,
} from "../src/index.js";
import { rejection, ScriptedRunner } from "./helpers.js";

function docker(
  runner: ScriptedRunner,
  compose: Partial<ConstructorParameters<typeof CliDocker>[0]["compose"]> = {},
) {
  return new CliDocker({
    runner,
    redactor: new Redactor(),
    compose: { projectName: "notes", files: [], envFile: null, profiles: [], ...compose },
    timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
  });
}

describe("compose command lines", () => {
  it("pass project, files, env file and profiles to every Compose call", async () => {
    const runner = new ScriptedRunner().answer(() => ({
      stdout: JSON.stringify({ name: "notes", services: {} }),
    }));
    await docker(runner, {
      files: ["compose.yml", "compose.prod.yml"],
      envFile: ".env.production",
      profiles: ["updater"],
    }).composeConfig({
      APP_IMAGE: "probe",
    });
    expect(runner.argvs[0]).toEqual([
      "docker",
      "compose",
      "-p",
      "notes",
      "-f",
      "compose.yml",
      "-f",
      "compose.prod.yml",
      "--env-file",
      ".env.production",
      "--profile",
      "updater",
      "config",
      "--format",
      "json",
    ]);
    expect(runner.specs[0]?.env).toEqual({ APP_IMAGE: "probe" });
  });

  it("read images, volumes and networks from the configuration without quoting it on errors", async () => {
    const runner = new ScriptedRunner().answer(() => ({
      stdout: JSON.stringify({
        name: "notes",
        services: {
          api: {
            image: "ghcr.io/acme/notes:1.0.0",
            environment: { POSTGRES_PASSWORD: "top-secret" },
          },
          db: { image: "postgres:17-alpine", profiles: [] },
          updater: { image: "ghcr.io/restow-backup/cicd-updater:1.0.0", profiles: ["updater"] },
        },
        volumes: { data: { name: "notes_data" }, ext: { name: "shared", external: true } },
        networks: { default: { name: "notes_default" } },
      }),
    }));
    const model = await docker(runner).composeConfig();
    expect(model.services.updater).toEqual({
      image: "ghcr.io/restow-backup/cicd-updater:1.0.0",
      profiles: ["updater"],
    });
    expect(model.volumes.ext).toEqual({ name: "shared", external: true });
    expect(model.networks.default?.name).toBe("notes_default");
    expect(await docker(runner).composeImages({})).toMatchObject({
      api: "ghcr.io/acme/notes:1.0.0",
      db: "postgres:17-alpine",
    });
    const broken = new ScriptedRunner().answer(() => ({
      stdout: "POSTGRES_PASSWORD: top-secret {",
    }));
    const error = await rejection<OpsError>(docker(broken).composeConfig());
    expect(error).toBeInstanceOf(OpsError);
    expect(`${error.message} ${error.detail}`).not.toContain("top-secret");
  });

  it("stop, start and run one-off containers without dependencies, builds or pulls", async () => {
    const runner = new ScriptedRunner();
    const ops = docker(runner);
    await ops.stop(["worker", "api"], 60);
    await ops.up(["api"]);
    await ops.runOnce({
      service: "api",
      argv: ["npm", "run", "migrate"],
      env: { APP_IMAGE: "x:1" },
      name: "cicd-updater-migrate-r-1-abcd",
      timeoutSeconds: 600,
    });
    await ops.removeContainer("cicd-updater-migrate-r-1-abcd");
    expect(runner.argvs.slice(0, 3).map((argv) => argv.slice(4))).toEqual([
      ["stop", "-t", "60", "worker", "api"],
      ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "api"],
      [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--name",
        "cicd-updater-migrate-r-1-abcd",
        "api",
        "npm",
        "run",
        "migrate",
      ],
    ]);
    expect(runner.argvs[3]).toEqual(["docker", "rm", "-f", "cicd-updater-migrate-r-1-abcd"]);
    expect(runner.specs[2]?.env).toEqual({ APP_IMAGE: "x:1" });
    expect(runner.specs[2]?.timeoutMs).toBe(600_000);
  });

  it("refuse names and references that are not plain, before any command runs", async () => {
    const runner = new ScriptedRunner();
    const ops = docker(runner);
    await expect(ops.up(["api; rm -rf /"])).rejects.toBeInstanceOf(OpsError);
    await expect(ops.up([])).rejects.toBeInstanceOf(OpsError);
    await expect(ops.pull("ghcr.io/x/y:1 --all-tags")).rejects.toBeInstanceOf(OpsError);
    await expect(ops.removeContainer("../x")).rejects.toBeInstanceOf(OpsError);
    await expect(
      ops.build({
        contextDir: "relative",
        dockerfile: "Dockerfile",
        target: null,
        tag: "x:1",
        buildArgs: {},
      }),
    ).rejects.toBeInstanceOf(OpsError);
    await expect(
      ops.build({
        contextDir: "/src",
        dockerfile: "/src/Dockerfile",
        target: null,
        tag: "x:1",
        buildArgs: { VERSION: "1; rm" },
      }),
    ).rejects.toBeInstanceOf(OpsError);
    expect(runner.specs).toEqual([]);
  });

  it("build with file, target, label and build arguments", async () => {
    const runner = new ScriptedRunner();
    await docker(runner).build({
      contextDir: "/state/src/r-1/tree",
      dockerfile: "/state/src/r-1/tree/Dockerfile",
      target: "runtime",
      tag: "cicd-updater.local/notes/app:1.1.0",
      buildArgs: { APP_VERSION: "1.1.0" },
    });
    expect(runner.argvs[0]).toEqual([
      "docker",
      "build",
      "--file",
      "/state/src/r-1/tree/Dockerfile",
      "--tag",
      "cicd-updater.local/notes/app:1.1.0",
      "--label",
      "io.github.restow-backup.cicd-updater.managed=build",
      "--target",
      "runtime",
      "--build-arg",
      "APP_VERSION=1.1.0",
      "/state/src/r-1/tree",
    ]);
  });
});

describe("images", () => {
  it("pull by digest and classify failures", async () => {
    const ref = `ghcr.io/acme/notes@sha256:${"a".repeat(64)}`;
    const runner = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail: "Error response from daemon: denied: requested access to the resource is denied",
    }));
    const error = await rejection<PullError>(docker(runner).pull(ref));
    expect(error).toBeInstanceOf(PullError);
    expect(error.kind).toBe("registry_unauthorized");
    expect(runner.argvs[0]).toEqual(["docker", "pull", "--quiet", ref]);
    const timeout = new ScriptedRunner().answer(() => ({ exitCode: 124, timedOut: true }));
    expect((await rejection<PullError>(docker(timeout).pull(ref))).kind).toBe(
      "registry_unreachable",
    );
  });

  it.each([
    ["manifest for ghcr.io/x:1 not found: manifest unknown: manifest unknown", "image_not_found"],
    [
      'failed to resolve reference "ghcr.io/x@sha256:a": ghcr.io/x@sha256:a: not found',
      "image_not_found",
    ],
    ["Error response from daemon: unauthorized: authentication required", "registry_unauthorized"],
    [
      "Error response from daemon: denied: requested access to the resource is denied (not found)",
      "registry_unauthorized",
    ],
    ["toomanyrequests: You have reached your pull rate limit", "registry_rate_limited"],
    ["dial tcp: lookup ghcr.io: no such host", "registry_unreachable"],
    [
      "tls: failed to verify certificate: x509: certificate signed by unknown authority",
      "registry_unreachable",
    ],
    ["something else entirely", "pull_failed"],
  ])("classify %j as %s", (text, kind) => {
    expect(classifyPullFailure(text)).toBe(kind);
  });

  it("inspect images and report missing ones as null", async () => {
    const runner = new ScriptedRunner().when(["image", "inspect"], {
      stdout: JSON.stringify({
        Id: "sha256:abc",
        RepoDigests: ["ghcr.io/acme/notes@sha256:abc"],
        Config: { Labels: { "org.opencontainers.image.version": "1.1.0" } },
      }),
    });
    expect(await docker(runner).inspectImage("ghcr.io/acme/notes:1.1.0")).toEqual({
      id: "sha256:abc",
      repoDigests: ["ghcr.io/acme/notes@sha256:abc"],
      labels: { "org.opencontainers.image.version": "1.1.0" },
    });
    const missing = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail: "Error: No such image: x:1",
    }));
    expect(await docker(missing).inspectImage("x:1")).toBeNull();
  });

  it("prune only unused images of the managed repositories, keeping the configured number", async () => {
    const runner = new ScriptedRunner()
      .when(["ps", "-a", "-q", "--no-trunc"], { stdout: `${"c".repeat(64)}\n` })
      .when(["container", "inspect"], {
        stdout: JSON.stringify({
          Id: "c".repeat(64),
          Image: "sha256:running",
          Config: { Image: "x", Labels: {} },
        }),
      })
      .answer((spec) =>
        spec.argv.includes("inspect") && spec.argv.includes("image")
          ? {
              stdout: JSON.stringify({
                Id: spec.argv.at(-1)?.includes("1.1.0") ? "sha256:new" : "sha256:prev",
                RepoDigests: [],
                Config: {},
              }),
            }
          : undefined,
      )
      .when(["image", "ls"], {
        stdout: ["new", "running", "prev", "old1", "old2", "old3"]
          .map((id, index) =>
            JSON.stringify({ ID: `sha256:${id}`, CreatedAt: `2026-1${9 - index}` }),
          )
          .join("\n"),
      });
    const removed = await docker(runner).pruneImages({
      repositories: ["ghcr.io/acme/notes"],
      keep: ["ghcr.io/acme/notes:1.1.0@sha256:x", "ghcr.io/acme/notes:1.0.0"],
      keepCount: 1,
    });
    expect(removed).toEqual(["sha256:old2", "sha256:old3"]);
    expect(
      runner.argvs.filter((argv) => argv[1] === "image" && argv[2] === "rm").map((argv) => argv[3]),
    ).toEqual(["sha256:old2", "sha256:old3"]);
    expect(runner.argvs.some((argv) => argv.includes("--force") || argv.includes("prune"))).toBe(
      false,
    );
  });
});

describe("parsers", () => {
  it("read both JSON forms of compose ps", () => {
    const states = parseComposePs(
      [
        JSON.stringify({
          Service: "api",
          State: "running",
          Health: "healthy",
          ExitCode: 0,
          Image: "ghcr.io/acme/notes:1.1.0",
        }),
        JSON.stringify({ Service: "worker", State: "Restarting", Health: "", ExitCode: 1 }),
      ].join("\n"),
    );
    expect(states).toEqual([
      {
        service: "api",
        state: "running",
        health: "healthy",
        exitCode: 0,
        image: "ghcr.io/acme/notes:1.1.0",
      },
      { service: "worker", state: "restarting", health: null, exitCode: 1, image: null },
    ]);
    expect(parseComposePs(JSON.stringify([{ Service: "db", State: "running" }]))).toHaveLength(1);
    expect(parseComposePs("")).toEqual([]);
    expect(() => parseComposePs("{not json\n")).toThrow(OpsError);
  });

  it("map architectures and sizes", () => {
    expect(platformOf("x86_64")).toBe("linux/amd64");
    expect(platformOf("aarch64")).toBe("linux/arm64");
    expect(platformOf("armv7l")).toBeNull();
    expect(parseSize("1.5GB")).toBe(1_500_000_000);
    expect(parseSize("12kB")).toBe(12_000);
    expect(parseSize("0B")).toBe(0);
    expect(parseSize("n/a")).toBe(0);
  });

  it("detect the containerd image store", async () => {
    const runner = new ScriptedRunner().when(["info"], {
      stdout: JSON.stringify({
        Architecture: "aarch64",
        DriverStatus: [["driver-type", "io.containerd.snapshotter.v1"]],
      }),
    });
    expect(await docker(runner).info()).toEqual({
      architecture: "linux/arm64",
      imageStore: "containerd",
    });
  });

  it("remove leftover helper and migrate containers", async () => {
    const id = "d".repeat(64);
    const runner = new ScriptedRunner().when(["ps", "-a", "-q", "--no-trunc", "--filter"], {
      stdout: `${id}\n`,
    });
    await docker(runner).removeLeftovers();
    expect(runner.argvs.filter((argv) => argv[1] === "rm")).toEqual([["docker", "rm", "-f", id]]);
    expect(runner.argvs[0]).toContain("label=io.github.restow-backup.cicd-updater.managed=true");
    expect(runner.argvs[1]).toContain("name=cicd-updater-migrate-");
  });
});

describe("freeBytes", () => {
  it("measures the nearest existing directory when the target does not exist yet", async () => {
    const existing = await freeBytes(os.tmpdir());
    const missing = await freeBytes(path.join(os.tmpdir(), "cicd-updater-no-such-dir", "backups"));
    expect(existing).toBeGreaterThan(0);
    // Same file system: the same order of magnitude (other processes may write meanwhile).
    expect(Math.abs(missing - existing)).toBeLessThan(existing / 10);
  });
});

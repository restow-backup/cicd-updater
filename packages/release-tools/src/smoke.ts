import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { scalarText, valueAtPath } from "@cicd-updater/protocol";
import { parse, stringify } from "yaml";
import { envCheck, smokeEnvFile } from "./env-check.js";
import type { Exec } from "./exec.js";

/**
 * The release smoke test (design 2.2, 10.6 `smoke`): what does not start is
 * not published. In order:
 *
 *   1. every `${VAR}` of the Compose files appears in `.env.example`;
 *   2. the project starts from the Compose files with an env file derived from
 *      `.env.example` as written plus the image variables (by digest), with
 *      restart policies switched off so a crash stays visible;
 *   3. the health URL answers (with the expected version);
 *   4. optionally an upgrade from the previous release: the previous images
 *      first, then the new digests (by recreating, or through the sidecar with
 *      a file feed and trust mode none, because the images are signed only
 *      after the smoke passed);
 *   5. everything is torn down, also on failure.
 */

export interface SmokeImage {
  repository: string;
  digest: string;
}

export interface SmokeOptions {
  composeFiles: string[];
  envExample: string;
  /** image key -> repository and (index or platform) digest */
  images: Record<string, SmokeImage>;
  /** image key -> env variable */
  imageVars: Record<string, string>;
  healthUrl: string;
  healthVersionPath: string | null;
  expectVersion: string | null;
  /** Images of the release to upgrade from (resolved by the caller), or null. */
  upgradeFrom: { version: string; images: Record<string, SmokeImage> } | null;
  timeoutSeconds: number;
  /** Extra env variables for the smoke (for example a scratch database password). */
  extraEnv?: Record<string, string>;
  /**
   * Upgrade through the sidecar itself: the app's updater.yaml (switched to
   * trust mode none and a file feed with a generated release.json) and the
   * sidecar image to run.
   */
  updater?: { configFile: string; image: string; service?: string; profile?: string } | null;
  /** Working directory (the repository checkout). */
  cwd: string;
}

export interface SmokeStep {
  name: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

export interface SmokeDeps {
  exec: Exec;
  fetch: typeof fetch;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  log: (line: string) => void;
}

export interface SmokeResult {
  ok: boolean;
  steps: SmokeStep[];
  report: string;
}

class StepFailed extends Error {}

export function imageEnv(
  images: Record<string, SmokeImage>,
  vars: Record<string, string>,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, variable] of Object.entries(vars)) {
    const image = images[key];
    if (!image) {
      throw new Error(`No image for the key ${key} (image-vars names it).`);
    }
    if (!/^sha256:[0-9a-f]{64}$/.test(image.digest)) {
      throw new Error(`The image ${key} has no digest.`);
    }
    env[variable] = `${image.repository}@${image.digest}`;
  }
  return env;
}

/** A Compose override that switches restart policies off for every service. */
export function noRestartOverride(services: readonly string[]): string {
  const lines = ["services:"];
  for (const service of services) {
    if (!/^[A-Za-z0-9._-]+$/.test(service)) {
      throw new Error(`Unexpected service name ${service}.`);
    }
    lines.push(`  ${service}:`, '    restart: "no"');
  }
  return `${lines.join("\n")}\n`;
}

export function renderReport(result: { ok: boolean; steps: SmokeStep[] }, title: string): string {
  const lines = [
    `## ${title}`,
    "",
    `- Verdict: ${result.ok ? "passed" : "failed"}`,
    "",
    "| Step | Result | Seconds | Detail |",
    "| --- | --- | --- | --- |",
  ];
  for (const step of result.steps) {
    lines.push(
      `| ${step.name} | ${step.ok ? "passed" : "failed"} | ${step.seconds} | ${step.detail.replace(/\|/g, "\\|").replace(/\n/g, " ")} |`,
    );
  }
  return `${lines.join("\n")}\n`;
}

export async function runSmoke(options: SmokeOptions, deps: SmokeDeps): Promise<SmokeResult> {
  const steps: SmokeStep[] = [];
  // Compose prefers the shell environment over --env-file: a CI variable with the
  // name of an image variable (APP_IMAGE=ghcr.io/acme/notes) would otherwise win
  // over the pushed digest. Compose calls therefore run without the env file's keys.
  const envKeys = new Set<string>();
  const exec: Exec = (argv, execOptions = {}) =>
    deps.exec(
      argv,
      argv[0] === "docker" && argv[1] === "compose"
        ? { ...execOptions, unsetEnv: [...(execOptions.unsetEnv ?? []), ...envKeys] }
        : execOptions,
    );
  const project = `cicd-updater-smoke-${randomBytes(3).toString("hex")}`;
  // With the upgrade through the sidecar, the sidecar container mounts files of the work
  // directory (feed, updater.yaml): they must be where the Docker daemon sees them, as the
  // checkout is. The runner's temp directory is not, when the smoke itself runs in a
  // container (the release CLI image, GitLab CI with dind; found in the e2e).
  const work = await fs.mkdtemp(
    options.updater
      ? path.join(path.resolve(options.cwd), ".cicd-updater-smoke-")
      : path.join(os.tmpdir(), "cicd-updater-smoke-"),
  );
  const envFile = options.updater
    ? path.join(path.resolve(options.cwd), ".cicd-updater-smoke.env")
    : path.join(work, "smoke.env");
  const override = path.join(work, "no-restart.yml");
  const compose = (args: string[]) =>
    [
      "docker",
      "compose",
      "-p",
      project,
      ...options.composeFiles.flatMap((file) => ["-f", file]),
      "-f",
      override,
      "--env-file",
      envFile,
      ...args,
    ] as [string, ...string[]];
  const step = async (name: string, action: () => Promise<string>): Promise<void> => {
    const started = deps.now();
    try {
      const detail = await action();
      steps.push({ name, ok: true, detail, seconds: Math.round((deps.now() - started) / 1000) });
      deps.log(`passed: ${name} ${detail}`);
    } catch (error) {
      steps.push({
        name,
        ok: false,
        detail: (error as Error).message,
        seconds: Math.round((deps.now() - started) / 1000),
      });
      deps.log(`failed: ${name}: ${(error as Error).message}`);
      throw new StepFailed(name);
    }
  };
  const example = await fs.readFile(path.resolve(options.cwd, options.envExample), "utf8");
  const writeEnv = async (images: Record<string, SmokeImage>) => {
    const text = smokeEnvFile(example, {
      ...imageEnv(images, options.imageVars),
      ...(options.extraEnv ?? {}),
    });
    for (const line of text.split("\n")) {
      const key = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
      if (key) {
        envKeys.add(key);
      }
    }
    await fs.writeFile(envFile, text, { mode: 0o600 });
  };
  const waitHealthy = async (version: string | null): Promise<string> => {
    const deadline = deps.now() + options.timeoutSeconds * 1000;
    let last = "no answer";
    for (;;) {
      try {
        const response = await deps.fetch(options.healthUrl, { signal: AbortSignal.timeout(5000) });
        const text = await response.text();
        if (response.ok) {
          if (!options.healthVersionPath || !version) {
            return `HTTP ${response.status}`;
          }
          const reported = scalarText(valueAtPath(JSON.parse(text), options.healthVersionPath));
          if (reported === version) {
            return `HTTP ${response.status}, version ${reported}`;
          }
          last = `version ${reported ?? "none"}, expected ${version}`;
        } else {
          last = `HTTP ${response.status}`;
        }
      } catch (error) {
        last = (error as Error).message;
      }
      const ps = await exec(compose(["ps", "-a", "--format", "json"]), { cwd: options.cwd });
      const exited = ps.stdout
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          try {
            return JSON.parse(line) as { Service?: string; State?: string; ExitCode?: number };
          } catch {
            return {};
          }
        })
        .filter((entry) => entry.State === "exited" && entry.ExitCode !== 0);
      if (exited.length > 0) {
        const logs = await exec(compose(["logs", "--no-color", "--tail", "40"]), {
          cwd: options.cwd,
        });
        throw new Error(
          `exited: ${exited.map((entry) => `${entry.Service} (${entry.ExitCode})`).join(", ")}. ${logs.stdout.slice(-1500)}`,
        );
      }
      if (deps.now() >= deadline) {
        throw new Error(`not healthy within ${options.timeoutSeconds} s (${last})`);
      }
      await deps.sleep(2000);
    }
  };

  let ok = true;
  try {
    await step("env-check", async () => {
      const texts = await Promise.all(
        options.composeFiles.map((file) => fs.readFile(path.resolve(options.cwd, file), "utf8")),
      );
      const result = envCheck(texts, example);
      if (!result.ok) {
        throw new Error(`not in ${options.envExample}: ${result.missing.join(", ")}`);
      }
      return `${result.referenced.length} variables documented`;
    });
    const start = options.upgradeFrom?.images ?? options.images;
    await writeEnv(start);
    await fs.writeFile(override, "services: {}\n");
    await step("compose config", async () => {
      const services = await exec(compose(["config", "--services"]), { cwd: options.cwd });
      if (services.exitCode !== 0) {
        throw new Error(services.stderr.slice(-1500));
      }
      const names = services.stdout
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      await fs.writeFile(override, noRestartOverride(names));
      return `${names.length} services, restart policies off`;
    });
    await step(options.upgradeFrom ? `start ${options.upgradeFrom.version}` : "start", async () => {
      const result = await exec(
        compose([
          "up",
          "-d",
          "--no-build",
          "--pull",
          "missing",
          "--wait-timeout",
          String(options.timeoutSeconds),
        ]),
        {
          cwd: options.cwd,
          timeoutMs: (options.timeoutSeconds + 60) * 1000,
        },
      );
      if (result.exitCode !== 0) {
        throw new Error(result.stderr.slice(-1500));
      }
      return "started";
    });
    await step("health", () =>
      waitHealthy(options.upgradeFrom ? options.upgradeFrom.version : options.expectVersion),
    );
    if (options.upgradeFrom && options.updater) {
      const updater = options.updater;
      await step("upgrade through the sidecar", async () => {
        const plan = await sidecarUpgradePlan({
          options,
          updater,
          work,
          project,
          envFile,
          composeOverride: override,
        });
        await fs.writeFile(override, plan.override(await fs.readFile(override, "utf8")));
        const service = updater.service ?? "updater";
        const profile = ["--profile", updater.profile ?? "updater"];
        const run = (args: string[], timeoutMs = 120_000) =>
          exec(compose([...profile, ...args]), { cwd: options.cwd, timeoutMs });
        const up = await run(["up", "-d", "--no-build", service]);
        if (up.exitCode !== 0) {
          throw new Error(`the sidecar did not start: ${up.stderr.slice(-1000)}`);
        }
        const status = async (): Promise<{
          phase?: string;
          run?: { outcome?: string; failure?: { code?: string } | null } | null;
        } | null> => {
          const result = await run(["exec", "-T", service, "cicd-updater", "status", "--json"]);
          try {
            return result.exitCode === 0 ? JSON.parse(result.stdout) : null;
          } catch {
            return null;
          }
        };
        const deadline = deps.now() + options.timeoutSeconds * 1000;
        while ((await status()) === null) {
          if (deps.now() >= deadline) throw new Error("the sidecar API did not answer");
          await deps.sleep(2000);
        }
        const scheduled = await run([
          "exec",
          "-T",
          service,
          "cicd-updater",
          "schedule",
          options.expectVersion ?? "",
          "--yes",
        ]);
        if (scheduled.exitCode !== 0) {
          throw new Error(
            `scheduling failed: ${(scheduled.stderr || scheduled.stdout).slice(-1000)}`,
          );
        }
        for (;;) {
          const view = await status();
          if (view && (view.phase === "succeeded" || view.phase === "failed")) {
            if (view.run?.outcome !== "succeeded") {
              const logs = await run(["exec", "-T", service, "cicd-updater", "logs"]);
              throw new Error(
                `outcome ${view.run?.outcome ?? "unknown"} (${view.run?.failure?.code ?? "-"}): ${logs.stdout.slice(-1500)}`,
              );
            }
            return "succeeded through the sidecar";
          }
          if (deps.now() >= deadline)
            throw new Error("the update through the sidecar did not finish in time");
          await deps.sleep(3000);
        }
      });
      await step("health after upgrade", () => waitHealthy(options.expectVersion));
    } else if (options.upgradeFrom) {
      await writeEnv(options.images);
      await step("upgrade", async () => {
        const result = await exec(compose(["up", "-d", "--no-build", "--pull", "missing"]), {
          cwd: options.cwd,
          timeoutMs: (options.timeoutSeconds + 60) * 1000,
        });
        if (result.exitCode !== 0) {
          throw new Error(result.stderr.slice(-1500));
        }
        return "recreated with the new digests";
      });
      await step("health after upgrade", () => waitHealthy(options.expectVersion));
    }
  } catch (error) {
    if (!(error instanceof StepFailed)) {
      steps.push({ name: "smoke", ok: false, detail: (error as Error).message, seconds: 0 });
    }
    ok = false;
  } finally {
    // With the sidecar's profile: `down` leaves services of profiles it was not given
    // running (the sidecar survived the smoke; found in the e2e).
    const profiles = options.updater ? ["--profile", options.updater.profile ?? "updater"] : [];
    const down = await exec(
      compose([...profiles, "down", "-v", "--remove-orphans", "--timeout", "10"]),
      { cwd: options.cwd },
    ).catch(() => null);
    steps.push({
      name: "teardown",
      ok: down?.exitCode === 0,
      detail: down?.exitCode === 0 ? "removed" : (down?.stderr.slice(-300) ?? "failed"),
      seconds: 0,
    });
    await fs.rm(work, { recursive: true, force: true });
    if (options.updater) {
      await fs.rm(envFile, { force: true });
    }
  }
  return { ok, steps, report: renderReport({ ok, steps }, "Release smoke test") };
}

// biome-ignore lint/suspicious/noExplicitAny: arbitrary YAML of the app's own files
type YamlMap = Record<string, any>;

/** Host platform of the runner, for the generated release document. */
export function runnerPlatform(arch = process.arch): "linux/amd64" | "linux/arm64" {
  return arch === "arm64" ? "linux/arm64" : "linux/amd64";
}

/**
 * Files for the upgrade through the sidecar: a file feed with a generated
 * release.json (signing none: the images are signed only after the smoke
 * passed), a copy of the app's updater.yaml switched to trust mode none and
 * that feed, and a Compose override that runs the sidecar next to the project.
 */
export async function sidecarUpgradePlan(input: {
  options: SmokeOptions;
  updater: NonNullable<SmokeOptions["updater"]>;
  work: string;
  project: string;
  envFile: string;
  /** The smoke's own override (no restart policies, the sidecar service). */
  composeOverride?: string;
}): Promise<{ feedDir: string; configFile: string; override: (current: string) => string }> {
  const { options, updater, work, project, envFile } = input;
  const version = options.expectVersion;
  if (!version) {
    throw new Error("expect-version is required for the upgrade through the sidecar");
  }
  const cwd = path.resolve(options.cwd);
  const feedDir = path.join(work, "feed");
  await fs.mkdir(feedDir, { recursive: true });
  const images: Record<string, unknown> = {};
  for (const [key, image] of Object.entries(options.images)) {
    images[key] = {
      repository: image.repository,
      tag: version,
      digest: image.digest,
      platforms: [runnerPlatform()],
    };
  }
  const document = {
    schemaVersion: 1,
    project: "smoke.invalid/smoke/smoke",
    version,
    tag: `v${version}`,
    channel: version.includes("-") ? "beta" : "stable",
    createdAt: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
    images,
    upgrade: { minimumFromVersion: null, manualSteps: { required: false } },
    signing: { mode: "none" },
  };
  await fs.writeFile(path.join(feedDir, "release.json"), `${JSON.stringify(document, null, 2)}\n`);
  await fs.writeFile(
    path.join(feedDir, "index.json"),
    JSON.stringify({
      schemaVersion: 1,
      releases: [
        {
          version,
          tag: `v${version}`,
          prerelease: version.includes("-"),
          releaseJson: "release.json",
        },
      ],
    }),
  );
  const config = parse(await fs.readFile(path.resolve(cwd, updater.configFile), "utf8"), {
    version: "1.2",
  }) as YamlMap;
  config.trust = {
    mode: "none",
    none: { acknowledgeUnsigned: true },
    verifier: { isolate: false },
  };
  config.release = {
    ...(config.release ?? {}),
    feed: { type: "file", path: "/smoke-feed" },
    tagPattern: "v{version}",
  };
  // The sidecar must see the project as the smoke started it: the same Compose files
  // (the smoke's port overrides included) plus the smoke's own override. Otherwise it
  // recreates the services without them (found in the e2e).
  config.compose = {
    ...(config.compose ?? {}),
    projectDir: cwd,
    projectName: project,
    envFile: path.relative(cwd, envFile),
    // Relative to the project directory, as updater.yaml requires (the work directory
    // with the override is inside the checkout).
    files: [
      ...options.composeFiles.map((file) => path.relative(cwd, path.resolve(cwd, file))),
      ...(input.composeOverride ? [path.relative(cwd, input.composeOverride)] : []),
    ],
  };
  config.state = { ...(config.state ?? {}), dir: "/state" };
  const configFile = path.join(work, "updater.yaml");
  await fs.writeFile(configFile, stringify(config));
  const service = updater.service ?? "updater";
  return {
    feedDir,
    configFile,
    override: (current) => {
      const base = ((parse(current) as YamlMap | null) ?? {}) as YamlMap & {
        services?: YamlMap;
        volumes?: YamlMap;
      };
      base.services = base.services ?? {};
      base.services[service] = {
        ...(base.services[service] ?? {}),
        image: updater.image,
        profiles: [updater.profile ?? "updater"],
        restart: "no",
        environment: {
          CICD_UPDATER_CONFIG: "/smoke-config/updater.yaml",
          CICD_UPDATER_COMPOSE__PROJECT_DIR: cwd,
        },
        volumes: [
          "/var/run/docker.sock:/var/run/docker.sock",
          `${cwd}:${cwd}`,
          `${feedDir}:/smoke-feed:ro`,
          `${work}:/smoke-config:ro`,
          "smoke-updater-state:/state",
          "smoke-updater-shared:/shared",
        ],
        labels: { "io.github.restow-backup.cicd-updater.role": "sidecar" },
      };
      base.volumes = {
        ...(base.volumes ?? {}),
        "smoke-updater-state": {},
        "smoke-updater-shared": {},
      };
      // Replace (not merge) the sidecar's environment and volumes of the project's
      // Compose file: its PROJECT_DIR mount, registry auth file and other overrides
      // belong to the production host, not to the CI runner (Compose 2.24 or newer).
      return stringify(base)
        .replace(/\n {4}environment:\n/, "\n    environment: !override\n")
        .replace(/\n {4}volumes:\n/, "\n    volumes: !override\n");
    },
  };
}

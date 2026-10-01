import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type BuildSpec,
  type DockerOps,
  type ImageInfo,
  OpsError,
  PullError,
  type PullFailureKind,
  type Redactor,
  type RunOnceResult,
  type ServiceState,
} from "@cicd-updater/engine";
import { MANAGED_LABEL, type Platform } from "@cicd-updater/protocol";
import type { CommandResult, CommandRunner, CommandSpec } from "./runner.js";

/**
 * Docker and Compose operations built out of `docker` command lines (design
 * 2.3): every command is an argument vector; values that come from outside
 * (image references, service names, container names, build arguments) are
 * checked against strict patterns first; none of them is ever part of a shell
 * string.
 *
 * Derived from Restow's updater (Apache-2.0).
 */

export const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,299}$/;
const SERVICE_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/;
const CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
const CONTAINER_ID = /^[0-9a-f]{12,64}$/;
const BUILD_ARG_NAME = /^[A-Z][A-Z0-9_]{0,63}$/;
const BUILD_ARG_VALUE = /^[0-9A-Za-z._-]{0,128}$/;
const LABEL_KEY = /^[a-z0-9][a-z0-9._-]{0,127}$/;

export interface ComposeTarget {
  projectName: string;
  /** Files passed as `-f` (empty: Compose's own discovery). */
  files: readonly string[];
  /** The env file, when it is not `.env`. */
  envFile: string | null;
  profiles: readonly string[];
}

export interface Timeouts {
  pullSeconds: number;
  upSeconds: number;
  composeSeconds: number;
  stopSeconds: number;
}

export interface ComposeModel {
  name: string | null;
  services: Record<string, { image: string | null; profiles: string[] }>;
  volumes: Record<string, { name: string | null; external: boolean }>;
  networks: Record<string, { name: string | null }>;
}

export interface EngineVersion {
  serverVersion: string | null;
  apiVersion: string | null;
}

export interface EngineInfo {
  architecture: Platform | null;
  imageStore: "classic" | "containerd" | null;
}

export interface ContainerInfo {
  id: string;
  /** The image ID the container runs. */
  imageId: string;
  /** The image reference the container was created from. */
  imageRef: string;
  labels: Record<string, string>;
  publishedPorts: string[];
  /** Destination -> named volume (or bind source). */
  mounts: { destination: string; type: string; name: string | null; source: string | null }[];
  state: string;
}

/** Map `docker info` architecture names to the platforms of release.json. */
export function platformOf(architecture: string | null | undefined): Platform | null {
  switch ((architecture ?? "").toLowerCase()) {
    case "x86_64":
    case "amd64":
      return "linux/amd64";
    case "aarch64":
    case "arm64":
      return "linux/arm64";
    default:
      return null;
  }
}

/**
 * Classify a pull failure (design 5.3 fetch 3). Access problems are never
 * "not found", even when a registry words them so for private repositories it
 * hides; a definite unknown manifest is `image_not_found`.
 *
 *   classic store:     `manifest for <ref> not found: manifest unknown`
 *   containerd store:  `failed to resolve reference "<ref>": <ref>: not found`
 */
export function classifyPullFailure(text: string): PullFailureKind {
  if (/toomanyrequests|rate limit|too many requests|\b429\b/i.test(text)) {
    return "registry_rate_limited";
  }
  if (
    /denied|unauthorized|forbidden|requires 'docker login'|authentication required|\b401\b|\b403\b/i.test(
      text,
    )
  ) {
    return "registry_unauthorized";
  }
  if (
    /manifest unknown|manifest for .+ not found|no such manifest|not found: manifest|name unknown/i.test(
      text,
    ) ||
    /failed to resolve reference .+: not found\s*$/i.test(text.trim())
  ) {
    return "image_not_found";
  }
  if (
    /no such host|dial tcp|i\/o timeout|connection refused|connection reset|tls:|x509|certificate|network is unreachable|context deadline exceeded|EOF$/i.test(
      text,
    )
  ) {
    return "registry_unreachable";
  }
  return "pull_failed";
}

/** `docker compose ps --format json`: a JSON array (older Compose) or one object per line (newer). */
export function parseComposePs(output: string): ServiceState[] {
  const text = output.trim();
  if (!text) {
    return [];
  }
  let entries: unknown[];
  try {
    const parsed = JSON.parse(text) as unknown;
    entries = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    entries = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) {
        continue;
      }
      try {
        entries.push(JSON.parse(line));
      } catch {
        throw new OpsError("Reading the service states failed.", "The output was not valid JSON.");
      }
    }
  }
  const states: ServiceState[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const service = record.Service;
    const state = record.State;
    if (typeof service !== "string" || typeof state !== "string") {
      continue;
    }
    states.push({
      service,
      state: state.toLowerCase(),
      health:
        typeof record.Health === "string" && record.Health ? record.Health.toLowerCase() : null,
      exitCode: typeof record.ExitCode === "number" ? record.ExitCode : null,
      image: typeof record.Image === "string" ? record.Image : null,
    });
  }
  return states;
}

function assertImageReference(image: string): void {
  if (!IMAGE_REFERENCE.test(image)) {
    throw new OpsError("The image reference is not valid.");
  }
}

function assertServices(services: readonly string[]): void {
  if (services.length === 0 || services.some((service) => !SERVICE_NAME.test(service))) {
    throw new OpsError("A service name is not valid.");
  }
}

/** The parts of `docker container inspect` the sidecar reads. */
interface InspectedContainer {
  Id?: string;
  Image?: string;
  Config?: { Image?: string; Labels?: Record<string, string> | null };
  NetworkSettings?: { Ports?: Record<string, unknown> | null };
  HostConfig?: { PortBindings?: Record<string, unknown> | null };
  Mounts?: Record<string, unknown>[];
  State?: { Status?: string };
}

export interface CliDockerOptions {
  runner: CommandRunner;
  redactor: Redactor;
  compose: ComposeTarget;
  timeouts: Timeouts;
}

export class CliDocker implements DockerOps {
  constructor(private readonly options: CliDockerOptions) {}

  // -- plumbing ---------------------------------------------------------------

  private baseCompose(): string[] {
    const { compose } = this.options;
    const args = ["compose", "-p", compose.projectName];
    for (const file of compose.files) {
      args.push("-f", file);
    }
    if (compose.envFile) {
      args.push("--env-file", compose.envFile);
    }
    for (const profile of compose.profiles) {
      args.push("--profile", profile);
    }
    return args;
  }

  compose(args: readonly string[], options: Omit<CommandSpec, "argv">): Promise<CommandResult> {
    return this.options.runner.run({
      argv: ["docker", ...this.baseCompose(), ...args],
      ...options,
    });
  }

  docker(args: readonly string[], options: Omit<CommandSpec, "argv">): Promise<CommandResult> {
    return this.options.runner.run({ argv: ["docker", ...args], ...options });
  }

  private get quick(): number {
    return this.options.timeouts.composeSeconds * 1000;
  }

  private expectSuccess(result: CommandResult, action: string): void {
    if (result.exitCode === 0) {
      return;
    }
    throw new OpsError(
      result.timedOut ? `${action} timed out.` : `${action} failed (exit code ${result.exitCode}).`,
      result.errorTail,
    );
  }

  // -- engine facts -------------------------------------------------------------

  async version(): Promise<EngineVersion> {
    const result = await this.docker(["version", "--format", "{{json .Server}}"], {
      timeoutMs: this.quick,
    });
    this.expectSuccess(result, "Reading the Docker version");
    try {
      const server = JSON.parse(result.stdout) as {
        Version?: unknown;
        ApiVersion?: unknown;
      } | null;
      return {
        serverVersion: typeof server?.Version === "string" ? server.Version : null,
        apiVersion: typeof server?.ApiVersion === "string" ? server.ApiVersion : null,
      };
    } catch {
      return { serverVersion: null, apiVersion: null };
    }
  }

  async info(): Promise<EngineInfo> {
    const result = await this.docker(["info", "--format", "{{json .}}"], {
      timeoutMs: this.quick,
      maxOutputBytes: 8 * 1024 * 1024,
    });
    this.expectSuccess(result, "Reading the Docker information");
    try {
      const info = JSON.parse(result.stdout) as {
        Architecture?: unknown;
        DriverStatus?: unknown;
        Driver?: unknown;
      };
      const status = Array.isArray(info.DriverStatus) ? JSON.stringify(info.DriverStatus) : "";
      const containerd =
        /containerd\.snapshotter|io\.containerd/i.test(status) ||
        String(info.Driver ?? "").includes("snapshotter");
      return {
        architecture: platformOf(typeof info.Architecture === "string" ? info.Architecture : null),
        imageStore: containerd ? "containerd" : "classic",
      };
    } catch {
      return { architecture: null, imageStore: null };
    }
  }

  async hostPlatform(): Promise<Platform | null> {
    return (await this.info()).architecture;
  }

  /** `docker compose config --format json`, with `env` in the process environment. */
  async composeConfig(env: Readonly<Record<string, string>> = {}): Promise<ComposeModel> {
    const result = await this.compose(["config", "--format", "json"], {
      timeoutMs: this.quick,
      env,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    this.expectSuccess(result, "Reading the Compose configuration");
    let parsed: {
      name?: unknown;
      services?: Record<string, { image?: unknown; profiles?: unknown } | undefined>;
      volumes?: Record<string, { name?: unknown; external?: unknown } | undefined>;
      networks?: Record<string, { name?: unknown } | undefined>;
    };
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      // Never quote the output: it holds the resolved environment.
      throw new OpsError(
        "Reading the Compose configuration failed.",
        "The output was not valid JSON.",
      );
    }
    const model: ComposeModel = {
      name: typeof parsed.name === "string" ? parsed.name : null,
      services: {},
      volumes: {},
      networks: {},
    };
    for (const [name, service] of Object.entries(parsed.services ?? {})) {
      model.services[name] = {
        image: typeof service?.image === "string" && service.image ? service.image : null,
        profiles: Array.isArray(service?.profiles)
          ? service.profiles.filter((p): p is string => typeof p === "string")
          : [],
      };
    }
    for (const [name, volume] of Object.entries(parsed.volumes ?? {})) {
      model.volumes[name] = {
        name: typeof volume?.name === "string" ? volume.name : null,
        external: volume?.external === true,
      };
    }
    for (const [name, network] of Object.entries(parsed.networks ?? {})) {
      model.networks[name] = { name: typeof network?.name === "string" ? network.name : null };
    }
    return model;
  }

  async composeImages(
    env: Readonly<Record<string, string>>,
  ): Promise<Record<string, string | null>> {
    const model = await this.composeConfig(env);
    return Object.fromEntries(
      Object.entries(model.services).map(([name, service]) => [name, service.image]),
    );
  }

  async inspectContainer(idOrName: string): Promise<ContainerInfo | null> {
    if (!CONTAINER_ID.test(idOrName) && !CONTAINER_NAME.test(idOrName)) {
      throw new OpsError("The container name is not valid.");
    }
    const result = await this.docker(["container", "inspect", "--format", "{{json .}}", idOrName], {
      timeoutMs: this.quick,
    });
    if (result.exitCode !== 0) {
      if (/no such (object|container)/i.test(result.errorTail)) {
        return null;
      }
      this.expectSuccess(result, "Inspecting the container");
    }
    try {
      const raw = JSON.parse(result.stdout) as InspectedContainer;
      const ports: string[] = [];
      for (const [port, bindings] of Object.entries(
        (raw.NetworkSettings?.Ports ?? {}) as Record<string, unknown>,
      )) {
        if (Array.isArray(bindings) && bindings.length > 0) {
          ports.push(port);
        }
      }
      for (const [port, bindings] of Object.entries(
        (raw.HostConfig?.PortBindings ?? {}) as Record<string, unknown>,
      )) {
        if (Array.isArray(bindings) && bindings.length > 0 && !ports.includes(port)) {
          ports.push(port);
        }
      }
      return {
        id: String(raw.Id ?? ""),
        imageId: String(raw.Image ?? ""),
        imageRef: String(raw.Config?.Image ?? ""),
        labels: (raw.Config?.Labels ?? {}) as Record<string, string>,
        publishedPorts: ports,
        mounts: Array.isArray(raw.Mounts)
          ? raw.Mounts.map((mount: Record<string, unknown>) => ({
              destination: String(mount.Destination ?? ""),
              type: String(mount.Type ?? ""),
              name: typeof mount.Name === "string" ? mount.Name : null,
              source: typeof mount.Source === "string" ? mount.Source : null,
            }))
          : [],
        state: String(raw.State?.Status ?? ""),
      };
    } catch {
      throw new OpsError("Inspecting the container failed.", "The output was not valid JSON.");
    }
  }

  /** Running containers with a label (`key=value`). */
  async containersWithLabel(key: string, value: string): Promise<string[]> {
    if (!LABEL_KEY.test(key) || !/^[A-Za-z0-9._-]{1,128}$/.test(value)) {
      throw new OpsError("The label filter is not valid.");
    }
    const result = await this.docker(
      ["ps", "-q", "--no-trunc", "--filter", `label=${key}=${value}`],
      { timeoutMs: this.quick },
    );
    this.expectSuccess(result, "Listing containers");
    return result.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => CONTAINER_ID.test(line));
  }

  // -- images -----------------------------------------------------------------

  async pull(ref: string): Promise<void> {
    assertImageReference(ref);
    const result = await this.docker(["pull", "--quiet", ref], {
      timeoutMs: this.options.timeouts.pullSeconds * 1000,
    });
    if (result.exitCode !== 0) {
      throw new PullError(
        result.timedOut ? "registry_unreachable" : classifyPullFailure(result.errorTail),
        result.errorTail,
      );
    }
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    assertImageReference(ref);
    const result = await this.docker(["image", "inspect", "--format", "{{json .}}", ref], {
      timeoutMs: this.quick,
    });
    if (result.exitCode !== 0) {
      if (/no such (image|object)/i.test(result.errorTail)) {
        return null;
      }
      this.expectSuccess(result, "Inspecting the image");
    }
    try {
      const raw = JSON.parse(result.stdout) as {
        Id?: unknown;
        RepoDigests?: unknown;
        Config?: { Labels?: unknown };
      };
      return {
        id: typeof raw.Id === "string" ? raw.Id : "",
        repoDigests: Array.isArray(raw.RepoDigests)
          ? raw.RepoDigests.filter((d): d is string => typeof d === "string")
          : [],
        labels:
          raw.Config?.Labels && typeof raw.Config.Labels === "object"
            ? (raw.Config.Labels as Record<string, string>)
            : {},
      };
    } catch {
      throw new OpsError("Inspecting the image failed.", "The output was not valid JSON.");
    }
  }

  async runningImageLabel(service: string, label: string): Promise<string | null> {
    assertServices([service]);
    const ids = await this.compose(["ps", "-q", service], { timeoutMs: this.quick });
    const id = ids.exitCode === 0 ? ids.stdout.split("\n")[0]?.trim() : undefined;
    if (!id || !CONTAINER_ID.test(id)) {
      return null;
    }
    const container = await this.inspectContainer(id).catch(() => null);
    if (!container?.imageId) {
      return null;
    }
    const image = await this.inspectImage(container.imageId).catch(() => null);
    return image?.labels[label] ?? null;
  }

  async pruneImages(input: {
    repositories: readonly string[];
    keep: readonly string[];
    keepCount: number;
  }): Promise<string[]> {
    // Images in use by any container are never removed (and `rm` without force refuses them anyway).
    const used = new Set<string>();
    const all = await this.docker(["ps", "-a", "-q", "--no-trunc"], { timeoutMs: this.quick });
    for (const id of all.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => CONTAINER_ID.test(line))) {
      const container = await this.inspectContainer(id).catch(() => null);
      if (container?.imageId) {
        used.add(container.imageId);
      }
    }
    const keepIds = new Set<string>();
    for (const ref of input.keep) {
      const image = await this.inspectImage(ref).catch(() => null);
      if (image?.id) {
        keepIds.add(image.id);
      }
    }
    const removed: string[] = [];
    for (const repository of input.repositories) {
      if (!IMAGE_REFERENCE.test(repository)) {
        continue;
      }
      const list = await this.docker(
        ["image", "ls", "--no-trunc", "--format", "{{json .}}", repository],
        { timeoutMs: this.quick },
      );
      if (list.exitCode !== 0) {
        continue;
      }
      const entries = list.stdout
        .split("\n")
        .filter((line) => line.trim())
        .map((line) => {
          try {
            return JSON.parse(line) as { ID?: string; CreatedAt?: string };
          } catch {
            return {};
          }
        })
        .filter(
          (entry): entry is { ID: string; CreatedAt?: string } => typeof entry.ID === "string",
        )
        .sort((a, b) => ((a.CreatedAt ?? "") < (b.CreatedAt ?? "") ? 1 : -1));
      const seen = new Set<string>();
      let others = 0;
      for (const entry of entries) {
        if (seen.has(entry.ID)) {
          continue;
        }
        seen.add(entry.ID);
        if (keepIds.has(entry.ID) || used.has(entry.ID)) {
          continue;
        }
        if (others < input.keepCount) {
          others += 1;
          continue;
        }
        const result = await this.docker(["image", "rm", entry.ID], { timeoutMs: this.quick });
        if (result.exitCode === 0) {
          removed.push(entry.ID);
        }
      }
    }
    return removed;
  }

  async build(spec: BuildSpec): Promise<void> {
    if (!spec.contextDir.startsWith("/") || spec.contextDir.includes("\0")) {
      throw new OpsError("The build context must be an absolute path.");
    }
    if (!IMAGE_REFERENCE.test(spec.tag) || spec.tag.includes("@")) {
      throw new OpsError("The image tag is not valid.");
    }
    const args = [
      "build",
      "--file",
      spec.dockerfile,
      "--tag",
      spec.tag,
      "--label",
      `${MANAGED_LABEL}=build`,
    ];
    if (spec.target) {
      if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(spec.target)) {
        throw new OpsError("The build target is not valid.");
      }
      args.push("--target", spec.target);
    }
    for (const [name, value] of Object.entries(spec.buildArgs)) {
      if (!BUILD_ARG_NAME.test(name) || !BUILD_ARG_VALUE.test(value)) {
        throw new OpsError("A build argument is not valid.");
      }
      args.push("--build-arg", `${name}=${value}`);
    }
    args.push(spec.contextDir);
    const result = await this.docker(args, {
      timeoutMs: 90 * 60_000,
      env: { DOCKER_BUILDKIT: "1" },
      cwd: spec.contextDir,
    });
    this.expectSuccess(result, "Building the image");
  }

  // -- services ---------------------------------------------------------------

  async stop(services: readonly string[], timeoutSeconds: number): Promise<void> {
    assertServices(services);
    const result = await this.compose(
      ["stop", "-t", String(Math.max(0, Math.floor(timeoutSeconds))), ...services],
      {
        timeoutMs: (this.options.timeouts.composeSeconds + timeoutSeconds) * 1000,
      },
    );
    this.expectSuccess(result, "Stopping services");
  }

  async up(services: readonly string[]): Promise<void> {
    assertServices(services);
    const result = await this.compose(
      ["up", "-d", "--no-deps", "--no-build", "--pull", "never", ...services],
      {
        timeoutMs: this.options.timeouts.upSeconds * 1000,
      },
    );
    this.expectSuccess(result, "Starting services");
  }

  async runOnce(spec: {
    service: string;
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    name: string;
    timeoutSeconds: number;
  }): Promise<RunOnceResult> {
    assertServices([spec.service]);
    if (!CONTAINER_NAME.test(spec.name)) {
      throw new OpsError("The container name is not valid.");
    }
    const result = await this.compose(
      ["run", "--rm", "--no-deps", "-T", "--name", spec.name, spec.service, ...spec.argv],
      {
        timeoutMs: spec.timeoutSeconds * 1000,
        env: spec.env,
        maxOutputBytes: 1024 * 1024,
      },
    );
    return {
      exitCode: result.exitCode,
      outputTail: this.options.redactor.tail(
        result.stdout.trim() ? `${result.stdout}\n${result.errorTail}` : result.errorTail,
        1500,
      ),
      timedOut: result.timedOut,
    };
  }

  async removeContainer(name: string): Promise<void> {
    if (!CONTAINER_NAME.test(name) && !CONTAINER_ID.test(name)) {
      throw new OpsError("The container name is not valid.");
    }
    const result = await this.docker(["rm", "-f", name], { timeoutMs: this.quick });
    if (result.exitCode !== 0 && !/no such container/i.test(result.errorTail)) {
      this.expectSuccess(result, "Removing a container");
    }
  }

  async serviceStates(): Promise<ServiceState[]> {
    const result = await this.compose(["ps", "-a", "--format", "json"], { timeoutMs: this.quick });
    this.expectSuccess(result, "Reading the service states");
    return parseComposePs(result.stdout);
  }

  async logsTail(service: string, lines: number): Promise<string> {
    assertServices([service]);
    const count = Math.max(1, Math.min(500, Math.floor(lines)));
    const result = await this.compose(
      ["logs", "--no-color", "--no-log-prefix", "--tail", String(count), service],
      {
        timeoutMs: this.quick,
        maxOutputBytes: 256 * 1024,
      },
    );
    if (result.exitCode !== 0) {
      return "";
    }
    return this.options.redactor.tail(
      result.stdout.trim() ? result.stdout : result.errorTail,
      1500,
    );
  }

  async removeLeftovers(): Promise<void> {
    const ids = new Set<string>();
    const managed = await this.docker(
      ["ps", "-a", "-q", "--no-trunc", "--filter", `label=${MANAGED_LABEL}=true`],
      {
        timeoutMs: this.quick,
      },
    );
    const migrate = await this.docker(
      ["ps", "-a", "-q", "--no-trunc", "--filter", "name=cicd-updater-migrate-"],
      {
        timeoutMs: this.quick,
      },
    );
    for (const result of [managed, migrate]) {
      for (const id of result.stdout.split("\n").map((line) => line.trim())) {
        if (CONTAINER_ID.test(id)) {
          ids.add(id);
        }
      }
    }
    for (const id of ids) {
      await this.removeContainer(id);
    }
  }

  // -- helpers for hooks --------------------------------------------------------

  /** `docker compose exec -T <service> <argv>`. */
  exec(
    service: string,
    argv: readonly string[],
    options: Omit<CommandSpec, "argv">,
  ): Promise<CommandResult> {
    assertServices([service]);
    return this.compose(["exec", "-T", service, ...argv], options);
  }

  /** `docker run --rm --label managed ...`. */
  run(args: readonly string[], options: Omit<CommandSpec, "argv">): Promise<CommandResult> {
    return this.docker(["run", "--rm", "--label", `${MANAGED_LABEL}=true`, ...args], options);
  }

  async volumeCreate(name: string): Promise<void> {
    if (!CONTAINER_NAME.test(name)) {
      throw new OpsError("The volume name is not valid.");
    }
    const result = await this.docker(
      ["volume", "create", "--label", `${MANAGED_LABEL}=true`, name],
      { timeoutMs: this.quick },
    );
    this.expectSuccess(result, "Creating a volume");
  }

  async volumeRemove(name: string): Promise<void> {
    if (!CONTAINER_NAME.test(name)) {
      throw new OpsError("The volume name is not valid.");
    }
    await this.docker(["volume", "rm", "-f", name], { timeoutMs: this.quick });
  }

  /** Bytes of named volumes (`docker system df -v`), for the backup size estimate. */
  async volumeSizes(): Promise<Record<string, number>> {
    const result = await this.docker(["system", "df", "-v", "--format", "{{json .Volumes}}"], {
      timeoutMs: this.quick * 2,
      maxOutputBytes: 16 * 1024 * 1024,
    });
    if (result.exitCode !== 0) {
      return {};
    }
    try {
      const volumes = JSON.parse(result.stdout) as { Name?: string; Size?: string }[];
      const sizes: Record<string, number> = {};
      for (const volume of volumes ?? []) {
        if (volume.Name) {
          sizes[volume.Name] = parseSize(volume.Size ?? "");
        }
      }
      return sizes;
    } catch {
      return {};
    }
  }
}

/** `1.5GB`, `200MB`, `12kB`, `0B` -> bytes (decimal units, as Docker prints them). */
export function parseSize(text: string): number {
  const match = /^([\d.]+)\s*([kKMGTP]?B)$/.exec(text.trim());
  if (!match) {
    return 0;
  }
  const factor: Record<string, number> = {
    B: 1,
    kB: 1e3,
    KB: 1e3,
    MB: 1e6,
    GB: 1e9,
    TB: 1e12,
    PB: 1e15,
  };
  return Math.round(Number(match[1]) * (factor[match[2] as string] ?? 1));
}

/**
 * Free bytes on the file system that holds `dir`, or its nearest existing parent
 * (the backups directory may not exist before the first backup).
 */
export async function freeBytes(dir: string): Promise<number> {
  let current = path.resolve(dir);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return Number(stats.bavail) * Number(stats.bsize);
    } catch (error) {
      const parent = path.dirname(current);
      if ((error as NodeJS.ErrnoException).code !== "ENOENT" || parent === current) {
        throw error;
      }
      current = parent;
    }
  }
}

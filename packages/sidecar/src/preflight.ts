import { constants as fsConstants, readFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type {
  BackupStore,
  Clock,
  EnvFile,
  PreflightPort,
  Redactor,
  SourceBuilder,
} from "@cicd-updater/engine";
import {
  type Blocker,
  type BlockerCode,
  type Capabilities,
  ROLE_LABEL,
  SIDECAR_ROLE,
  type UpdaterConfig,
  type Warning,
  type WarningCode,
  writableKeys,
} from "@cicd-updater/protocol";
import { type CliDocker, type ContainerInfo, freeBytes } from "./docker.js";

/**
 * Who the sidecar is (design 5.10, 5.11): its own container, found through
 * the hostname or the container ID in `/proc/self/mountinfo`, its Compose
 * labels, image, published ports and the volume mounted at the verifier's
 * work directory.
 */

export interface SelfInfo {
  container: ContainerInfo | null;
  projectName: string | null;
  workingDir: string | null;
  service: string | null;
  hasRoleLabel: boolean;
  /** The image ID (for the verifier and helper containers). */
  imageId: string | null;
  /** The image reference the container was created from. */
  imageRef: string | null;
  publishedPorts: string[];
  verifyVolume: string | null;
}

export const COMPOSE_PROJECT_LABEL = "com.docker.compose.project";
export const COMPOSE_SERVICE_LABEL = "com.docker.compose.service";
export const COMPOSE_WORKDIR_LABEL = "com.docker.compose.project.working_dir";
export const COMPOSE_FILE_CANDIDATES = [
  "compose.yaml",
  "compose.yml",
  "docker-compose.yaml",
  "docker-compose.yml",
] as const;

/** Candidate IDs of the container this process runs in. */
export function ownContainerIds(hostname: string | undefined, mountinfo: string | null): string[] {
  const ids: string[] = [];
  const fromMounts = mountinfo ? /\/containers\/([0-9a-f]{64})\//.exec(mountinfo)?.[1] : undefined;
  if (fromMounts) {
    ids.push(fromMounts);
  }
  if (hostname && /^[0-9a-f]{12,64}$/.test(hostname)) {
    ids.push(hostname);
  }
  return ids;
}

export async function inspectSelf(
  docker: CliDocker,
  workDir: string,
  env = process.env,
): Promise<SelfInfo> {
  let mountinfo: string | null = null;
  try {
    mountinfo = readFileSync("/proc/self/mountinfo", "utf8");
  } catch {
    mountinfo = null;
  }
  let container: ContainerInfo | null = null;
  for (const id of ownContainerIds(env.HOSTNAME, mountinfo)) {
    container = await docker.inspectContainer(id).catch(() => null);
    if (container) {
      break;
    }
  }
  const labels = container?.labels ?? {};
  return {
    container,
    projectName: labels[COMPOSE_PROJECT_LABEL] ?? null,
    workingDir: labels[COMPOSE_WORKDIR_LABEL] ?? null,
    service: labels[COMPOSE_SERVICE_LABEL] ?? null,
    hasRoleLabel: labels[ROLE_LABEL] === SIDECAR_ROLE,
    imageId: container?.imageId || null,
    imageRef: container?.imageRef || null,
    publishedPorts: container?.publishedPorts ?? [],
    verifyVolume:
      container?.mounts.find((mount) => mount.destination === workDir && mount.type === "volume")
        ?.name ?? null,
  };
}

/** Engine API versions compare numerically (`1.43` < `1.100`). */
export function apiAtLeast(version: string | null, minimum: string): boolean {
  if (!version) {
    return false;
  }
  const [major = 0, minor = 0] = version.split(".").map(Number);
  const [wantMajor = 0, wantMinor = 0] = minimum.split(".").map(Number);
  return major > wantMajor || (major === wantMajor && minor >= wantMinor);
}

export const MIN_API_VERSION = "1.43";
const TTL_MS = 30_000;

export interface SidecarPreflightOptions {
  config: UpdaterConfig;
  docker: CliDocker;
  envFile: EnvFile;
  backups: BackupStore;
  source: SourceBuilder;
  clock: Clock;
  redactor: Redactor;
  projectName: string;
  selfInfo: () => SelfInfo;
  protectedBackups: () => Set<string>;
}

export class SidecarPreflight implements PreflightPort {
  private cached: { at: number; value: Capabilities } | null = null;
  /** Result of the Compose probe; asked on deep checks (and the first check). */
  private probe: { unsupported: string[]; selfFollows: boolean } | null = null;

  constructor(private readonly options: SidecarPreflightOptions) {}

  invalidate(): void {
    this.cached = null;
  }

  async get(refresh = false): Promise<Capabilities> {
    const now = this.options.clock.now().getTime();
    if (!refresh && this.cached && now - this.cached.at < TTL_MS) {
      return this.cached.value;
    }
    const value = await this.check({ deep: refresh });
    this.cached = { at: this.options.clock.now().getTime(), value };
    return value;
  }

  private async composeFiles(): Promise<string[]> {
    const { config } = this.options;
    const dir = config.compose.projectDir;
    if (config.compose.files.length > 0) {
      const present: string[] = [];
      for (const file of config.compose.files) {
        if ((await fs.stat(path.join(dir, file)).catch(() => null))?.isFile()) {
          present.push(file);
        }
      }
      return present.length === config.compose.files.length ? present : [];
    }
    for (const file of COMPOSE_FILE_CANDIDATES) {
      if ((await fs.stat(path.join(dir, file)).catch(() => null))?.isFile()) {
        return [file];
      }
    }
    return [];
  }

  async check(options: { deep: boolean }): Promise<Capabilities> {
    const { config, docker, envFile, backups, redactor, clock } = this.options;
    const blockers: Blocker[] = [];
    const warnings: Warning[] = [];
    const block = (code: BlockerCode, detail: string | null = null): void => {
      blockers.push({ code, detail: detail ? redactor.oneLine(detail, 500) : null });
    };
    const warn = (code: WarningCode, detail: string | null = null): void => {
      warnings.push({ code, detail });
    };
    const self = this.options.selfInfo();

    let serverVersion: string | null = null;
    let apiVersion: string | null = null;
    let architecture: Capabilities["docker"]["architecture"] = null;
    let imageStore: Capabilities["docker"]["imageStore"] = null;
    let dockerUp = true;
    try {
      const version = await docker.version();
      serverVersion = version.serverVersion;
      apiVersion = version.apiVersion;
      if (!apiAtLeast(apiVersion, MIN_API_VERSION)) {
        block(
          "docker_too_old",
          `Engine API ${apiVersion ?? "unknown"}, ${MIN_API_VERSION} or newer required`,
        );
      }
      const info = await docker.info().catch(() => null);
      architecture = info?.architecture ?? null;
      imageStore = info?.imageStore ?? null;
    } catch (error) {
      dockerUp = false;
      block(
        "docker_unreachable",
        (error as Error & { detail?: string }).detail || (error as Error).message,
      );
    }

    const files = await this.composeFiles();
    if (files.length === 0) {
      block("compose_missing", `No Compose file in ${config.compose.projectDir}`);
    }

    let composeValid = false;
    if (dockerUp && files.length > 0) {
      try {
        await docker.composeConfig();
        composeValid = true;
      } catch (error) {
        block(
          "compose_invalid",
          (error as Error & { detail?: string }).detail || (error as Error).message,
        );
      }
    }

    if (composeValid && (options.deep || this.probe === null)) {
      try {
        const keys = writableKeys(config);
        const env: Record<string, string> = {};
        for (const key of keys) {
          env[key] = `cicd-updater-probe.invalid/${key.toLowerCase().replace(/_/g, "-")}:probe`;
        }
        const images = await docker.composeImages(env);
        const unsupported = config.services
          .filter((service) => images[service.name] !== env[service.imageVar])
          .map((service) => service.name);
        const selfService = config.self.service ?? self.service;
        const selfFollows =
          selfService !== null && Object.values(env).includes(images[selfService] ?? "");
        this.probe = { unsupported, selfFollows };
      } catch {
        this.probe = null;
      }
    }
    if (this.probe && this.probe.unsupported.length > 0) {
      block(
        "compose_unsupported",
        `Not taking their image from their key: ${this.probe.unsupported.join(", ")}`,
      );
    }
    if (this.probe?.selfFollows) {
      block(
        "updater_image_unpinned",
        "The sidecar's own service takes its image from a key the sidecar rewrites.",
      );
    }

    if (dockerUp && self.container) {
      if (self.workingDir !== null && self.workingDir !== config.compose.projectDir) {
        block(
          "project_mismatch",
          `The project runs from ${self.workingDir}, the sidecar is configured for ${config.compose.projectDir}`,
        );
      } else if (
        config.compose.projectName !== null &&
        self.projectName !== null &&
        self.projectName !== config.compose.projectName
      ) {
        block(
          "project_mismatch",
          `The project is named ${self.projectName}, the sidecar is configured for ${config.compose.projectName}`,
        );
      }
      if (self.publishedPorts.length > 0 && !config.server.allowPublishedPort) {
        block("api_exposed", `Published: ${self.publishedPorts.join(", ")}`);
      }
      try {
        const others = (await docker.containersWithLabel(ROLE_LABEL, SIDECAR_ROLE)).filter(
          (id) => id !== self.container?.id,
        );
        for (const id of others) {
          const other = await docker.inspectContainer(id).catch(() => null);
          if (other && other.labels[COMPOSE_PROJECT_LABEL] === this.options.projectName) {
            block(
              "multiple_updaters",
              `Container ${id.slice(0, 12)} is another sidecar of this project.`,
            );
            break;
          }
        }
      } catch {
        // Not being able to list containers does not block on its own.
      }
      if (!self.hasRoleLabel) {
        warn(
          "self_label_missing",
          `Add the label ${ROLE_LABEL}=${SIDECAR_ROLE} to the sidecar service.`,
        );
      }
      if (self.imageRef && !self.imageRef.includes("@sha256:")) {
        warn(
          "updater_image_not_digest_pinned",
          "Pin the sidecar image by digest (image: ...:X.Y.Z@sha256:...).",
        );
      }
    }

    try {
      await envFile.assertWritable();
    } catch (error) {
      block("env_unwritable", (error as Error).message);
    }

    try {
      await fs.access(config.state.dir, fsConstants.W_OK);
    } catch (error) {
      block(
        "state_unwritable",
        `${config.state.dir}: ${(error as NodeJS.ErrnoException).code ?? "not writable"}`,
      );
    }

    try {
      const free = await freeBytes(config.state.dir);
      if (free < config.docker.minFreeMb * 1024 * 1024) {
        block(
          "disk_space",
          `${Math.floor(free / (1024 * 1024))} MB free, ${config.docker.minFreeMb} MB required`,
        );
      }
    } catch (error) {
      block("disk_space", `Free space could not be determined: ${(error as Error).message}`);
    }

    if (
      config.trust.mode !== "none" &&
      config.trust.verifier.isolate &&
      (!self.imageId || !self.verifyVolume)
    ) {
      block(
        "verifier_unavailable",
        !self.imageId
          ? "The sidecar's own image is unknown (is it running in a container?)."
          : `No named volume is mounted at ${config.trust.verifier.workDir}.`,
      );
    }

    if (config.trust.mode === "none") {
      warn("trust_mode_none", "Signatures are not checked.");
    }
    if (config.hooks.health.type === "none") {
      warn("health_without_app_check", "Only container states are checked after an update.");
    }
    if (config.hooks.migrationProbe.type !== "none" && config.hooks.backup.type === "none") {
      warn("backup_none_with_probe", null);
    }
    if (config.source.allowlist.length > 0) {
      warn(
        "source_mode_enabled",
        this.options.source.allowed() ? null : "The feed repository is not in the allowlist.",
      );
    }

    const backupList = await backups.list(this.options.protectedBackups()).catch(() => []);
    return {
      ready: blockers.length === 0,
      blockers,
      warnings,
      docker: { serverVersion, apiVersion, architecture, imageStore },
      compose: {
        projectName: this.options.projectName,
        projectDir: config.compose.projectDir,
        files,
        envFile: config.compose.envFile,
      },
      backups: backupList,
      checkedAt: clock.now().toISOString(),
    };
  }
}

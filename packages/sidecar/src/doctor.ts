import { constants as fsConstants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { EnvFile, type Redactor } from "@cicd-updater/engine";
import { FeedReader, type FetchLike, type RemoteFeedType } from "@cicd-updater/feed";
import { ROLE_LABEL, SIDECAR_ROLE, type UpdaterConfig, writableKeys } from "@cicd-updater/protocol";
import { readTokenFile } from "./catalog.js";
import type { LoadedConfig } from "./config-file.js";
import { type CliDocker, freeBytes } from "./docker.js";
import {
  apiAtLeast,
  COMPOSE_FILE_CANDIDATES,
  MIN_API_VERSION,
  type SelfInfo,
} from "./preflight.js";

/**
 * `cicd-updater doctor` (appendix A): every prerequisite checked separately
 * and read-only, naming the file and key for each. Exit 0 when everything
 * passed, 1 when something failed, 2 when nothing could be checked.
 */

export type DoctorStatus = "ok" | "warn" | "fail" | "skip";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  detail: string;
  /** The file and key the check is about. */
  where: string;
}

export interface DoctorDeps {
  loaded: LoadedConfig;
  docker: CliDocker | null;
  self: SelfInfo | null;
  redactor: Redactor;
  /** For the Sigstore reachability check (tests replace it). */
  fetch?: typeof fetch;
  /** Replaces the guarded feed transport (tests). */
  feedFetch?: FetchLike;
}

const SIGSTORE_TUF = "https://tuf-repo-cdn.sigstore.dev/1.root.json";

export async function runDoctor(
  deps: DoctorDeps,
): Promise<{ checks: DoctorCheck[]; exitCode: number }> {
  const checks: DoctorCheck[] = [];
  const add = (name: string, status: DoctorStatus, detail: string, where: string): void => {
    checks.push({ name, status, detail: deps.redactor.oneLine(detail, 500), where });
  };
  const { loaded } = deps;
  if (!loaded.ok) {
    add(
      "configuration",
      "fail",
      loaded.problems.map((p) => `${p.path}: ${p.message}`).join("; "),
      loaded.file,
    );
    return { checks, exitCode: 2 };
  }
  add("configuration", "ok", `valid, hash ${loaded.configHash.slice(0, 12)}`, loaded.file);
  const config: UpdaterConfig = loaded.config;
  const file = loaded.file;

  // Docker
  const socket = await fs.stat(config.docker.socket).catch(() => null);
  add(
    "docker socket",
    socket?.isSocket() ? "ok" : "fail",
    socket?.isSocket()
      ? config.docker.socket
      : `${config.docker.socket} is not a socket (mount /var/run/docker.sock)`,
    `${file}: docker.socket`,
  );
  const docker = deps.docker;
  let dockerUp = false;
  if (docker) {
    try {
      const version = await docker.version();
      dockerUp = true;
      add(
        "docker engine",
        apiAtLeast(version.apiVersion, MIN_API_VERSION) ? "ok" : "fail",
        `Engine ${version.serverVersion ?? "?"}, API ${version.apiVersion ?? "?"} (${MIN_API_VERSION} or newer required)`,
        config.docker.socket,
      );
    } catch (error) {
      add("docker engine", "fail", (error as Error).message, config.docker.socket);
    }
  }

  // Compose project
  const dir = config.compose.projectDir;
  const candidates =
    config.compose.files.length > 0 ? config.compose.files : [...COMPOSE_FILE_CANDIDATES];
  const present: string[] = [];
  for (const candidate of candidates) {
    if ((await fs.stat(path.join(dir, candidate)).catch(() => null))?.isFile()) {
      present.push(candidate);
    }
  }
  add(
    "compose files",
    present.length > 0 ? "ok" : "fail",
    present.length > 0 ? present.join(", ") : `none of ${candidates.join(", ")} in ${dir}`,
    `${file}: compose.projectDir, compose.files`,
  );
  if (docker && dockerUp && present.length > 0) {
    try {
      const keys = writableKeys(config);
      const env = Object.fromEntries(
        keys.map((key) => [
          key,
          `cicd-updater-probe.invalid/${key.toLowerCase().replace(/_/g, "-")}:probe`,
        ]),
      );
      const images = await docker.composeImages(env);
      const unsupported = config.services
        .filter((service) => images[service.name] !== env[service.imageVar])
        .map((s) => s.name);
      add(
        "compose configuration",
        unsupported.length === 0 ? "ok" : "fail",
        unsupported.length === 0
          ? "every managed service takes its image from its key"
          : `not taking the image from their key: ${unsupported.join(", ")} (use image: \${KEY})`,
        `${file}: services[].imageVar`,
      );
    } catch (error) {
      add(
        "compose configuration",
        "fail",
        (error as Error & { detail?: string }).detail || (error as Error).message,
        dir,
      );
    }
  }

  // Env file and state volume
  const envPath = path.join(dir, config.compose.envFile);
  try {
    await new EnvFile(envPath, writableKeys(config)).assertWritable();
    add("env file", "ok", `${envPath} is writable`, `${file}: compose.envFile`);
  } catch (error) {
    add("env file", "fail", (error as Error).message, `${file}: compose.envFile`);
  }
  try {
    await fs.access(config.state.dir, fsConstants.W_OK);
    add("state volume", "ok", `${config.state.dir} is writable`, `${file}: state.dir`);
  } catch {
    add(
      "state volume",
      "fail",
      `${config.state.dir} is not writable (mount a volume)`,
      `${file}: state.dir`,
    );
  }
  try {
    const free = await freeBytes(config.state.dir);
    const needed = config.docker.minFreeMb * 1024 * 1024;
    add(
      "disk space",
      free >= needed ? "ok" : "fail",
      `${Math.floor(free / (1024 * 1024))} MB free, ${config.docker.minFreeMb} MB required`,
      `${file}: docker.minFreeMb`,
    );
  } catch (error) {
    add("disk space", "fail", (error as Error).message, config.state.dir);
  }

  // Own container
  const self = deps.self;
  if (!self?.container) {
    add("own container", "skip", "not running in a container (or Docker not reachable)", "");
  } else {
    add(
      "own labels",
      self.hasRoleLabel ? "ok" : "warn",
      self.hasRoleLabel
        ? `${ROLE_LABEL}=${SIDECAR_ROLE}`
        : `add the label ${ROLE_LABEL}=${SIDECAR_ROLE}`,
      "docker-compose.yml: services.<sidecar>.labels",
    );
    add(
      "own image pinned",
      self.imageRef?.includes("@sha256:") ? "ok" : "warn",
      self.imageRef ?? "unknown",
      "docker-compose.yml: services.<sidecar>.image",
    );
    add(
      "published ports",
      self.publishedPorts.length === 0 || config.server.allowPublishedPort ? "ok" : "fail",
      self.publishedPorts.length === 0 ? "none" : self.publishedPorts.join(", "),
      `docker-compose.yml: services.<sidecar>.ports; ${file}: server.allowPublishedPort`,
    );
    add(
      "project directory",
      self.workingDir === null || self.workingDir === config.compose.projectDir ? "ok" : "fail",
      `container label ${self.workingDir ?? "unknown"}, configured ${config.compose.projectDir}`,
      `${file}: compose.projectDir`,
    );
    if (config.trust.mode !== "none" && config.trust.verifier.isolate) {
      add(
        "verifier volume",
        self.verifyVolume ? "ok" : "fail",
        self.verifyVolume ?? `no named volume at ${config.trust.verifier.workDir}`,
        `${file}: trust.verifier.workDir`,
      );
    }
  }

  // Feed
  const feed = config.release.feed;
  if (feed.type === "file") {
    const index = await fs.stat(path.join(feed.path as string, "index.json")).catch(() => null);
    add(
      "release feed",
      index?.isFile() ? "ok" : "fail",
      `${feed.path}/index.json`,
      `${file}: release.feed.path`,
    );
  } else {
    try {
      const token = await readTokenFile(feed.tokenFile, deps.redactor);
      const reader = new FeedReader({
        source: { type: feed.type as RemoteFeedType, url: feed.url as string },
        token,
        tagPattern: config.release.tagPattern,
        allowPrivateHosts: feed.allowPrivateNetwork ? [new URL(feed.url as string).hostname] : [],
        fetch: deps.feedFetch,
      });
      const entries = await reader.list();
      add(
        "release feed",
        "ok",
        `${entries.length} releases, newest ${entries[0]?.version ?? "-"}${token ? " (with token)" : ""}`,
        `${file}: release.feed`,
      );
    } catch (error) {
      const code = (error as { code?: string }).code;
      add(
        "release feed",
        "fail",
        code === "not_found"
          ? "not found (for a private repository: the token has no access)"
          : `${code ?? (error as Error).message}`,
        `${file}: release.feed.url, release.feed.tokenFile`,
      );
    }
  }

  // Registry access per managed repository (a manifest read, not just a login)
  if (docker && dockerUp && present.length > 0) {
    try {
      const images = await docker.composeImages({});
      const refs = [
        ...new Set(
          config.services
            .map((service) => images[service.name])
            .filter((ref): ref is string => !!ref),
        ),
      ];
      for (const ref of refs) {
        const result = await docker.docker(["buildx", "imagetools", "inspect", "--raw", ref], {
          timeoutMs: 60_000,
          maxOutputBytes: 4 * 1024 * 1024,
        });
        add(
          "registry access",
          result.exitCode === 0 ? "ok" : "fail",
          result.exitCode === 0 ? `${ref}: manifest readable` : `${ref}: ${result.errorTail}`,
          `${file}: docker.registryAuthFile`,
        );
      }
    } catch (error) {
      add("registry access", "skip", (error as Error).message, "");
    }
  }

  // Trust
  if (config.trust.mode === "keyless") {
    const root = config.trust.keyless?.trustedRootFile;
    if (root) {
      const readable = await fs.access(root, fsConstants.R_OK).then(
        () => true,
        () => false,
      );
      add(
        "sigstore trusted root",
        readable ? "ok" : "fail",
        root,
        `${file}: trust.keyless.trustedRootFile`,
      );
    } else {
      try {
        const response = await (deps.fetch ?? fetch)(SIGSTORE_TUF, {
          signal: AbortSignal.timeout(10_000),
        });
        add(
          "sigstore",
          response.ok ? "ok" : "fail",
          `${SIGSTORE_TUF}: HTTP ${response.status}`,
          `${file}: trust.mode`,
        );
      } catch (error) {
        add(
          "sigstore",
          "fail",
          `${SIGSTORE_TUF}: ${(error as Error).message}`,
          `${file}: trust.keyless.trustedRootFile`,
        );
      }
    }
  } else if (config.trust.mode === "key") {
    for (const keyFile of config.trust.key?.publicKeyFiles ?? []) {
      const text = await fs.readFile(keyFile, "utf8").catch(() => null);
      add(
        "public key",
        text?.includes("-----BEGIN PUBLIC KEY-----") ? "ok" : "fail",
        text === null ? `${keyFile} cannot be read` : keyFile,
        `${file}: trust.key.publicKeyFiles`,
      );
    }
  } else {
    add("trust mode", "warn", "none: signatures are not checked", `${file}: trust.mode`);
  }

  const failed = checks.some((check) => check.status === "fail");
  const checked = checks.some((check) => check.status === "ok" || check.status === "warn");
  return { checks, exitCode: failed ? 1 : checked ? 0 : 2 };
}

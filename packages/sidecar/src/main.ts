import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  BackupStore,
  EnvFile,
  type Logger,
  Redactor,
  ReleaseService,
  RunningVersionResolver,
  StatusStore,
  systemClock,
  UpdateEngine,
} from "@cicd-updater/engine";
import { checkFeed } from "@cicd-updater/feed";
import { isNewer, type UpdaterConfig, writableKeys } from "@cicd-updater/protocol";
import { serve as serveHttp } from "@hono/node-server";
import { getConnInfo } from "@hono/node-server/conninfo";
import { hostname, loadOrCreateToken, readOperatorToken, TokenError } from "./auth.js";
import { DockerBackupRunner } from "./backup.js";
import { SidecarCatalog } from "./catalog.js";
import { formatProblems, loadConfig } from "./config-file.js";
import { CliDocker } from "./docker.js";
import { SidecarHooks } from "./hooks.js";
import { StateLock, StateLockedError } from "./lock.js";
import { consoleLogger } from "./logger.js";
import { maintenanceFiles } from "./maintenance.js";
import { inspectSelf, type SelfInfo, SidecarPreflight } from "./preflight.js";
import { LocalRunner } from "./runner.js";
import { buildServer } from "./server.js";
import { ArchiveSourceBuilder } from "./source.js";
import { CosignVerifier } from "./verifier.js";
import { SIDECAR_VERSION } from "./version.js";

/**
 * `cicd-updater serve`: the sidecar process (design 2.3). Exit codes: 64 for
 * an invalid configuration, 75 when another sidecar holds the state lock.
 */

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: Io = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** The Compose project name from the configuration, the own label, or the directory name. */
export function projectNameOf(config: UpdaterConfig, self: SelfInfo | null): string {
  const fromDir = path
    .basename(config.compose.projectDir)
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "");
  return config.compose.projectName ?? self?.projectName ?? (fromDir || "project");
}

/**
 * Remove what verifications interrupted by a restart left in the verifier's work
 * directory (design 5.8). Only the sidecar's own `v-<time>-<random>` directories.
 */
export async function clearVerifyDir(dir: string): Promise<number> {
  let removed = 0;
  for (const entry of await fs.readdir(dir).catch(() => [] as string[])) {
    if (/^v-\d+-[0-9a-f]{8}$/.test(entry)) {
      await fs.rm(path.join(dir, entry), { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}

/** Point the Docker CLI at the operator's registry credentials without copying them. */
export async function registryConfigDir(config: UpdaterConfig): Promise<string | null> {
  const file = config.docker.registryAuthFile;
  if (!file) {
    return null;
  }
  const raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  if (raw.credsStore !== undefined || raw.credHelpers !== undefined) {
    throw new Error(`${file} uses credsStore/credHelpers; only an auths object is supported.`);
  }
  const dir = path.join(config.state.dir, "docker-config");
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const link = path.join(dir, "config.json");
  await fs.rm(link, { force: true });
  await fs.symlink(file, link);
  return dir;
}

async function readInstanceId(stateDir: string): Promise<string> {
  try {
    const raw = JSON.parse(await fs.readFile(path.join(stateDir, "status.json"), "utf8")) as {
      instanceId?: unknown;
    };
    return typeof raw.instanceId === "string" ? raw.instanceId : "new";
  } catch {
    return "new";
  }
}

export async function serve(
  env: Readonly<Record<string, string | undefined>> = process.env,
  io: Io = consoleIo,
): Promise<number> {
  const loaded = await loadConfig(env);
  if (!loaded.ok) {
    io.err(formatProblems(loaded.file, loaded.problems));
    return 64;
  }
  const { config, configHash } = loaded;
  const redactor = new Redactor(config.logging.redactPatterns);
  const logger: Logger = consoleLogger({
    redactor,
    level: config.logging.level,
    format: config.logging.format,
  });
  logger.info(
    `cicd-updater ${SIDECAR_VERSION} starting (config ${configHash.slice(0, 12)}${loaded.overrides.length ? `, overrides ${loaded.overrides.join(", ")}` : ""}).`,
  );

  await fs.mkdir(config.state.dir, { recursive: true, mode: 0o700 });
  let lock: StateLock;
  try {
    lock = await StateLock.acquire({
      stateDir: config.state.dir,
      instanceId: await readInstanceId(config.state.dir),
      hostname: hostname(),
      logger,
    });
  } catch (error) {
    if (error instanceof StateLockedError) {
      io.err(`cicd-updater: ${error.message}`);
      return 75;
    }
    throw error;
  }
  lock.startHeartbeat((error) => logger.warn(`Could not refresh the state lock: ${error.message}`));

  let token: string;
  try {
    token = config.auth.tokenFile
      ? await readOperatorToken(config.auth.tokenFile)
      : await loadOrCreateToken(config.auth.sharedDir, config.auth.tokenGroupId, logger);
  } catch (error) {
    await lock.release();
    if (error instanceof TokenError) {
      io.err(`cicd-updater: ${error.message}`);
      return 64;
    }
    throw error;
  }
  redactor.add(token);

  const store = await StatusStore.open(config.state.dir, logger, () => new Date(), config.state);
  await clearVerifyDir(config.trust.verifier.workDir);
  let dockerConfig: string | null = null;
  try {
    dockerConfig = await registryConfigDir(config);
  } catch (error) {
    io.err(`cicd-updater: docker.registryAuthFile: ${(error as Error).message}`);
    await lock.release();
    return 64;
  }
  const runner = new LocalRunner({
    redactor,
    cwd: config.compose.projectDir,
    fixedEnv: {
      DOCKER_HOST: `unix://${config.docker.socket}`,
      ...(dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {}),
    },
  });
  const composeTarget = (projectName: string) => ({
    projectName,
    files: config.compose.files,
    envFile: config.compose.envFile === ".env" ? null : config.compose.envFile,
    profiles: config.compose.profiles,
  });
  const timeouts = {
    pullSeconds: config.timeouts.pullSeconds,
    upSeconds: config.timeouts.upSeconds,
    composeSeconds: config.timeouts.composeSeconds,
    stopSeconds: config.timeouts.stopSeconds,
  };
  const probeDocker = new CliDocker({
    runner,
    redactor,
    compose: composeTarget(config.compose.projectName ?? "probe"),
    timeouts,
  });
  let self: SelfInfo = await inspectSelf(probeDocker, config.trust.verifier.workDir).catch(() => ({
    container: null,
    projectName: null,
    workingDir: null,
    service: null,
    hasRoleLabel: false,
    imageId: null,
    imageRef: null,
    publishedPorts: [],
    verifyVolume: null,
  }));
  const projectName = projectNameOf(config, self);
  const selfService = config.self.service ?? self.service;
  const docker = new CliDocker({ runner, redactor, compose: composeTarget(projectName), timeouts });
  const envFile = new EnvFile(
    path.join(config.compose.projectDir, config.compose.envFile),
    writableKeys(config),
  );
  const backups = new BackupStore(path.join(config.state.dir, "backups"), projectName);
  const hooks = new SidecarHooks({ config, docker, redactor, token: () => token });
  const catalog = new SidecarCatalog({
    config,
    stateDir: config.state.dir,
    redactor,
    logger,
    now: () => new Date(),
  });
  const verifier = new CosignVerifier({
    config,
    runner,
    docker,
    redactor,
    logger,
    selfImage: () => self.imageId,
    verifyVolume: () => self.verifyVolume,
  });
  const source = new ArchiveSourceBuilder({
    config,
    stateDir: config.state.dir,
    projectName,
    docker,
    redactor,
    logger,
    project: catalog.project,
    archiveUrl: (tag) => catalog.archiveUrl(tag),
  });
  const backup = new DockerBackupRunner({
    config,
    docker,
    runner,
    hooks,
    store: backups,
    envFile,
    redactor,
    logger,
    stateDir: config.state.dir,
    projectName,
    selfImage: () => self.imageId,
  });
  const running = new RunningVersionResolver({
    config,
    hooks,
    ops: docker,
    store,
    envFile,
    clock: systemClock,
  });
  const releases = new ReleaseService({
    config,
    catalog,
    verifier,
    ops: docker,
    envFile,
    running,
    updaterVersion: SIDECAR_VERSION,
    clock: systemClock,
    redactor,
  });
  let engine: UpdateEngine | null = null;
  const preflight = new SidecarPreflight({
    config,
    docker,
    envFile,
    backups,
    source,
    clock: systemClock,
    redactor,
    projectName,
    selfInfo: () => self,
    protectedBackups: () => engine?.protectedBackups() ?? new Set(),
  });
  engine = new UpdateEngine({
    config,
    configHash,
    updaterVersion: SIDECAR_VERSION,
    project: { name: projectName, selfService },
    store,
    ops: docker,
    hooks,
    backup,
    backups,
    verifier,
    catalog,
    releases,
    source,
    envFile,
    preflight,
    running,
    clock: systemClock,
    redactor,
    logger,
  });
  await engine.init();

  let latestAvailable: string | null = null;
  const selfCheck = async (): Promise<void> => {
    const result = await checkFeed({
      feed: { type: "github", url: "https://github.com/restow-backup/cicd-updater" },
      channel: "stable",
      running: SIDECAR_VERSION,
      resolveDocuments: 0,
    });
    if (result.ok && result.latest && isNewer(SIDECAR_VERSION, result.latest.version)) {
      latestAvailable = result.latest.version;
    }
  };
  let maintenanceCache: Awaited<ReturnType<typeof maintenanceFiles>> | null = null;
  const app = buildServer({
    config,
    configHash,
    updaterVersion: SIDECAR_VERSION,
    engine,
    preflight,
    releases,
    running,
    backups,
    source,
    token: () => token,
    now: () => new Date(),
    logger,
    redactor,
    latestAvailable: () => latestAvailable,
    maintenance: async () => {
      maintenanceCache ??= await maintenanceFiles(config);
      return maintenanceCache;
    },
    remoteAddress: (c) => {
      try {
        return getConnInfo(c).remote.address ?? null;
      } catch {
        return null;
      }
    },
  });

  const [host, portText] = splitListen(config.server.listen);
  const server = serveHttp({ fetch: app.fetch, hostname: host, port: Number(portText) });
  logger.info(
    `Listening on ${config.server.listen} (project ${projectName}, ${config.services.length} managed services, trust mode ${config.trust.mode}).`,
  );

  const timers: ReturnType<typeof setInterval>[] = [];
  const daily = 24 * 3600 * 1000;
  timers.push(setInterval(() => void engine?.housekeeping(), daily));
  if (config.selfCheck.enabled) {
    void selfCheck().catch(() => undefined);
    timers.push(setInterval(() => void selfCheck().catch(() => undefined), daily));
  }
  if (config.release.checkIntervalHours > 0) {
    timers.push(
      setInterval(
        () => void catalog.list(true).catch(() => undefined),
        config.release.checkIntervalHours * 3600 * 1000,
      ),
    );
  }
  // Re-inspect the own container now and then (labels and mounts do not change, ports may).
  timers.push(
    setInterval(
      () => {
        void inspectSelf(probeDocker, config.trust.verifier.workDir)
          .then((info) => {
            self = info;
          })
          .catch(() => undefined);
      },
      10 * 60 * 1000,
    ),
  );
  for (const timer of timers) {
    timer.unref?.();
  }

  return await new Promise<number>((resolve) => {
    let stopping = false;
    const stop = (signal: string): void => {
      if (stopping) {
        return;
      }
      stopping = true;
      logger.info(`${signal} received; stopping.`);
      for (const timer of timers) {
        clearInterval(timer);
      }
      const force = setTimeout(() => resolve(0), 8000);
      force.unref?.();
      void (async () => {
        await engine?.shutdown().catch(() => undefined);
        await new Promise<void>((done) => server.close(() => done()));
        await lock.release();
        clearTimeout(force);
        resolve(0);
      })();
    };
    process.once("SIGTERM", () => stop("SIGTERM"));
    process.once("SIGINT", () => stop("SIGINT"));
  });
}

export function splitListen(listen: string): [string, string] {
  const index = listen.lastIndexOf(":");
  const host = listen.slice(0, index).replace(/^\[|\]$/g, "");
  return [host, listen.slice(index + 1)];
}

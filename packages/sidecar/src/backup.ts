import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createGunzip } from "node:zlib";
import {
  BackupError,
  type BackupRecord,
  type BackupRunner,
  type BackupStore,
  type EnvFile,
  envValueOf,
  type Logger,
  type Redactor,
} from "@cicd-updater/engine";
import type { BackupType, UpdaterConfig } from "@cicd-updater/protocol";
import { type CliDocker, freeBytes } from "./docker.js";
import { type SidecarHooks, scriptArgv } from "./hooks.js";
import type { CommandResult, CommandRunner } from "./runner.js";

/**
 * Backups before the update (design 5.3 backup, 5.14): PostgreSQL
 * (`pg_dump -Fc` in the database container), MySQL/MariaDB (dump in the
 * database container, gzip in the sidecar), volume archives (a one-off
 * container of the sidecar image with the volumes read-only), and a custom
 * command (a digest-pinned image writing into `/backup`). Every backup is
 * written as `<name>.partial`, hashed and counted while writing, verified,
 * optionally encrypted with age, and only then renamed; a failed or aborted
 * backup leaves nothing behind.
 */

/** PostgreSQL dump (args: user or "", database or "", lock wait seconds, application name). */
export const POSTGRES_DUMP_SCRIPT = [
  'u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"',
  'PGAPPNAME="$4" exec pg_dump -U "$u" -d "$d" -Fc --lock-wait-timeout="${3}s"',
].join("\n");

/** Terminate the backends of one application name (args: user or "", database or "", application name). */
export const POSTGRES_TERMINATE_SCRIPT = [
  'u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"',
  'printf \'%s\\n\' "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = :\'app\';" | exec psql -X -q -v ON_ERROR_STOP=1 -v app="$3" -U "$u" -d "$d"',
].join("\n");

/** MySQL/MariaDB dump (args: user or "", database or "", lock wait seconds (unused), tool or "auto"). */
export const MYSQL_DUMP_SCRIPT = [
  'if [ -n "$1" ]; then u="$1"; p="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}";',
  'else u=root; p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; fi',
  'd="${2:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"',
  't="$4"; if [ "$t" = auto ]; then if command -v mariadb-dump >/dev/null 2>&1; then t=mariadb-dump; else t=mysqldump; fi; fi',
  'MYSQL_PWD="$p" exec "$t" -u "$u" --single-transaction --routines --triggers --events "$d"',
].join("\n");

const MiB = 1024 * 1024;

export interface DockerBackupOptions {
  config: UpdaterConfig;
  docker: CliDocker;
  runner: CommandRunner;
  hooks: SidecarHooks;
  store: BackupStore;
  envFile: EnvFile;
  redactor: Redactor;
  logger: Logger;
  stateDir: string;
  projectName: string;
  /** The sidecar's own image ID (for volume archives and copying command output). */
  selfImage: () => string | null;
  /** Free bytes on the file system of a directory (tests replace it). */
  freeSpace?: (dir: string) => Promise<number>;
}

export class DockerBackupRunner implements BackupRunner {
  readonly type: BackupType;
  readonly interruptible: boolean;

  constructor(private readonly options: DockerBackupOptions) {
    this.type = options.config.hooks.backup.type;
    this.interruptible = this.type === "postgres";
  }

  private get settings(): UpdaterConfig["hooks"]["backup"] {
    return this.options.config.hooks.backup;
  }

  async create(input: Parameters<BackupRunner["create"]>[0]): Promise<BackupRecord> {
    const { store, logger } = this.options;
    if (this.type === "none") {
      throw new BackupError("failed", "No backup is configured.");
    }
    await store.ensureDirectory();
    const encrypted = this.settings.encryption.ageRecipients.length > 0;
    const name = store.fileName(input.at, input.fromVersion, input.toVersion, this.type, false);
    const partial = store.partialPathOf(name);
    const plain = store.pathOf(name);
    const finalName = encrypted ? `${name}.age` : name;
    const cleanup = async (): Promise<void> => {
      for (const file of [partial, plain, `${plain}.age`, `${plain}.age.partial`]) {
        await fs.rm(file, { force: true }).catch(() => undefined);
      }
    };
    try {
      await this.checkSpace();
      let written: { bytes: number; sha256: string };
      switch (this.type) {
        case "postgres":
          written = await this.dumpPostgres(partial, input.runId, input.signal);
          break;
        case "mysql":
          written = await this.dumpMysql(partial);
          break;
        case "volume":
          written = await this.archiveVolumes(partial);
          break;
        case "command":
          written = await this.runCommand(partial, input.runId);
          break;
      }
      if (written.bytes === 0) {
        throw new BackupError("verify_failed", "The backup is empty.");
      }
      await input.onStage("verifying");
      await this.verify(partial);
      await fs.rename(partial, plain);
      let record: BackupRecord = {
        file: name,
        bytes: written.bytes,
        sha256: written.sha256,
        type: this.type,
        encrypted: false,
      };
      if (encrypted) {
        await input.onStage("encrypting");
        record = await this.encrypt(name);
      }
      await store.writeMetadata(record.file, {
        type: this.type,
        bytes: record.bytes,
        sha256: record.sha256,
        createdAt: input.at.toISOString(),
        runId: input.runId,
        fromVersion: input.fromVersion,
        toVersion: input.toVersion,
        verified: true,
        encrypted: record.encrypted,
      });
      if (record.file !== finalName) {
        logger.warn(`Unexpected backup name ${record.file}.`);
      }
      return record;
    } catch (error) {
      await cleanup();
      if (error instanceof BackupError) {
        throw error;
      }
      throw new BackupError(
        "failed",
        this.options.redactor.oneLine((error as Error).message, 1000),
      );
    }
  }

  // -- space ------------------------------------------------------------------

  private async estimate(): Promise<number | null> {
    const { hooks, docker } = this.options;
    const settings = this.settings;
    try {
      if (this.type === "postgres") {
        const text = await hooks.query(
          "postgres",
          { service: settings.service as string, user: settings.user, database: settings.database },
          "SELECT pg_database_size(current_database())",
          60,
        );
        return Number(text.trim()) || null;
      }
      if (this.type === "mysql") {
        const text = await hooks.query(
          "mysql",
          { service: settings.service as string, user: settings.user, database: settings.database },
          "SELECT coalesce(sum(data_length + index_length), 0) FROM information_schema.tables WHERE table_schema = DATABASE()",
          60,
        );
        return Number(text.trim()) || null;
      }
      if (this.type === "volume") {
        const sizes = await docker.volumeSizes();
        const names = await this.volumeNames();
        return names.reduce((sum, volume) => sum + (sizes[volume.name] ?? 0), 0);
      }
    } catch (error) {
      this.options.logger.warn(
        `The backup size could not be estimated: ${(error as Error).message}`,
      );
    }
    return null;
  }

  /**
   * The estimate must fit the file system the backup is written to: the backups
   * directory, which may be a separate volume mounted at `<state.dir>/backups`.
   */
  private async checkSpace(): Promise<void> {
    const minFree = this.options.config.docker.minFreeMb * MiB;
    const directory = this.options.store.directory;
    const free = await (this.options.freeSpace ?? freeBytes)(directory);
    const estimate = await this.estimate();
    const needed = Math.ceil((estimate ?? 0) * 1.25) + minFree;
    if (free < needed) {
      throw new BackupError(
        "insufficient_space",
        `${Math.floor(free / MiB)} MB free in ${directory}, ${Math.ceil(needed / MiB)} MB needed (estimate ${estimate === null ? "unknown" : `${Math.ceil(estimate / MiB)} MB`} x 1.25 + docker.minFreeMb).`,
      );
    }
  }

  // -- PostgreSQL ---------------------------------------------------------------

  private async dumpPostgres(
    file: string,
    runId: string,
    signal: AbortSignal,
  ): Promise<{ bytes: number; sha256: string }> {
    const { docker, hooks } = this.options;
    const settings = this.settings;
    const service = settings.service as string;
    const application = `cicd-updater-backup-${runId}`;
    const wrapped = (await hooks.hasTimeout(service)) ? settings.timeoutSeconds : null;
    const result = await docker.exec(
      service,
      scriptArgv(
        POSTGRES_DUMP_SCRIPT,
        [
          settings.user ?? "",
          settings.database ?? "",
          String(settings.lockWaitSeconds),
          application,
        ],
        wrapped,
      ),
      { timeoutMs: (settings.timeoutSeconds + 30) * 1000, stdoutFile: file, signal },
    );
    if (result.exitCode !== 0 || result.timedOut || result.aborted) {
      // Killing the client does not stop the dump inside the container: end exactly its backends.
      await this.terminatePostgres(application);
      if (result.aborted) {
        throw new BackupError(
          "aborted",
          "The PostgreSQL dump was aborted; its backends were terminated.",
        );
      }
      throw new BackupError(result.timedOut ? "timeout" : "failed", result.errorTail);
    }
    return result.written ?? { bytes: 0, sha256: "" };
  }

  private async terminatePostgres(application: string): Promise<void> {
    const settings = this.settings;
    const result = await this.options.docker
      .exec(
        settings.service as string,
        scriptArgv(
          POSTGRES_TERMINATE_SCRIPT,
          [settings.user ?? "", settings.database ?? "", application],
          null,
        ),
        {
          timeoutMs: 60_000,
        },
      )
      .catch(() => null);
    if (result?.exitCode !== 0) {
      this.options.logger.warn(`Could not terminate the backends of ${application}.`);
    }
  }

  // -- MySQL / MariaDB ------------------------------------------------------------

  private async dumpMysql(file: string): Promise<{ bytes: number; sha256: string }> {
    const { docker, hooks } = this.options;
    const settings = this.settings;
    const service = settings.service as string;
    const tool =
      settings.flavor === "mysql"
        ? "mysqldump"
        : settings.flavor === "mariadb"
          ? "mariadb-dump"
          : "auto";
    const wrapped = (await hooks.hasTimeout(service)) ? settings.timeoutSeconds : null;
    const result = await docker.exec(
      service,
      scriptArgv(
        MYSQL_DUMP_SCRIPT,
        [settings.user ?? "", settings.database ?? "", String(settings.lockWaitSeconds), tool],
        wrapped,
      ),
      { timeoutMs: (settings.timeoutSeconds + 30) * 1000, stdoutFile: file, gzipStdout: true },
    );
    if (result.exitCode !== 0 || result.timedOut) {
      throw new BackupError(result.timedOut ? "timeout" : "failed", result.errorTail);
    }
    return result.written ?? { bytes: 0, sha256: "" };
  }

  // -- volumes --------------------------------------------------------------------

  private async volumeNames(): Promise<{ key: string; name: string }[]> {
    const model = await this.options.docker.composeConfig();
    return this.settings.volumes.map((key) => ({
      key,
      name: model.volumes[key]?.name ?? `${this.options.projectName}_${key}`,
    }));
  }

  private async archiveVolumes(file: string): Promise<{ bytes: number; sha256: string }> {
    const image = this.options.selfImage();
    if (!image) {
      throw new BackupError(
        "failed",
        "The sidecar's own image is unknown; volume archives need it.",
      );
    }
    const args = [
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
    ];
    for (const volume of await this.volumeNames()) {
      args.push("--volume", `${volume.name}:/backup-src/${volume.key}:ro`);
    }
    args.push("--entrypoint", "tar", image, "-czf", "-", "-C", "/backup-src", ".");
    const result = await this.options.docker.run(args, {
      timeoutMs: this.settings.timeoutSeconds * 1000,
      stdoutFile: file,
    });
    if (result.exitCode !== 0 || result.timedOut) {
      throw new BackupError(result.timedOut ? "timeout" : "failed", result.errorTail);
    }
    return result.written ?? { bytes: 0, sha256: "" };
  }

  // -- custom command -------------------------------------------------------------

  private async runCommand(
    file: string,
    runId: string,
  ): Promise<{ bytes: number; sha256: string }> {
    const { docker, envFile, redactor, stateDir } = this.options;
    const command = this.settings.command as NonNullable<
      UpdaterConfig["hooks"]["backup"]["command"]
    >;
    const image = this.options.selfImage();
    if (!image) {
      throw new BackupError(
        "failed",
        "The sidecar's own image is unknown; command backups need it to copy the output.",
      );
    }
    const volume = `cicd-updater-backup-${runId}`;
    const tmpDir = path.join(stateDir, "tmp");
    await fs.mkdir(tmpDir, { recursive: true, mode: 0o700 });
    const envPath = path.join(tmpDir, `backup-${runId}.env`);
    try {
      // Values reach the container through an env file (0600), never through argv or our environment.
      const text = await envFile.read();
      const lines: string[] = [];
      for (const key of command.envKeys) {
        const value = envValueOf(text, key);
        if (value !== null && !/[\r\n]/.test(value)) {
          redactor.add(value);
          lines.push(`${key}=${value}`);
        }
      }
      await fs.writeFile(envPath, `${lines.join("\n")}\n`, { mode: 0o600 });
      await docker.volumeCreate(volume);
      const model = await docker.composeConfig();
      const key = command.network === "project" ? "default" : command.network;
      const network =
        command.network === "none"
          ? "none"
          : (model.networks[key]?.name ?? `${this.options.projectName}_${key}`);
      const result = await docker.run(
        [
          "--network",
          network,
          "--volume",
          `${volume}:/backup`,
          "--env-file",
          envPath,
          command.image,
          ...command.argv,
        ],
        { timeoutMs: this.settings.timeoutSeconds * 1000 },
      );
      if (result.exitCode !== 0 || result.timedOut) {
        throw new BackupError(result.timedOut ? "timeout" : "failed", result.errorTail);
      }
      const copy = await docker.run(
        [
          "--network",
          "none",
          "--read-only",
          "--volume",
          `${volume}:/backup:ro`,
          "--entrypoint",
          "cat",
          image,
          `/backup/${command.outputFile}`,
        ],
        { timeoutMs: this.settings.timeoutSeconds * 1000, stdoutFile: file },
      );
      if (copy.exitCode !== 0) {
        throw new BackupError(
          "verify_failed",
          `The output file ${command.outputFile} could not be read: ${copy.errorTail}`,
        );
      }
      return copy.written ?? { bytes: 0, sha256: "" };
    } finally {
      await fs.rm(envPath, { force: true });
      await docker.volumeRemove(volume).catch(() => undefined);
    }
  }

  // -- verification -------------------------------------------------------------

  private async verify(file: string): Promise<void> {
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size === 0) {
      throw new BackupError("verify_failed", "The backup is empty.");
    }
    switch (this.type) {
      case "postgres":
        return await this.verifyPostgres(file);
      case "mysql":
        return await verifyMysqlDump(file);
      case "volume":
        return await this.verifyArchive(file);
      default:
        return;
    }
  }

  private async verifyPostgres(file: string): Promise<void> {
    const handle = await fs.open(file, "r");
    try {
      const header = Buffer.alloc(5);
      await handle.read(header, 0, 5, 0);
      if (header.toString("latin1") !== "PGDMP") {
        throw new BackupError(
          "verify_failed",
          "The dump is not a PostgreSQL custom-format archive.",
        );
      }
    } finally {
      await handle.close();
    }
    const settings = this.settings;
    const result = await this.options.docker.exec(
      settings.service as string,
      ["pg_restore", "--list"],
      {
        timeoutMs: settings.verifyTimeoutSeconds * 1000,
        stdinFile: file,
        maxOutputBytes: 64 * MiB,
      },
    );
    if (result.exitCode !== 0) {
      throw new BackupError("verify_failed", `pg_restore --list failed: ${result.errorTail}`);
    }
    const entries = result.stdout
      .split("\n")
      .filter((line) => line.trim() && !line.startsWith(";")).length;
    if (entries === 0) {
      throw new BackupError("verify_failed", "The dump lists no entries.");
    }
  }

  private async verifyArchive(file: string): Promise<void> {
    const result: CommandResult = await this.options.runner.run({
      argv: ["tar", "-tzf", file],
      timeoutMs: this.settings.verifyTimeoutSeconds * 1000,
      maxOutputBytes: 64 * MiB,
    });
    if (result.exitCode !== 0) {
      throw new BackupError("verify_failed", `The archive does not read: ${result.errorTail}`);
    }
    const entries = result.stdout.split("\n").map((line) => line.replace(/^\.\//, ""));
    for (const key of this.settings.volumes) {
      if (!entries.some((entry) => entry === `${key}/` || entry.startsWith(`${key}/`))) {
        throw new BackupError("verify_failed", `The archive has no entries of the volume ${key}.`);
      }
    }
  }

  // -- encryption ---------------------------------------------------------------

  private async encrypt(name: string): Promise<BackupRecord> {
    const { store, runner } = this.options;
    const plain = store.pathOf(name);
    const target = `${plain}.age`;
    const partial = `${target}.partial`;
    const args = ["age"] as ["age", ...string[]];
    for (const recipient of this.settings.encryption.ageRecipients) {
      args.push("-r", recipient);
    }
    args.push("-o", partial, plain);
    const result = await runner.run({ argv: args, timeoutMs: this.settings.timeoutSeconds * 1000 });
    if (result.exitCode !== 0) {
      await fs.rm(partial, { force: true });
      throw new BackupError("failed", `Encrypting the backup failed: ${result.errorTail}`);
    }
    await fs.chmod(partial, 0o600);
    await fs.rename(partial, target);
    await fs.rm(plain, { force: true });
    const { bytes, sha256 } = await hashFile(target);
    return { file: `${name}.age`, bytes, sha256, type: this.type, encrypted: true };
  }
}

/** SHA-256 and size of a file, read as a stream. */
export async function hashFile(file: string): Promise<{ bytes: number; sha256: string }> {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(file)) {
    hash.update(chunk as Buffer);
    bytes += (chunk as Buffer).length;
  }
  return { bytes, sha256: hash.digest("hex") };
}

/** A gzip MySQL dump decompresses completely and its last non-empty line starts with `-- Dump completed`. */
export async function verifyMysqlDump(file: string): Promise<void> {
  let tail = "";
  try {
    for await (const chunk of createReadStream(file).pipe(createGunzip())) {
      tail = (tail + (chunk as Buffer).toString("utf8")).slice(-4096);
    }
  } catch {
    throw new BackupError("verify_failed", "The dump does not decompress completely.");
  }
  const last = tail
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!last?.startsWith("-- Dump completed")) {
    throw new BackupError("verify_failed", "The dump does not end with '-- Dump completed'.");
  }
}

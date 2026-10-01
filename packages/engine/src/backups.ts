import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { BackupInfo, BackupType } from "@cicd-updater/protocol";
import { writeAtomic } from "./store.js";

/**
 * Backups taken before an update, in `<stateDir>/backups/` (design 5.14). The
 * sidecar is the only writer. Names are
 * `<project>-<yyyymmdd>-<hhmmss>Z-<from>-to-<to>.<ext>[.age]`; only files with
 * exactly that shape are listed or deleted, so nothing else in the directory is
 * ever touched. Each backup has a metadata file `<name>.json`.
 */

export const BACKUP_EXTENSIONS: Readonly<Record<Exclude<BackupType, "none">, string>> = {
  postgres: "pgdump",
  mysql: "sql.gz",
  volume: "tar.gz",
  command: "bin",
};

export interface BackupMetadata {
  type: BackupType;
  bytes: number;
  sha256: string;
  createdAt: string;
  runId: string;
  fromVersion: string | null;
  toVersion: string;
  verified: boolean;
  encrypted: boolean;
}

/** A version as it appears in a file name: characters outside `[0-9A-Za-z._-]` become `_`. */
export function versionForFileName(version: string | null): string {
  if (!version) {
    return "unknown";
  }
  const cleaned = version.replace(/[^0-9A-Za-z._-]/g, "_").slice(0, 64);
  return cleaned.length > 0 ? cleaned : "unknown";
}

function pad(value: number, width: number): string {
  return String(value).padStart(width, "0");
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class BackupStore {
  private readonly pattern: RegExp;

  constructor(
    readonly directory: string,
    readonly project: string,
  ) {
    if (!/^[a-z0-9][a-z0-9_-]{0,62}$/.test(project)) {
      throw new TypeError(`invalid project name ${project}`);
    }
    this.pattern = new RegExp(
      `^${escapeRegex(project)}-(\\d{4})(\\d{2})(\\d{2})-(\\d{2})(\\d{2})(\\d{2})Z-([0-9A-Za-z._-]{1,64}?)-to-([0-9A-Za-z._-]{1,64})\\.(pgdump|sql\\.gz|tar\\.gz|bin)(\\.age)?$`,
    );
  }

  /** The file name of a new backup. */
  fileName(
    at: Date,
    from: string | null,
    to: string,
    type: Exclude<BackupType, "none">,
    encrypted = false,
  ): string {
    const stamp = `${pad(at.getUTCFullYear(), 4)}${pad(at.getUTCMonth() + 1, 2)}${pad(at.getUTCDate(), 2)}-${pad(at.getUTCHours(), 2)}${pad(at.getUTCMinutes(), 2)}${pad(at.getUTCSeconds(), 2)}Z`;
    return `${this.project}-${stamp}-${versionForFileName(from)}-to-${versionForFileName(to)}.${BACKUP_EXTENSIONS[type]}${encrypted ? ".age" : ""}`;
  }

  /** The time a name encodes; null when the name is not one of ours. */
  parse(
    name: string,
  ): { createdAt: Date; from: string; to: string; extension: string; encrypted: boolean } | null {
    const match = this.pattern.exec(name);
    if (!match) {
      return null;
    }
    const [, year, month, day, hour, minute, second, from, to, extension, age] = match;
    const createdAt = new Date(
      Date.UTC(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      ),
    );
    if (Number.isNaN(createdAt.getTime())) {
      return null;
    }
    return {
      createdAt,
      from: from as string,
      to: to as string,
      extension: extension as string,
      encrypted: age !== undefined,
    };
  }

  isBackupName(name: string): boolean {
    return this.parse(name) !== null;
  }

  async ensureDirectory(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    await fs.chmod(this.directory, 0o700).catch(() => undefined);
  }

  /** Absolute path of a backup; throws for a name that is not one of ours (no path traversal). */
  pathOf(name: string): string {
    if (!this.isBackupName(name)) {
      throw new TypeError("not a backup file name of this sidecar");
    }
    return path.join(this.directory, name);
  }

  /** Path of the file a backup is written to before it is complete. */
  partialPathOf(name: string): string {
    return `${this.pathOf(name)}.partial`;
  }

  async writeMetadata(name: string, metadata: BackupMetadata): Promise<void> {
    await writeAtomic(`${this.pathOf(name)}.json`, `${JSON.stringify(metadata, null, 2)}\n`, 0o600);
  }

  async metadata(name: string): Promise<BackupMetadata | null> {
    try {
      const raw = JSON.parse(
        await fs.readFile(`${this.pathOf(name)}.json`, "utf8"),
      ) as BackupMetadata;
      return raw && typeof raw === "object" ? raw : null;
    } catch {
      return null;
    }
  }

  /** Newest first, with metadata. `protectedFiles` are marked protected. */
  async list(protectedFiles: ReadonlySet<string> = new Set()): Promise<BackupInfo[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    const backups: BackupInfo[] = [];
    for (const name of names) {
      const parsed = this.parse(name);
      if (!parsed) {
        continue;
      }
      let stat: Awaited<ReturnType<typeof fs.stat>>;
      try {
        stat = await fs.stat(path.join(this.directory, name));
      } catch {
        continue;
      }
      if (!stat.isFile()) {
        continue;
      }
      const metadata = await this.metadata(name);
      backups.push({
        file: name,
        bytes: Number(stat.size),
        sha256: metadata?.sha256 ?? null,
        type: metadata?.type ?? typeOfExtension(parsed.extension),
        createdAt: metadata?.createdAt ?? parsed.createdAt.toISOString(),
        runId: metadata?.runId ?? null,
        fromVersion: metadata?.fromVersion ?? (parsed.from === "unknown" ? null : parsed.from),
        toVersion: metadata?.toVersion ?? parsed.to,
        verified: metadata?.verified ?? false,
        encrypted: parsed.encrypted,
        protected: protectedFiles.has(name),
      });
    }
    return backups.sort((a, b) =>
      a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.file < b.file ? 1 : -1,
    );
  }

  async exists(name: string): Promise<boolean> {
    try {
      return (await fs.stat(this.pathOf(name))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * Retention (design 5.14): keep the newest `keep`, delete those older than
   * `maxAgeDays` (0 = no age limit). Protected files are never deleted and do
   * not count towards `keep`. Returns the deleted names.
   */
  async prune(policy: {
    keep: number;
    maxAgeDays: number;
    protectedFiles: ReadonlySet<string>;
    now: Date;
  }): Promise<string[]> {
    const removable = (await this.list()).filter(
      (backup) => !policy.protectedFiles.has(backup.file),
    );
    const cutoff =
      policy.maxAgeDays > 0 ? policy.now.getTime() - policy.maxAgeDays * 86_400_000 : null;
    const deleted: string[] = [];
    removable.forEach((backup, index) => {
      if (index >= policy.keep || (cutoff !== null && Date.parse(backup.createdAt) < cutoff)) {
        deleted.push(backup.file);
      }
    });
    for (const name of deleted) {
      await this.remove(name);
    }
    return deleted;
  }

  /** Delete a backup with its metadata and partial file. */
  async remove(name: string): Promise<void> {
    const file = this.pathOf(name);
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.json`, { force: true });
    await fs.rm(`${file}.partial`, { force: true });
  }

  /** Remove `.partial` files of interrupted backups (only names of ours). */
  async purgePartials(): Promise<string[]> {
    let names: string[];
    try {
      names = await fs.readdir(this.directory);
    } catch {
      return [];
    }
    const removed: string[] = [];
    for (const name of names) {
      if (name.endsWith(".partial") && this.isBackupName(name.slice(0, -".partial".length))) {
        await fs.rm(path.join(this.directory, name), { force: true });
        removed.push(name);
      }
    }
    return removed;
  }
}

function typeOfExtension(extension: string): string {
  switch (extension) {
    case "pgdump":
      return "postgres";
    case "sql.gz":
      return "mysql";
    case "tar.gz":
      return "volume";
    default:
      return "command";
  }
}

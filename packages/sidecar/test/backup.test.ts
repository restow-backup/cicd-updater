import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { gzipSync } from "node:zlib";
import { BackupError, BackupStore, EnvFile, Redactor } from "@cicd-updater/engine";
import { baseConfig, memoryLogger } from "@cicd-updater/engine/testing";
import {
  type UpdaterConfig,
  type UpdaterConfigInput,
  validateConfig,
  writableKeys,
} from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CliDocker,
  DockerBackupRunner,
  MYSQL_DUMP_SCRIPT,
  POSTGRES_DUMP_SCRIPT,
  POSTGRES_TERMINATE_SCRIPT,
  SidecarHooks,
  verifyMysqlDump,
} from "../src/index.js";
import { rejection, ScriptedRunner } from "./helpers.js";

let dir: string;
let stateDir: string;
let projectDir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-backup-"));
  stateDir = path.join(dir, "state");
  projectDir = path.join(dir, "project");
  await fs.mkdir(stateDir, { recursive: true });
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, ".env"),
    "POSTGRES_PASSWORD=super-secret-db-password\nS3_SECRET_KEY=s3-secret-value-123\nAPP_IMAGE=x:1\n",
  );
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(
  runner: ScriptedRunner,
  change: (input: UpdaterConfigInput) => void = () => undefined,
  minFreeMb = 0,
) {
  const input = baseConfig(projectDir);
  input.state = { dir: stateDir };
  input.docker = { minFreeMb };
  change(input);
  const result = validateConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const config: UpdaterConfig = result.config;
  const redactor = new Redactor();
  const docker = new CliDocker({
    runner,
    redactor,
    compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
    timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
  });
  const hooks = new SidecarHooks({ config, docker, redactor, token: () => "t".repeat(64) });
  const store = new BackupStore(path.join(stateDir, "backups"), "notes");
  const backup = new DockerBackupRunner({
    config,
    docker,
    runner,
    hooks,
    store,
    envFile: new EnvFile(path.join(projectDir, ".env"), writableKeys(config)),
    redactor,
    logger: memoryLogger(redactor),
    stateDir,
    projectName: "notes",
    selfImage: () => "sha256:selfimage",
  });
  return { backup, store, config };
}

const input = (signal = new AbortController().signal) => ({
  runId: "r-1793642400000-abcd",
  fromVersion: "1.0.0",
  toVersion: "1.1.0",
  at: new Date("2026-11-02T10:00:00Z"),
  signal,
  onStage: async () => undefined,
});

const PGDUMP = `PGDMP${"x".repeat(100)}`;

describe("PostgreSQL", () => {
  it("dumps inside the database container with the constant script and verifies the archive", async () => {
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .when(["command -v timeout >/dev/null 2>&1"], { exitCode: 0 })
      .answer((spec) => (spec.argv.includes(POSTGRES_DUMP_SCRIPT) ? { file: PGDUMP } : undefined))
      .when(["pg_restore", "--list"], {
        stdout: ";\n; Archive created\n215; 1259 16386 TABLE public notes\n",
      })
      .answer((spec) =>
        spec.argv.includes("SELECT pg_database_size(current_database())")
          ? { stdout: "1000\n" }
          : undefined,
      );
    const { backup, store } = setup(runner);
    const record = await backup.create(input());
    expect(record).toMatchObject({
      file: "notes-20261102-100000Z-1.0.0-to-1.1.0.pgdump",
      bytes: PGDUMP.length,
      type: "postgres",
      encrypted: false,
    });
    const dump = runner.argvs.find((argv) => argv.includes(POSTGRES_DUMP_SCRIPT));
    expect(dump?.slice(-4)).toEqual(["", "", "120", "cicd-updater-backup-r-1793642400000-abcd"]);
    expect(runner.everything()).not.toContain("super-secret-db-password");
    const files = await fs.readdir(store.directory);
    expect(files.sort()).toEqual([
      "notes-20261102-100000Z-1.0.0-to-1.1.0.pgdump",
      "notes-20261102-100000Z-1.0.0-to-1.1.0.pgdump.json",
    ]);
    expect((await fs.stat(path.join(store.directory, record.file))).mode & 0o777).toBe(0o600);
    const metadata = await store.metadata(record.file);
    expect(metadata).toMatchObject({
      verified: true,
      runId: "r-1793642400000-abcd",
      sha256: record.sha256,
    });
    const verify = runner.specs.find((spec) => spec.argv.includes("pg_restore"));
    expect(verify?.stdinFile).toBe(path.join(store.directory, record.file.concat(".partial")));
  });

  it("refuses a dump without the PGDMP header and leaves nothing behind", async () => {
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .answer((spec) =>
        spec.argv.includes(POSTGRES_DUMP_SCRIPT) ? { file: "not a dump" } : undefined,
      );
    const { backup, store } = setup(runner);
    await expect(backup.create(input())).rejects.toMatchObject({ kind: "verify_failed" });
    expect(await fs.readdir(store.directory)).toEqual([]);
  });

  it("terminates exactly its own backends on abort and on timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .answer((spec) =>
        spec.argv.includes(POSTGRES_DUMP_SCRIPT)
          ? { exitCode: 143, aborted: true, file: "PGDMP" }
          : undefined,
      );
    const { backup, store } = setup(runner);
    const error = await rejection<BackupError>(backup.create(input(controller.signal)));
    expect(error).toBeInstanceOf(BackupError);
    expect(error.kind).toBe("aborted");
    const terminate = runner.argvs.find((argv) => argv.includes(POSTGRES_TERMINATE_SCRIPT));
    expect(terminate?.at(-1)).toBe("cicd-updater-backup-r-1793642400000-abcd");
    expect(await fs.readdir(store.directory)).toEqual([]);

    const slow = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .answer((spec) =>
        spec.argv.includes(POSTGRES_DUMP_SCRIPT)
          ? { exitCode: 124, timedOut: true, file: "PGDMP" }
          : undefined,
      );
    expect((await rejection<BackupError>(setup(slow).backup.create(input()))).kind).toBe("timeout");
    expect(slow.argvs.some((argv) => argv.includes(POSTGRES_TERMINATE_SCRIPT))).toBe(true);
  });

  it("refuses when the estimate does not fit the free space", async () => {
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .answer((spec) =>
        spec.argv.includes("SELECT pg_database_size(current_database())")
          ? { stdout: String(10 ** 15) }
          : undefined,
      );
    const error = await rejection<BackupError>(setup(runner).backup.create(input()));
    expect(error.kind).toBe("insufficient_space");
    expect(error.detail).toMatch(/MB free, \d+ MB needed/);
    expect(runner.argvs.some((argv) => argv.includes(POSTGRES_DUMP_SCRIPT))).toBe(false);
  });
});

describe("MySQL / MariaDB", () => {
  const mysql = (input: UpdaterConfigInput) => {
    input.hooks = {
      ...input.hooks,
      backup: { type: "mysql", service: "db", flavor: "mariadb" },
      migrationProbe: { type: "none" },
    };
  };

  it("dumps with the constant script (the tool as a parameter), gzips in the sidecar and checks the end marker", async () => {
    const dumpText =
      "-- MariaDB dump\nCREATE TABLE notes (id int);\n-- Dump completed on 2026-11-02 10:00:00\n";
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "0" }))
      .answer((spec) => (spec.argv.includes(MYSQL_DUMP_SCRIPT) ? { file: dumpText } : undefined));
    const { backup, store } = setup(runner, mysql);
    const record = await backup.create(input());
    expect(record.file).toMatch(/\.sql\.gz$/);
    const dump = runner.specs.find((spec) => spec.argv.includes(MYSQL_DUMP_SCRIPT));
    expect(dump?.gzipStdout).toBe(true);
    expect(dump?.argv.slice(-4)).toEqual(["", "", "120", "mariadb-dump"]);
    expect(runner.everything()).not.toContain("super-secret-db-password");
    await expect(verifyMysqlDump(path.join(store.directory, record.file))).resolves.toBeUndefined();
  });

  it("refuses a truncated dump", async () => {
    const file = path.join(dir, "cut.sql.gz");
    await fs.writeFile(file, gzipSync("CREATE TABLE notes (id int);\nINSERT INTO"));
    await expect(verifyMysqlDump(file)).rejects.toMatchObject({ kind: "verify_failed" });
    await fs.writeFile(file, gzipSync("-- Dump completed").subarray(0, 10));
    await expect(verifyMysqlDump(file)).rejects.toMatchObject({ kind: "verify_failed" });
  });
});

describe("volume archives and commands", () => {
  it("archives the listed volumes read-only in a locked-down one-off container", async () => {
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .when(["config", "--format", "json"], {
        stdout: JSON.stringify({
          name: "notes",
          services: {},
          volumes: { data: { name: "notes_data" } },
        }),
      })
      .when(["--entrypoint", "tar"], { file: "TARGZ" })
      .when(["tar", "-tzf"], { stdout: "./\n./data/\n./data/notes.db\n" });
    const { backup } = setup(runner, (input) => {
      input.hooks = {
        ...input.hooks,
        backup: { type: "volume", volumes: ["data"] },
        migrationProbe: { type: "none" },
      };
    });
    const record = await backup.create(input());
    expect(record.file).toMatch(/\.tar\.gz$/);
    const run = runner.argvs.find((argv) => argv.includes("--entrypoint"));
    expect(run).toEqual([
      "docker",
      "run",
      "--rm",
      "--label",
      "io.github.restow-backup.cicd-updater.managed=true",
      "--network",
      "none",
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--volume",
      "notes_data:/backup-src/data:ro",
      "--entrypoint",
      "tar",
      "sha256:selfimage",
      "-czf",
      "-",
      "-C",
      "/backup-src",
      ".",
    ]);
  });

  it("runs a pinned command image with an env file, never with secrets in argv, and cleans up", async () => {
    const image = `ghcr.io/acme/backup:1@sha256:${"a".repeat(64)}`;
    let envFileContent = "";
    let envFileMode = 0;
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .when(["config", "--format", "json"], {
        stdout: JSON.stringify({
          name: "notes",
          services: {},
          networks: { default: { name: "notes_default" } },
        }),
      })
      .when(["--entrypoint", "cat"], { file: "BACKUP-BYTES" });
    const original = runner.run.bind(runner);
    runner.run = async (spec) => {
      const index = spec.argv.indexOf("--env-file");
      if (index > -1) {
        const file = spec.argv[index + 1] as string;
        envFileContent = await fs.readFile(file, "utf8");
        envFileMode = (await fs.stat(file)).mode & 0o777;
      }
      return original(spec);
    };
    const { backup } = setup(runner, (input) => {
      input.hooks = {
        ...input.hooks,
        backup: {
          type: "command",
          command: {
            image,
            argv: ["backup", "--to", "/backup/backup.out"],
            envKeys: ["S3_SECRET_KEY"],
          },
        },
        migrationProbe: { type: "none" },
      };
    });
    const record = await backup.create(input());
    expect(record.file).toMatch(/\.bin$/);
    expect(envFileContent).toBe("S3_SECRET_KEY=s3-secret-value-123\n");
    expect(envFileMode).toBe(0o600);
    expect(runner.everything()).not.toContain("s3-secret-value-123");
    const command = runner.argvs.find((argv) => argv.includes(image));
    expect(command).toEqual(
      expect.arrayContaining([
        "--network",
        "notes_default",
        "--volume",
        "cicd-updater-backup-r-1793642400000-abcd:/backup",
      ]),
    );
    expect(runner.argvs.some((argv) => argv[1] === "volume" && argv[2] === "rm")).toBe(true);
    await expect(fs.readdir(path.join(stateDir, "tmp"))).resolves.toEqual([]);
  });

  it("joins a named network of the Compose file when the database is not on the default one", async () => {
    const image = `ghcr.io/acme/backup:1@sha256:${"a".repeat(64)}`;
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .when(["config", "--format", "json"], {
        stdout: JSON.stringify({
          name: "notes",
          services: {},
          networks: { internal: { name: "notes_internal" } },
        }),
      })
      .when(["--entrypoint", "cat"], { file: "BACKUP-BYTES" });
    const { backup } = setup(runner, (input) => {
      input.hooks = {
        ...input.hooks,
        backup: {
          type: "command",
          command: { image, argv: ["backup"], network: "internal" },
        },
        migrationProbe: { type: "none" },
      };
    });
    await backup.create(input());
    const command = runner.argvs.find((argv) => argv.includes(image));
    expect(command?.[command.indexOf("--network") + 1]).toBe("notes_internal");
  });

  it("encrypts with age recipients and removes the plaintext", async () => {
    const recipient = `age1${"q".repeat(58)}`;
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "" }))
      .answer((spec) => (spec.argv.includes(POSTGRES_DUMP_SCRIPT) ? { file: PGDUMP } : undefined))
      .when(["pg_restore", "--list"], { stdout: "1; TABLE notes\n" });
    const original = runner.run.bind(runner);
    runner.run = async (spec) => {
      if (spec.argv[0] === "age") {
        await fs.writeFile(spec.argv[spec.argv.indexOf("-o") + 1] as string, "AGE-ENCRYPTED");
      }
      return original(spec);
    };
    const { backup, store } = setup(runner, (input) => {
      input.hooks = {
        ...input.hooks,
        backup: { type: "postgres", service: "db", encryption: { ageRecipients: [recipient] } },
      };
    });
    const record = await backup.create(input());
    expect(record).toMatchObject({ encrypted: true, bytes: "AGE-ENCRYPTED".length });
    expect(record.file).toMatch(/\.pgdump\.age$/);
    expect(runner.argvs.find((argv) => argv[0] === "age")?.slice(0, 3)).toEqual([
      "age",
      "-r",
      recipient,
    ]);
    expect((await fs.readdir(store.directory)).sort()).toEqual([
      record.file,
      `${record.file}.json`,
    ]);
  });
});

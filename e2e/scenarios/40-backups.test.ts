import { afterEach, describe, expect, it } from "vitest";
import { q } from "../lib/exec.js";
import { docker, IMAGES, REGISTRY, sh, UPDATER, WORK } from "../lib/host.js";
import { type Project, problemOf } from "../lib/project.js";
import { StubApp } from "../lib/stub.js";

/**
 * Real backups (design 5.3 backup, 5.14, docs/backups-and-recovery.md): PostgreSQL with a
 * pg_restore round trip, MySQL and MariaDB (MYSQL_PWD, mysqldump / mariadb-dump), a
 * quiesced volume archive, a command backup, age encryption, a separate backups volume,
 * and the documented restore commands run for real.
 */

let current: Project | null = null;

afterEach(async () => {
  await current?.down();
  current = null;
});

/** A scratch copy of a backup inside the host (`backups cat`). */
async function fetchBackup(project: Project, file: string): Promise<string> {
  const target = `${WORK}/restore/${project.name}/${file}`;
  await sh(
    `mkdir -p ${q(`${WORK}/restore/${project.name}`)} && cd ${q(project.dir)} && docker compose --profile updater exec -T updater cicd-updater backups cat ${q(file)} > ${q(target)}`,
  );
  return target;
}

async function onlyBackup(
  project: Project,
): Promise<{ file: string; type: string; bytes: number; encrypted: boolean }> {
  const list = JSON.parse((await project.cli(["backups", "list", "--json"])).stdout) as {
    file: string;
    type: string;
    bytes: number;
    encrypted: boolean;
  }[];
  expect(list).toHaveLength(1);
  return list[0] as { file: string; type: string; bytes: number; encrypted: boolean };
}

describe("PostgreSQL", () => {
  it("backs up with pg_dump -Fc, verifies, and the dump restores into a scratch database", async () => {
    const app = await StubApp.create({ name: "pgbackup" });
    await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
    await app.release({ version: "1.1.0", migration: 1 });
    const project = await app.install("1.0.0");
    current = project;
    await project.sql("CREATE TABLE notes (id serial PRIMARY KEY, body text)");
    await project.sql(
      "INSERT INTO notes (body) SELECT 'note ' || g FROM generate_series(1, 1000) g",
    );
    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    const backup = await onlyBackup(project);
    expect(backup.file).toMatch(/^pgbackup-\d{8}-\d{6}Z-1\.0\.0-to-1\.1\.0\.pgdump$/);
    expect(backup.encrypted).toBe(false);
    const sha = (
      await sh(`sha256sum ${q(await fetchBackup(project, backup.file))} | cut -d' ' -f1`)
    ).stdout.trim();
    const listed = JSON.parse((await project.cli(["backups", "list", "--json"])).stdout)[0];
    expect(listed.sha256).toBe(sha);

    // Restore into a scratch database (pg_restore from stdin, as the docs do).
    await project.sql("CREATE DATABASE scratch");
    await sh(
      `cd ${q(project.dir)} && docker compose --profile updater exec -T updater cicd-updater backups cat ${q(backup.file)} \\
  | docker compose exec -T db pg_restore -U stub -d scratch --exit-on-error`,
    );
    expect(await project.sql("SELECT count(*) FROM notes", "scratch")).toBe("1000");
    expect(
      await project.sql("SELECT string_agg(version, ',') FROM stub_migrations", "scratch"),
    ).toBe("1");
    await project.ack();
  });

  it("encrypts with age: only <name>.age stays, and the identity decrypts it", async () => {
    const keys = `${WORK}/age`;
    await sh(
      `mkdir -p ${keys} && docker run --rm -v ${keys}:/k --entrypoint age-keygen ${UPDATER} -o /k/identity.txt 2> /dev/null && chmod 644 ${keys}/identity.txt`,
    );
    const recipient = (await sh(`grep -o 'age1[0-9a-z]*' ${keys}/identity.txt`)).stdout.trim();
    const app = await StubApp.create({
      name: "pgage",
      backup: { type: "postgres", service: "db", encryption: { ageRecipients: [recipient] } },
    });
    await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
    await app.release({ version: "1.1.0", migration: 1 });
    const project = await app.install("1.0.0");
    current = project;
    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    const backup = await onlyBackup(project);
    expect(backup.file).toMatch(/\.pgdump\.age$/);
    expect(backup.encrypted).toBe(true);
    const files = (await project.compose(["exec", "-T", "updater", "ls", "/state/backups"])).stdout;
    expect(files).not.toMatch(/\.pgdump$/m);
    const copy = await fetchBackup(project, backup.file);
    expect((await sh(`head -c 21 ${q(copy)}`)).stdout).toBe("age-encryption.org/v1");
    // Decrypt with the identity and let pg_restore read the archive.
    const entries = await sh(
      `docker run --rm -v ${keys}:/k:ro -v ${q(copy)}:/in.age:ro --entrypoint age ${UPDATER} -d -i /k/identity.txt /in.age \\
  | (cd ${q(project.dir)} && docker compose exec -T db pg_restore --list) | grep -c 'TABLE DATA'`,
    );
    expect(Number(entries.stdout.trim())).toBeGreaterThan(0);
    await project.ack();
    await sh(`rm -rf ${keys}`);
  });

  it("measures the free space where backups are written: a separate volume at /state/backups", async () => {
    const tmpfs = (size: string) => ({
      driver: "local",
      driver_opts: { type: "tmpfs", device: "tmpfs", o: `size=${size}` },
    });
    const app = await StubApp.create({
      name: "pgdisk",
      updater: (config) => {
        config.docker = { minFreeMb: 64 };
      },
      compose: (compose) => {
        const updater = compose.services.updater as { volumes: string[] };
        updater.volumes.push("backup-disk:/state/backups");
        compose.volumes["backup-disk"] = tmpfs("16m");
      },
    });
    await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
    await app.release({ version: "1.1.0", migration: 1 });
    const project = await app.install("1.0.0");
    current = project;
    const problem = problemOf(await project.schedule("1.1.0"));
    expect(problem.code).toBe("blocked");
    expect(JSON.stringify(problem.blockers)).toMatch(
      /disk_space.*MB free in \/state\/backups, 64 MB required/,
    );

    // A larger backup disk: the backup lands on it, not on the state volume.
    await project.compose(["down", "--timeout", "5"]);
    await sh(`docker volume rm pgdisk_backup-disk > /dev/null`);
    const compose = app.composeFile() as { volumes: Record<string, unknown> };
    compose.volumes["backup-disk"] = tmpfs("512m");
    await project.writeCompose(compose);
    await project.up();
    await project.ready();
    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    const backup = await onlyBackup(project);
    const mounted = await project.compose([
      "exec",
      "-T",
      "updater",
      "sh",
      "-c",
      `grep ' /state/backups ' /proc/mounts && ls /state/backups/${backup.file}`,
    ]);
    expect(mounted.stdout).toContain("tmpfs");
    await project.ack();
  });
});

describe.each([
  ["MariaDB 11.8 (mariadb-dump)", "mariadb", IMAGES.mariadb, "MARIADB"],
  ["MySQL 8.4 (mysqldump)", "mysql", IMAGES.mysql, "MYSQL"],
])("%s", (_title, name, image, prefix) => {
  it("dumps with MYSQL_PWD, verifies the gzip, and the documented restore brings the rows back", async () => {
    const app = await StubApp.create({
      name: `${name}backup`,
      backup: { type: "mysql", service: "db" },
      rollback: "always",
      updater: (config) => {
        const hooks = config.hooks as Record<string, unknown>;
        hooks.migrationProbe = { type: "none" };
      },
      compose: (compose) => {
        compose.services.db = {
          image,
          restart: "unless-stopped",
          environment: {
            [`${prefix}_ROOT_PASSWORD`]: "${POSTGRES_PASSWORD:?}",
            [`${prefix}_DATABASE`]: "stub",
          },
          volumes: ["db-data:/var/lib/mysql"],
          healthcheck: {
            test: [
              "CMD-SHELL",
              `${name === "mariadb" ? "mariadb-admin" : "mysqladmin"} ping -uroot -p"$$${prefix}_ROOT_PASSWORD" --silent`,
            ],
            interval: "3s",
            timeout: "5s",
            retries: 60,
          },
        };
      },
    });
    await app.release({ version: "1.0.0" });
    await app.release({ version: "1.1.0" });
    const project = await app.install("1.0.0");
    current = project;
    const client = name === "mariadb" ? "mariadb" : "mysql";
    const sql = (query: string) =>
      project.compose([
        "exec",
        "-T",
        "db",
        "sh",
        "-c",
        `MYSQL_PWD="$${prefix}_ROOT_PASSWORD" ${client} -uroot -N -B stub -e ${q(query)}`,
      ]);
    await sql("CREATE TABLE notes (id INT AUTO_INCREMENT PRIMARY KEY, body TEXT)");
    await sql("INSERT INTO notes (body) VALUES ('alpha'), ('beta'), ('gamma')");
    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    const backup = await onlyBackup(project);
    expect(backup.file).toMatch(/\.sql\.gz$/);
    // The password never appears in the run log or the sidecar's output.
    const logs = await project.compose(["logs", "--no-color", "updater"]);
    expect(logs.stdout).not.toContain("stub-db-password-e2e");
    await project.ack();

    await sql("DELETE FROM notes");
    // The documented restore (docs/backups-and-recovery.md, MySQL and MariaDB).
    await sh(
      `cd ${q(project.dir)} && docker compose --profile updater exec -T updater cicd-updater backups cat ${q(backup.file)} \\
  | gunzip \\
  | docker compose exec -T db sh -c 'MYSQL_PWD="\${MYSQL_ROOT_PASSWORD:-$MARIADB_ROOT_PASSWORD}" exec "$(command -v mariadb || command -v mysql)" -u root "\${MYSQL_DATABASE:-$MARIADB_DATABASE}"'`,
    );
    expect((await sql("SELECT group_concat(body ORDER BY id) FROM notes")).stdout.trim()).toBe(
      "alpha,beta,gamma",
    );
  });
});

describe("volumes and commands", () => {
  it("archives a quiesced volume, and the documented restore brings its files back", async () => {
    const app = await StubApp.create({
      name: "volbackup",
      backup: { type: "volume", volumes: ["app-data"] },
      rollback: "always",
      updater: (config) => {
        (config.hooks as Record<string, unknown>).migrationProbe = { type: "none" };
      },
      compose: (compose) => {
        (compose.services.api as { volumes?: string[] }).volumes = ["app-data:/data"];
        (compose.services.api as { user?: string }).user = "root";
        compose.volumes["app-data"] = {};
      },
    });
    await app.release({ version: "1.0.0" });
    await app.release({ version: "1.1.0" });
    const project = await app.install("1.0.0");
    current = project;
    await project.compose([
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      "mkdir -p /data/notes && echo one > /data/notes/a.txt && echo two > /data/b.txt",
    ]);
    const run = await project.update("1.1.0");
    expect(run.outcome).toBe("succeeded");
    expect(run.steps.find((step) => step.id === "backup")?.status).toBe("done");
    const backup = await onlyBackup(project);
    expect(backup.file).toMatch(/\.tar\.gz$/);
    const archive = await fetchBackup(project, backup.file);
    const members = (await sh(`tar -tzf ${q(archive)}`)).stdout;
    expect(members).toMatch(/app-data\/notes\/a\.txt/);
    await project.ack();

    // The new version "breaks" the data; restore as docs/backups-and-recovery.md shows.
    await project.compose([
      "exec",
      "-T",
      "api",
      "sh",
      "-c",
      "rm -rf /data/notes && echo broken > /data/new.txt",
    ]);
    await sh(
      `cd ${q(project.dir)}
install -d -m 700 ${WORK}/restore/vol
docker compose --profile updater exec -T updater cicd-updater backups cat ${q(backup.file)} > ${WORK}/restore/vol/volumes.tar.gz
docker compose stop api worker
docker run --rm --network none \\
  --volume volbackup_app-data:/restore/app-data \\
  --volume ${WORK}/restore/vol:/in:ro \\
  --entrypoint sh ${UPDATER} \\
  -c 'for d in /restore/*/; do find "$d" -mindepth 1 -delete; done; tar -xzf /in/volumes.tar.gz -C /restore'
rm ${WORK}/restore/vol/volumes.tar.gz
docker compose up -d --wait api worker`,
    );
    const files = (
      await project.compose([
        "exec",
        "-T",
        "api",
        "sh",
        "-c",
        "cat /data/notes/a.txt /data/b.txt; ls /data",
      ])
    ).stdout;
    expect(files).toContain("one");
    expect(files).toContain("two");
    expect(files).not.toContain("new.txt");
  });

  it("runs a command backup in a digest-pinned image with env from the env file", async () => {
    // The backup image: postgres, pushed to the test registry to get a digest.
    await docker(["tag", IMAGES.postgres, `${REGISTRY}/e2e/pgtools:17`]);
    const pushed = await docker(["push", `${REGISTRY}/e2e/pgtools:17`]);
    const digest = /digest: (sha256:[0-9a-f]{64})/.exec(pushed.stdout)?.[1];
    expect(digest).toBeTruthy();
    const app = await StubApp.create({
      name: "cmdbackup",
      backup: {
        type: "command",
        command: {
          image: `${REGISTRY}/e2e/pgtools@${digest}`,
          argv: [
            "sh",
            "-c",
            'PGPASSWORD="$POSTGRES_PASSWORD" pg_dump -h db -U stub stub > /backup/backup.out',
          ],
          envKeys: ["POSTGRES_PASSWORD"],
          outputFile: "backup.out",
        },
      },
    });
    await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
    await app.release({ version: "1.1.0", migration: 1 });
    const project = await app.install("1.0.0");
    current = project;
    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    const backup = await onlyBackup(project);
    expect(backup.file).toMatch(/\.bin$/);
    const dump = (await sh(`cat ${q(await fetchBackup(project, backup.file))}`)).stdout;
    expect(dump).toContain("CREATE TABLE public.stub_migrations");
    // The env file passed to the backup container is gone again.
    const leftovers = (
      await project.compose([
        "exec",
        "-T",
        "updater",
        "sh",
        "-c",
        "ls /state/tmp 2>/dev/null || true",
      ])
    ).stdout;
    expect(leftovers).not.toMatch(/backup-.*\.env/);
    await project.ack();
  });
});

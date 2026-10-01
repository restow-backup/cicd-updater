import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { q, sleep, waitFor } from "../lib/exec.js";
import { docker, sh, UPDATER } from "../lib/host.js";
import { type Project, problemOf, sidecarService } from "../lib/project.js";
import { StubApp } from "../lib/stub.js";

/**
 * The run's life cycle around the engine (design 5.7, 5.8, 5.10, 5.11, 5.14): cancel,
 * reschedule, abort, restarts of the sidecar in the middle of a run, a missed start,
 * the state lock, the preflight blockers about the sidecar itself, image pruning and
 * backup retention with the protected backup.
 */

let app: StubApp;
let project: Project;

beforeAll(async () => {
  app = await StubApp.create({
    name: "lifecycle",
    edge: true,
    healthTimeoutSeconds: 60,
    updater: (config) => {
      config.cleanup = { keepPreviousImages: 0 };
      (config.hooks as Record<string, Record<string, unknown>>).backup = {
        type: "postgres",
        service: "db",
        retention: { keep: 1, maxAgeDays: 30 },
      };
    },
  });
  await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
  await app.release({ version: "1.1.0", migration: 1 });
  await app.release({ version: "1.1.1", migration: 1, padMiB: 300 });
  await app.release({ version: "1.2.0", migration: 1, health: "unready" });
  await app.release({ version: "1.3.0", migration: 1 });
  project = await app.install("1.0.0");
});

afterAll(async () => {
  await project?.down();
});

afterEach(async () => {
  // A failed assertion must not leave a run that blocks the next scenario.
  await project?.settle();
});

async function phase(): Promise<string> {
  return (await project.state()).phase;
}

describe("cancel and reschedule", () => {
  it("reschedules and cancels a scheduled run", async () => {
    expect((await project.schedule("1.1.0", ["--in", "1h"])).code).toBe(0);
    const first = (await project.state()).run;
    expect(first?.startsAt).toBeTruthy();
    const moved = await project.cli(["reschedule", "--in", "2h", "--json"]);
    expect(moved.code).toBe(0);
    const second = (await project.state()).run;
    const shift = Date.parse(second?.startsAt ?? "") - Date.parse(first?.startsAt ?? "");
    expect(shift).toBeGreaterThan(3500_000);
    expect(shift).toBeLessThan(3700_000);
    await project.cli(["cancel", "--json"]);
    const state = await project.state();
    expect(state.phase).toBe("idle");
    expect(state.history[0]?.cancelled).toBe(true);
    const nothing = await project.cli(["reschedule", "--in", "1h"], { allowFail: true });
    expect(nothing.code).toBe(1);
    expect(nothing.stderr).toContain("Nothing is scheduled.");
  });

  it("aborts a running PostgreSQL backup: unchanged, its backends ended, nothing left behind", async () => {
    // Enough data for a dump that takes a few seconds.
    await project.sql(
      "CREATE TABLE big AS SELECT g AS id, md5(random()::text) || md5(random()::text) || md5(random()::text) AS body FROM generate_series(1, 4000000) g",
    );
    const env = await project.env();
    expect((await project.schedule("1.1.0")).code).toBe(0);
    await project.waitFor("running", "backup", 180_000);
    await project.cli(["cancel", "--json"]);
    const run = await project.finished();
    expect(run.failure?.code).toBe("aborted");
    expect(run.outcome).toBe("unchanged");
    expect(await project.env()).toBe(env);
    expect(
      await project.sql(
        "SELECT count(*) FROM pg_stat_activity WHERE application_name LIKE 'cicd-updater-backup-%'",
      ),
    ).toBe("0");
    const files = (await project.compose(["exec", "-T", "updater", "ls", "-a", "/state/backups"]))
      .stdout;
    expect(files).not.toContain(".partial");
    expect(files).not.toContain(".pgdump");
    await project.ack();
    await project.sql("DROP TABLE big");
  });
});

describe("the sidecar restarts during a run", () => {
  it("killed during fetch: interrupted, unchanged", async () => {
    const env = await project.env();
    // 1.1.1 carries a 300 MiB layer: its pull keeps the run in fetch long enough.
    expect((await project.schedule("1.1.1")).code).toBe(0);
    await project.killAt("fetch");
    const state = await project.state();
    expect(state.phase).toBe("failed");
    expect(state.run?.failure?.code).toBe("interrupted");
    expect(state.run?.outcome).toBe("unchanged");
    expect(await project.env()).toBe(env);
    expect(await project.serviceImage("api")).toBe(app.ref("1.0.0"));
    await project.ack();
  });

  it("killed during health: interrupted, needs_attention, services left as they are", async () => {
    expect((await project.schedule("1.2.0")).code).toBe(0);
    await project.killAt("health");
    const apiBefore = await project.containerId("api");
    expect(apiBefore).not.toBe("");
    const state = await project.state();
    expect(state.phase).toBe("failed");
    expect(state.run?.failure?.code).toBe("interrupted");
    expect(state.run?.outcome).toBe("needs_attention");
    expect(state.run?.recovery?.backup?.file).toMatch(/\.pgdump$/);
    // "After a restart the sidecar never starts or stops services on its own."
    await sleep(5000);
    expect(await project.containerId("api")).toBe(apiBefore);
    expect(await project.envValue("APP_IMAGE")).toBe(app.ref("1.2.0"));
    // Back to 1.0.0 the documented way (nothing migrated, so no restore needed).
    await project.compose([
      "exec",
      "-T",
      "updater",
      "cicd-updater",
      "recover",
      "restore-env",
      state.run?.id ?? "",
      "--yes",
    ]);
    expect(await project.envValue("APP_IMAGE")).toBe(app.ref("1.0.0"));
    await project.compose(["up", "-d", "--wait", "api", "worker", "edge"]);
    await project.ack();
  });

  it("a run whose start passed while the sidecar was down fails with missed_start", async () => {
    expect((await project.schedule("1.1.0", ["--in", "10s"])).code).toBe(0);
    await project.compose(["stop", "-t", "30", "updater"]);
    // startsAt + lateStartToleranceSeconds (30 s) must pass.
    await sleep(45_000);
    await project.compose(["up", "-d", "updater"]);
    await project.ready();
    const state = await project.state();
    expect(state.run?.failure?.code).toBe("missed_start");
    expect(state.run?.outcome).toBe("unchanged");
    await project.ack();
  });
});

describe("the sidecar itself", () => {
  it("a second sidecar on the same state volume exits with 75 (state lock)", async () => {
    const result = await sh(
      `docker run --rm --name lifecycle-second-sidecar -v lifecycle_updater-state:/state -v lifecycle_updater-shared:/shared -v ${q(project.dir)}:${q(project.dir)} -e CICD_UPDATER_CONFIG=${q(project.dir)}/updater.yaml -e CICD_UPDATER_COMPOSE__PROJECT_DIR=${q(project.dir)} ${UPDATER} serve`,
      { allowFail: true, timeoutMs: 120_000 },
    );
    expect(result.code).toBe(75);
    expect(result.stderr + result.stdout).toMatch(/locked/i);
    expect(await phase()).toBe("idle");
  });

  async function blockers(): Promise<string[]> {
    return waitFor("a fresh preflight", async () => {
      const doctor = await project.cli(["status", "--json"], { allowFail: true });
      if (doctor.code !== 0) return undefined;
      return JSON.parse(doctor.stdout).capabilities.blockers.map(
        (b: { code: string }) => b.code,
      ) as string[];
    });
  }

  async function withSidecar(
    change: (service: Record<string, unknown>, compose: Record<string, unknown>) => void,
    check: () => Promise<void>,
  ): Promise<void> {
    const compose = app.composeFile() as { services: Record<string, Record<string, unknown>> };
    const updater = compose.services.updater as Record<string, unknown>;
    change(updater, compose);
    await project.writeCompose(compose);
    await project.compose(["up", "-d", "--remove-orphans"]);
    await project.ready();
    try {
      await check();
    } finally {
      await project.writeCompose(app.composeFile());
      await project.compose(["up", "-d", "--remove-orphans"]);
      await project.ready();
    }
  }

  it("blocks with a published port (api_exposed)", async () => {
    await withSidecar(
      (updater) => {
        updater.ports = ["127.0.0.1:18090:8090"];
      },
      async () => {
        await waitFor(
          "api_exposed",
          async () => ((await blockers()).includes("api_exposed") ? true : undefined),
          {
            timeoutMs: 90_000,
            intervalMs: 5000,
          },
        );
        expect(problemOf(await project.schedule("1.1.0")).code).toBe("blocked");
      },
    );
  });

  it("blocks when its image follows a key it writes (updater_image_unpinned)", async () => {
    // The sidecar's image follows env.versionVar, a key the sidecar itself rewrites.
    await project.reconfigure((config) => {
      config.env = { versionVar: "STUB_APP_VERSION" };
    });
    await withSidecar(
      (updater) => {
        updater.image = `\${STUB_APP_VERSION:-${UPDATER}}`;
      },
      async () => {
        // The Compose probe runs on deep checks; scheduling is one.
        const problem = problemOf(await project.schedule("1.1.0"));
        expect(problem.code).toBe("blocked");
        expect(JSON.stringify(problem.blockers)).toContain("updater_image_unpinned");
      },
    );
    await project.reconfigure((config) => {
      delete config.env;
    });
  });

  it("blocks when another sidecar runs for the project (multiple_updaters)", async () => {
    await withSidecar(
      (_updater, compose) => {
        const services = compose.services as Record<string, Record<string, unknown>>;
        services.updater2 = sidecarService(UPDATER, {
          volumes: [
            "/var/run/docker.sock:/var/run/docker.sock",
            "${PROJECT_DIR:?}:${PROJECT_DIR:?}",
            "updater2-state:/state",
            "updater2-shared:/shared",
            "updater-verify:/verify",
          ],
        });
        (compose.volumes as Record<string, unknown>)["updater2-state"] = {};
        (compose.volumes as Record<string, unknown>)["updater2-shared"] = {};
      },
      async () => {
        await waitFor(
          "multiple_updaters",
          async () => ((await blockers()).includes("multiple_updaters") ? true : undefined),
          { timeoutMs: 90_000, intervalMs: 5000 },
        );
      },
    );
  });
});

describe("cleanup", () => {
  it("prunes old images but keeps the rollback image; retention keeps the protected backup", async () => {
    // A planted backup older than maxAgeDays, as retention finds it after months.
    const old = "lifecycle-20250101-000000Z-0.9.0-to-1.0.0.pgdump";
    await project.compose([
      "exec",
      "-T",
      "updater",
      "sh",
      "-c",
      `mkdir -p /state/backups && printf PGDMP > /state/backups/${old} && printf '{"type":"postgres","bytes":5,"sha256":"${"0".repeat(64)}","createdAt":"2025-01-01T00:00:00.000Z","runId":"r-1735689600000-abcd","fromVersion":"0.9.0","toVersion":"1.0.0","verified":true,"encrypted":false}\\n' > /state/backups/${old}.json`,
    ]);
    const protectedBackup = (await project.state()).history.find(
      (run) => run.outcome === "needs_attention",
    )?.recovery?.backup?.file;
    expect(protectedBackup).toBeTruthy();

    expect((await project.update("1.1.0")).outcome).toBe("succeeded");
    await project.ack();
    const second = await project.update("1.3.0");
    expect(second.outcome).toBe("succeeded");
    await project.ack();

    // Pulled as repository:tag@digest, the images carry no tag: ask by reference.
    const present = async (version: string) =>
      (await docker(["image", "inspect", app.ref(version)], { allowFail: true })).code === 0;
    expect(await present("1.3.0")).toBe(true); // current
    expect(await present("1.1.0")).toBe(true); // rollback image
    expect(await present("1.0.0")).toBe(false); // keepPreviousImages: 0
    expect(await present("1.2.0")).toBe(false);

    const backups = JSON.parse((await project.cli(["backups", "list", "--json"])).stdout) as {
      file: string;
      protected: boolean;
    }[];
    const names = backups.map((backup) => backup.file);
    expect(names).not.toContain(old);
    expect(names).toContain(protectedBackup);
    expect(backups.find((backup) => backup.file === protectedBackup)?.protected).toBe(true);
    // keep: 1 besides the protected one: only the backup of the last run.
    const others = names.filter((name) => name !== protectedBackup);
    expect(others).toHaveLength(1);
    expect(others[0]).toMatch(/^lifecycle-\d{8}-\d{6}Z-1\.1\.0-to-1\.3\.0\.pgdump$/);
  });
});

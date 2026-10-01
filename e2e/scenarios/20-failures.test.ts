import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { q } from "../lib/exec.js";
import { sh } from "../lib/host.js";
import { type Project, problemOf, type RunView } from "../lib/project.js";
import { StubApp } from "../lib/stub.js";

/**
 * Failures after the point of no return (design 5.6): what is rolled back, what ends in
 * needs_attention, and that the recorded recovery commands work when an operator runs
 * them. Also the release refusals of the release policy.
 */

let app: StubApp;
let project: Project;
let baselineEnv: string;

function stepsDone(run: RunView): string[] {
  return run.steps.filter((step) => step.status === "done").map((step) => step.id);
}

beforeAll(async () => {
  app = await StubApp.create({ name: "failures", migrateHook: true, healthTimeoutSeconds: 30 });
  // 1.0.0 creates the probe's table at its first start; later versions migrate in the hook.
  await app.release({ version: "1.0.0", migration: 1, migrateOnStart: true });
  project = await app.install("1.0.0");
  baselineEnv = await project.env();
});

afterAll(async () => {
  await project?.down();
});

describe("rolled back (the probe proves no migration ran)", () => {
  it("health never passes: rolled_back, env file byte-identical, the old containers serve again", async () => {
    await app.release({ version: "1.1.0", health: "unready" });
    const run = await project.update("1.1.0");
    expect(run.failure?.code).toBe("health.timeout");
    expect(run.failure?.schemaChanged).toBe(false);
    expect(run.outcome).toBe("rolled_back");
    expect(await project.env()).toBe(baselineEnv);
    expect(await project.serviceImage("api")).toBe(app.ref("1.0.0"));
    expect(await project.serviceImage("worker")).toBe(app.ref("1.0.0"));
    expect((await project.state()).running.version).toBe("1.0.0");
    expect(await project.sql("SELECT string_agg(version, ',') FROM stub_migrations")).toBe("1");
    await project.ack();
  });

  it("a crash loop fails fast (health.crashed), long before the health timeout", async () => {
    await app.release({ version: "1.2.0", health: "crash" });
    const started = Date.now();
    const run = await project.update("1.2.0");
    expect(run.failure?.code).toBe("health.crashed");
    expect(run.outcome).toBe("rolled_back");
    const health = run.steps.find((step) => step.id === "health");
    expect(health?.status).toBe("failed");
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(await project.env()).toBe(baselineEnv);
    await project.ack();
  });

  it("a wrong version in the health answer is health.version_mismatch", async () => {
    await app.release({ version: "1.3.0", health: "wrong-version" });
    const run = await project.update("1.3.0");
    expect(run.failure?.code).toBe("health.version_mismatch");
    expect(run.outcome).toBe("rolled_back");
    expect(await project.env()).toBe(baselineEnv);
    await project.ack();
  });

  it("a failing migrate hook that changed nothing is rolled back", async () => {
    await app.release({ version: "1.4.0", migration: 4, migrateFail: true });
    const run = await project.update("1.4.0");
    expect(run.failure?.code).toBe("migrate.failed");
    expect(run.failure?.schemaChanged).toBe(false);
    expect(run.outcome).toBe("rolled_back");
    expect(stepsDone(run)).toContain("stop");
    expect(await project.env()).toBe(baselineEnv);
    expect(await project.sql("SELECT string_agg(version, ',') FROM stub_migrations")).toBe("1");
    await project.ack();
  });
});

describe("needs_attention (a migration ran)", () => {
  let run: RunView;

  it("health fails after the migration: needs_attention with the backup and recovery commands", async () => {
    await project.sql("CREATE TABLE IF NOT EXISTS notes (id serial PRIMARY KEY, body text)");
    await project.sql(
      "INSERT INTO notes (body) SELECT 'note ' || g FROM generate_series(1, 250) g",
    );
    await app.release({ version: "1.5.0", migration: 5, health: "unready" });
    run = await project.update("1.5.0");
    expect(run.failure?.code).toBe("health.timeout");
    expect(run.failure?.schemaChanged).toBe(true);
    expect(run.outcome).toBe("needs_attention");
    expect(run.recovery?.backup?.file).toMatch(
      /^failures-\d{8}-\d{6}Z-1\.0\.0-to-1\.5\.0\.pgdump$/,
    );
    expect(run.recovery?.commands.length).toBeGreaterThan(0);
    // stopOnAttention: the managed services are stopped.
    const running = (await project.compose(["ps", "--status", "running", "--services"])).stdout;
    expect(running).not.toMatch(/^api$/m);
    expect(running).not.toMatch(/^worker$/m);
    expect(
      await project.sql("SELECT string_agg(version, ',' ORDER BY version) FROM stub_migrations"),
    ).toBe("1,5");
  });

  it("refuses a new schedule until the run is acknowledged", async () => {
    const problem = problemOf(await project.schedule("1.0.0"));
    expect(["not_finished", "release_refused", "busy", "conflict"]).toContain(problem.code);
  });

  it("the recorded recovery commands bring the previous version and its data back", async () => {
    const shown = JSON.parse((await project.cli(["recover", "show", "--json"])).stdout) as {
      commands: string[];
    };
    expect(shown.commands).toEqual(run.recovery?.commands);
    // Run them as an operator would, in the project directory, one after the other.
    // restore-env asks before it writes; without a terminal that is -T and --yes.
    for (const command of shown.commands) {
      const unattended = command.includes("recover restore-env")
        ? `${command.replace(" exec updater ", " exec -T updater ")} --yes`
        : command;
      await sh(`cd ${q(project.dir)} && ${unattended}`, { timeoutMs: 600_000 });
    }
    expect(await project.env()).toBe(baselineEnv);
    await project.compose(["up", "-d", "--wait", "api", "worker"]);
    expect(await project.serviceImage("api")).toBe(app.ref("1.0.0"));
    expect(await project.sql("SELECT string_agg(version, ',') FROM stub_migrations")).toBe("1");
    expect(await project.sql("SELECT count(*) FROM notes")).toBe("250");
    // pg_restore --clean leaves objects only the new version created (documented).
    expect(await project.sql("SELECT to_regclass('stub_table_5') IS NOT NULL")).toBe("t");
  });

  it("the documented restore into a fresh database gives the exact earlier state", async () => {
    const file = run.recovery?.backup?.file ?? "";
    await project.compose(["stop", "api", "worker"]);
    await sh(
      `cd ${q(project.dir)}
docker compose exec -T db sh -c 'd="\${POSTGRES_DB:-$POSTGRES_USER}"; dropdb -U "$POSTGRES_USER" --if-exists "$d" && createdb -U "$POSTGRES_USER" "$d"'
docker compose --profile updater exec -T updater cicd-updater backups cat ${q(file)} \
  | docker compose exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-$POSTGRES_USER}"'`,
      { timeoutMs: 600_000 },
    );
    await project.compose(["up", "-d", "--wait", "api", "worker"]);
    expect(await project.sql("SELECT to_regclass('stub_table_5') IS NULL")).toBe("t");
    expect(await project.sql("SELECT count(*) FROM notes")).toBe("250");
    await project.ack();
    expect((await project.state()).phase).toBe("idle");
  });
});

describe("release policy refusals", () => {
  it("refuses below the minimum version, manual steps, missing env and a too old updater", async () => {
    const cases: [string, Record<string, unknown>, string][] = [
      ["1.6.0", { minimumFromVersion: "1.2.0" }, "below_minimum_version"],
      [
        "1.7.0",
        {
          manualSteps: {
            required: true,
            summary: "Run the converter first.",
            url: "https://example.com/upgrade",
          },
        },
        "manual_steps_required",
      ],
      ["1.8.0", { requiresEnv: ["STUB_SEARCH_URL"] }, "env_missing"],
      ["1.9.0", { requiresUpdater: ">=9.0.0" }, "updater_too_old"],
    ];
    for (const [version, policy, reason] of cases) {
      await app.release({ version, migration: 1 }, { policy });
      const problem = problemOf(await project.schedule(version));
      expect(problem.code, version).toBe("release_refused");
      expect(problem.reasons, version).toContain(reason);
    }
    expect((await project.state()).phase).toBe("idle");
  });
});

import * as fs from "node:fs/promises";
import type { BlockerCode, FailureCode, Run } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OpsError, type PullFailureKind, type VerifyFailure } from "../src/index.js";
import {
  createHarness,
  DEFAULT_ENV,
  type Harness,
  OLD_APP,
  OLD_WEB,
  pullRef,
  scheduleRequest,
  settle,
  writtenRef,
} from "../src/testing.js";

let h: Harness;

async function fresh(options: Parameters<typeof createHarness>[0] = {}): Promise<void> {
  h = await createHarness(options);
  h.publish("1.1.0");
}

beforeEach(async () => {
  await fresh();
});

afterEach(async () => {
  await h.cleanup();
});

/** Schedule with a lead time, change the world during the countdown, then run. */
async function run(arrange: () => void | Promise<void> = () => undefined): Promise<Run> {
  await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
  await arrange();
  h.clock.advance(60_000);
  await settle(h.engine);
  const view = h.engine.view();
  if (!view.run) {
    throw new Error("no run");
  }
  return view.run;
}

function images(): Record<string, string | undefined> {
  return Object.fromEntries(
    [...h.ops.containers.entries()].map(([name, container]) => [name, container.image]),
  );
}

function states(): Record<string, string | undefined> {
  return Object.fromEntries(
    [...h.ops.containers.entries()].map(([name, container]) => [name, container.state]),
  );
}

function expectUnchanged(result: Run, code: FailureCode): void {
  expect(result.outcome).toBe("unchanged");
  expect(result.failure?.code).toBe(code);
  expect(result.failure?.schemaChanged).toBe(false);
  expect(result.recovery).toBeNull();
  expect(result.message).toEqual({ code: "run.unchanged", params: { code } });
  expect(h.ops.callsTo("stop")).toEqual([]);
  expect(h.ops.callsTo("up")).toEqual([]);
  expect(images()).toMatchObject({ api: OLD_APP, worker: OLD_APP, web: OLD_WEB });
  expect(h.engine.view().phase).toBe("failed");
}

describe("before the point of no return: unchanged", () => {
  it.each<BlockerCode>([
    "docker_unreachable",
    "docker_too_old",
    "compose_missing",
    "compose_invalid",
    "compose_unsupported",
    "project_mismatch",
    "env_unwritable",
    "state_unwritable",
    "disk_space",
    "updater_image_unpinned",
    "multiple_updaters",
    "api_exposed",
    "verifier_unavailable",
  ])("the deep preflight blocker %s fails prepare", async (code) => {
    const result = await run(() => {
      h.preflight.deepBlockers = [{ code, detail: "found at the start of the run" }];
    });
    expectUnchanged(result, `prepare.${code}` as FailureCode);
    expect(result.failure?.step).toBe("prepare");
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("refuses a stored document that changed since scheduling", async () => {
    const result = await run(() => {
      const stored = h.catalog.stored.get("1.1.0");
      if (stored) stored.document = Buffer.from(`${Buffer.from(stored.document).toString()} `);
    });
    expectUnchanged(result, "prepare.release_mismatch");
  });

  it("verifies the stored document again and refuses it when it no longer verifies", async () => {
    const result = await run(() => {
      h.verifier.documentFailure = "signature_invalid";
    });
    expectUnchanged(result, "prepare.release_signature_invalid");
    expect(h.verifier.documentChecks).toHaveLength(2);
  });

  it("refuses when the running version is no longer older, or unknown, at the start", async () => {
    let result = await run(() => {
      h.ops.appBehavior.set(OLD_APP, { kind: "ready", reportsVersion: "1.1.0" });
    });
    expectUnchanged(result, "prepare.not_newer");
    await h.cleanup();
    await fresh();
    result = await run(() => {
      h.ops.appBehavior.set(OLD_APP, { kind: "never" });
    });
    expectUnchanged(result, "prepare.running_version_unknown");
  });

  it("refuses when a required env key disappeared, naming the key only", async () => {
    await h.cleanup();
    await fresh();
    h.publish("1.2.0", (doc) => {
      doc.requires = { env: ["NOTES_DOMAIN"] };
    });
    await h.engine.schedule(scheduleRequest("1.2.0", { leadSeconds: 60 }), "api");
    await fs.writeFile(
      `${h.projectDir}/.env`,
      DEFAULT_ENV.replace("NOTES_DOMAIN=notes.example.com", "NOTES_DOMAIN="),
    );
    h.clock.advance(60_000);
    await settle(h.engine);
    const result = h.engine.view().run as Run;
    expect(result.failure).toMatchObject({ code: "prepare.env_missing", detail: "NOTES_DOMAIN" });
  });

  it("refuses a Compose file that does not take images from the keys, and a sidecar that follows them", async () => {
    expectUnchanged(
      await run(() => {
        h.ops.honoursVariables = false;
      }),
      "prepare.compose_unsupported",
    );
    expect(h.engine.view().run?.failure?.detail).toContain("api, worker, web");
    await h.cleanup();
    await fresh();
    expectUnchanged(
      await run(() => {
        h.ops.updaterImage = "follows";
      }),
      "prepare.updater_image_unpinned",
    );
    await h.cleanup();
    await fresh();
    expectUnchanged(
      await run(() =>
        h.ops.failOn(
          "composeImages",
          new OpsError("Reading the Compose configuration failed.", "yaml: line 3"),
        ),
      ),
      "prepare.compose_invalid",
    );
  });

  it.each<VerifyFailure>([
    "signature_missing",
    "signature_invalid",
    "verifier_failed",
    "registry_unauthorized",
    "registry_unreachable",
    "registry_rate_limited",
    "image_not_found",
  ])("an image signature failure %s fails fetch before any pull", async (failure) => {
    const result = await run(() => {
      h.verifier.imageFailures.set(pullRef("web", "1.1.0"), failure);
    });
    expectUnchanged(result, `fetch.${failure}` as FailureCode);
    expect(result.verification.signatures).toBe("failed");
    expect(result.failure?.detail).toContain(pullRef("web", "1.1.0"));
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(h.backup.runs).toEqual([]);
  });

  it.each<PullFailureKind>([
    "registry_unauthorized",
    "image_not_found",
    "registry_rate_limited",
    "registry_unreachable",
    "pull_failed",
  ])("a classified pull failure %s ends unchanged", async (kind) => {
    const result = await run(() => {
      h.ops.registry.set(pullRef("app", "1.1.0"), kind);
    });
    expectUnchanged(result, `fetch.${kind}` as FailureCode);
    expect(h.backup.runs).toEqual([]);
  });

  it("refuses an image that does not carry the verified digest or carries another version", async () => {
    let result = await run(() => {
      h.ops.pulledInfo.set(pullRef("web", "1.1.0"), {
        id: "sha256:other",
        repoDigests: ["ghcr.io/acme/notes-web@sha256:other"],
        labels: {},
      });
    });
    expectUnchanged(result, "fetch.digest_mismatch");
    expect(result.verification.digests).toBe("failed");
    await h.cleanup();
    await fresh();
    result = await run(() => {
      const ref = pullRef("app", "1.1.0");
      h.ops.pulledInfo.set(ref, {
        id: ref.split("@")[1] as string,
        repoDigests: [ref],
        labels: { "org.opencontainers.image.version": "1.0.9" },
      });
    });
    expectUnchanged(result, "fetch.version_label_mismatch");
    expect(result.failure?.detail).toContain("1.0.9");
  });

  it("accepts an image known by its ID only (containerd image store)", async () => {
    const result = await run(() => {
      const ref = pullRef("app", "1.1.0");
      h.ops.pulledInfo.set(ref, {
        id: ref.split("@")[1] as string,
        repoDigests: [],
        labels: { "org.opencontainers.image.version": "1.1.0" },
      });
    });
    expect(result.outcome).toBe("succeeded");
  });

  it("fails the backup step when the baseline cannot be read, before any backup", async () => {
    const result = await run(() => {
      h.hooks.probe.failures.push(0);
    });
    expectUnchanged(result, "backup.baseline_unavailable");
    expect(h.backup.runs).toEqual([]);
  });

  it.each([
    ["insufficient_space", "backup.insufficient_space"],
    ["failed", "backup.failed"],
    ["timeout", "backup.timeout"],
    ["verify_failed", "backup.verify_failed"],
  ] as const)("a backup failure %s ends unchanged and leaves no file", async (kind, code) => {
    const result = await run(() => {
      h.backup.failWith = { kind, detail: "pg_dump: error: connection to server failed" };
    });
    expectUnchanged(result, code);
    expect(await h.backups.list()).toEqual([]);
    expect(await fs.readdir(h.backups.directory)).toEqual([]);
  });
});

describe("abort", () => {
  it("aborts a PostgreSQL backup mid-way: unchanged, code aborted, no backup left", async () => {
    h.backup.hangUntilAborted = true;
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    for (let i = 0; i < 200 && h.backup.runs.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const runId = h.engine.view().run?.id ?? "";
    const outcome = await h.engine.cancel(runId, {
      id: "u",
      label: "admin@example.com",
      via: "api",
    });
    expect(outcome).toBe("abort_requested");
    await settle(h.engine);
    const result = h.engine.view().run as Run;
    expect(result.outcome).toBe("unchanged");
    expect(result.failure?.code).toBe("aborted");
    expect(result.abortRequestedAt).not.toBeNull();
    expect(await h.backups.list()).toEqual([]);
    expect(h.engine.view().events.map((event) => event.action)).toEqual([
      "update.scheduled",
      "update.started",
      "update.abort_requested",
      "update.failed",
    ]);
  });

  it("aborts between images", async () => {
    const original = h.ops.pull.bind(h.ops);
    let cancelled = false;
    h.ops.pull = async (ref) => {
      await original(ref);
      if (!cancelled) {
        cancelled = true;
        await h.engine.cancel(h.engine.view().run?.id ?? "", {
          id: null,
          label: "ops",
          via: "cli",
        });
      }
    };
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await settle(h.engine);
    const result = h.engine.view().run as Run;
    expect(result.failure?.code).toBe("aborted");
    expect(h.ops.callsTo("pull")).toHaveLength(1);
    expect(h.backup.runs).toEqual([]);
  });

  it("refuses to abort after the point of no return", async () => {
    let refusal: unknown = null;
    const original = h.ops.up.bind(h.ops);
    h.ops.up = async (services) => {
      refusal ??= await h.engine
        .cancel(h.engine.view().run?.id ?? "", { id: null, label: "ops", via: "api" })
        .catch((error) => error);
      return original(services);
    };
    await h.engine.schedule(scheduleRequest("1.1.0"), "api");
    await settle(h.engine);
    expect(refusal).toMatchObject({ code: "point_of_no_return" });
    expect(h.engine.view().run?.outcome).toBe("succeeded");
  });
});

describe("after the point of no return, before anything new ran: rollback", () => {
  it("a failing stop restarts the previous services and leaves the env file alone", async () => {
    const result = await run(() =>
      h.ops.failOn("stop", new OpsError("Stopping services failed.", "timeout"), 0),
    );
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "stop.failed",
      step: "stop",
      schemaChanged: false,
    });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(h.ops.callsTo("up")).toEqual(["up api", "up worker", "up web"]);
    expect(states()).toMatchObject({ api: "running", worker: "running", web: "running" });
    // Nothing new ran: no freeze, no probe after the baseline.
    expect(h.hooks.probe.reads).toBe(1);
    expect(result.message).toEqual({ code: "run.rolled_back", params: { code: "stop.failed" } });
  });

  it("a failing quiesced backup rolls back (the stop came first)", async () => {
    await h.cleanup();
    await fresh({
      configure: (config) => {
        config.hooks = {
          ...config.hooks,
          backup: { type: "postgres", service: "db", quiesce: true },
        };
      },
    });
    const result = await run(() => {
      h.backup.failWith = { kind: "failed", detail: "pg_dump failed" };
    });
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("backup.failed");
    expect(states()).toMatchObject({ worker: "running" });
  });

  it("an env file edited during the run is not overwritten", async () => {
    // Same image, different line: the operator's line stays as they wrote it.
    const edited = DEFAULT_ENV.replace(`APP_IMAGE=${OLD_APP}`, `APP_IMAGE="${OLD_APP}"`);
    const original = h.ops.stop.bind(h.ops);
    h.ops.stop = async (services, timeout) => {
      await fs.writeFile(`${h.projectDir}/.env`, edited);
      return original(services, timeout);
    };
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "start.env_changed",
      detail: "The env file lines of APP_IMAGE changed during the run.",
    });
    expect(await h.readEnv()).toBe(edited);
    expect(h.ops.callsTo("up")).toEqual(["up api", "up worker", "up web"]);
  });

  it("an env file that cannot be written rolls back", async () => {
    const original = h.envFile.apply.bind(h.envFile);
    h.envFile.apply = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const result = await run();
    h.envFile.apply = original;
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("start.env_write_failed");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });
});

describe("after new images were applied: the rollback rule", () => {
  it("a failing compose up: freeze, probe unchanged, roll back byte-exact", async () => {
    const result = await run(() =>
      h.ops.failOn("up", new OpsError("Starting services failed.", "no such image"), 0),
    );
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "start.failed",
      step: "start",
      schemaChanged: false,
    });
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(images()).toMatchObject({ api: OLD_APP, worker: OLD_APP, web: OLD_WEB });
    const freeze = h.ops.calls.indexOf("stop api -t 60");
    expect(freeze).toBeGreaterThan(-1);
    expect(h.hooks.probe.reads).toBe(2);
  });

  it("a health timeout without schema change rolls back, with the log tail in the detail", async () => {
    h.appAt("1.1.0", { kind: "never" });
    const started = h.clock.now().getTime();
    const result = await run();
    const elapsed = (h.clock.now().getTime() - started) / 1000;
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure).toMatchObject({
      code: "health.timeout",
      step: "health",
      schemaChanged: false,
    });
    expect(result.failure?.detail).toContain("migration 0042 failed");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
    expect(images()).toMatchObject({ api: OLD_APP, worker: OLD_APP, web: OLD_WEB });
    expect(elapsed).toBeGreaterThanOrEqual(600);
    expect(result.steps.find((step) => step.id === "health")?.status).toBe("failed");
    expect(result.steps.find((step) => step.id === "finish")?.status).toBe("skipped");
    const order = h.ops.calls.filter((call) => /^(stop|up) /.test(call));
    expect(order).toEqual([
      "stop worker -t 60",
      "up api",
      "stop api -t 60",
      "up api",
      "up worker",
      "up web",
    ]);
  });

  it("restores a key that was absent to absent, and keeps comments, order and mode", async () => {
    await h.cleanup();
    const original =
      "# my settings\r\nPOSTGRES_PASSWORD=pw-pw-pw-pw\r\n# no image keys here\r\nSECRET_KEY=zzzzzzzzzzzz";
    await fresh({ env: original });
    // The Compose file has defaults: image: ${APP_IMAGE:-notes:local}.
    h.ops.defaults.APP_IMAGE = "notes:local";
    h.ops.defaults.WEB_IMAGE = "notes-web:local";
    h.ops.installAt({ app: "notes:local", web: "notes-web:local" }, "1.0.0");
    await fs.chmod(`${h.projectDir}/.env`, 0o640);
    h.appAt("1.1.0", { kind: "never" });
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(await h.readEnv()).toBe(original);
    expect((await fs.stat(`${h.projectDir}/.env`)).mode & 0o777).toBe(0o640);
  });

  it("a crash loop fails fast", async () => {
    h.appAt("1.1.0", { kind: "crash" });
    const started = h.clock.now().getTime();
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("health.crashed");
    expect(result.failure?.detail).toContain("restarting");
    // 60 s of lead time plus a few polls, far below the 600 s health timeout.
    expect((h.clock.now().getTime() - started) / 1000).toBeLessThan(90);
  });

  it("an app that answers with another version fails with health.version_mismatch", async () => {
    h.appAt("1.1.0", { kind: "ready", reportsVersion: "1.0.5" });
    const result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.code).toBe("health.version_mismatch");
    expect(result.failure?.detail).toContain("1.0.5");
  });

  it("waits for a slow app instead of failing early", async () => {
    h.appAt("1.1.0", { kind: "ready", afterPolls: 40, reportsVersion: "1.1.0" });
    expect((await run()).outcome).toBe("succeeded");
  });

  it("a failing per-service check fails with health.unhealthy", async () => {
    await h.cleanup();
    await fresh({
      configure: (config) => {
        const web = config.services.find((service) => service.name === "web");
        if (web) web.health = { type: "http", url: "http://web:8080/healthz" };
      },
    });
    h.hooks.checkResults.set("http://web:8080/healthz", [{ ok: false, detail: "HTTP 503" }]);
    const result = await run();
    expect(result.failure).toMatchObject({ code: "health.unhealthy", detail: "web: HTTP 503" });
    expect(result.outcome).toBe("rolled_back");
  });

  it("a failing smoke check rolls back when the schema is unchanged", async () => {
    await h.cleanup();
    await fresh({
      configure: (config) => {
        config.hooks = {
          ...config.hooks,
          smoke: { checks: [{ type: "http", url: "http://web:8080/" }], retries: 2 },
        };
      },
    });
    h.hooks.checkResults.set("http://web:8080/", [{ ok: false, detail: "HTTP 500 body: oops" }]);
    const result = await run();
    expect(result.failure).toMatchObject({ code: "smoke.failed", step: "smoke" });
    expect(result.failure?.detail).toContain("check 1: HTTP 500");
    expect(result.outcome).toBe("rolled_back");
  });

  it("a failure after the schema changed stops the app, keeps the backup and hands over recovery", async () => {
    h.appAt("1.1.0", { kind: "never", migrates: 3 });
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure).toMatchObject({
      code: "health.timeout",
      step: "health",
      schemaChanged: true,
    });
    expect(result.message).toEqual({
      code: "run.needs_attention",
      params: { code: "health.timeout" },
    });
    expect(states()).toMatchObject({ api: "exited", worker: "exited", web: "running" });
    expect(images()).toMatchObject({ api: writtenRef("app", "1.1.0"), web: OLD_WEB });
    expect(await h.readEnv()).toContain(`APP_IMAGE=${writtenRef("app", "1.1.0")}`);
    const backups = await h.backups.list();
    expect(backups).toHaveLength(1);
    expect(result.recovery).toMatchObject({
      backup: {
        file: backups[0]?.file,
        bytes: backups[0]?.bytes,
        type: "postgres",
        encrypted: false,
      },
      fromVersion: "1.0.0",
      previousImages: { api: OLD_APP, worker: OLD_APP, web: OLD_WEB },
      previousEnv: {
        APP_IMAGE: { present: true, line: `APP_IMAGE=${OLD_APP}` },
        WEB_IMAGE: { present: true, line: `WEB_IMAGE="${OLD_WEB}" # pinned by hand` },
      },
    });
    expect(result.recovery?.commands).toEqual([
      "docker compose -p notes stop api worker",
      `docker compose -p notes exec -T updater cicd-updater backups cat ${backups[0]?.file} | docker compose -p notes exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'`,
      `docker compose -p notes exec -T updater cicd-updater recover restore-env ${result.id}`,
      "docker compose -p notes up -d",
    ]);
    expect(h.engine.view().events.at(-1)?.details).toMatchObject({
      outcome: "needs_attention",
      schemaChanged: true,
    });
  });

  it("does not guess when the probe fails after the update", async () => {
    h.appAt("1.1.0", { kind: "never" });
    const result = await run(() => {
      h.hooks.probe.failures.push(1);
    });
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.schemaChanged).toBeNull();
  });

  it("does not trust an unchanged probe when the new version could not be frozen", async () => {
    h.appAt("1.1.0", { kind: "never" });
    const result = await run(() =>
      h.ops.failOn("stop", new OpsError("Stopping services failed."), 1),
    );
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.schemaChanged).toBeNull();
    expect(h.hooks.probe.reads).toBe(1);
  });

  it("a rollback that fails itself ends in needs_attention with both details", async () => {
    h.appAt("1.1.0", { kind: "never" });
    // The running version comes from the image label once the old app stops answering.
    h.ops.imageLabels.set(OLD_APP, { "org.opencontainers.image.version": "1.0.0" });
    const result = await run(() => {
      h.ops.appBehavior.set(OLD_APP, { kind: "never" });
    });
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.code).toBe("health.timeout");
    expect(result.failure?.detail).toContain("Rollback failed");
    expect(result.failure?.detail.length).toBeLessThanOrEqual(2000);
    expect(result.failure?.schemaChanged).toBe(false);
    expect(result.recovery?.backup?.file).toMatch(/\.pgdump$/);
  });

  it("a rollback that cannot restore the env file ends in needs_attention", async () => {
    h.appAt("1.1.0", { kind: "never" });
    h.envFile.restore = async () => {
      throw new Error("EROFS: read-only file system");
    };
    const result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.detail).toContain("EROFS");
  });

  it("reports when the services could not be stopped for the operator", async () => {
    h.appAt("1.1.0", { kind: "never", migrates: 1 });
    // Calls: 0 stops the worker, 1 freezes api, 2 stops api and worker for the operator.
    const result = await run(() =>
      h.ops.failOn("stop", new OpsError("Stopping services failed.", "daemon busy"), 2),
    );
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.detail).toContain("could not be stopped completely");
  });

  it("policy never: needs_attention without probing; policy always: rolls back without probing", async () => {
    await h.cleanup();
    await fresh({
      configure: (config) => {
        config.hooks = { ...config.hooks, migrationProbe: { type: "none" } };
        config.rollback = { policy: "never" };
      },
    });
    h.appAt("1.1.0", { kind: "never" });
    let result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.schemaChanged).toBeNull();
    expect(h.hooks.probe.reads).toBe(0);

    await h.cleanup();
    await fresh({
      configure: (config) => {
        config.hooks = {
          ...config.hooks,
          backup: { type: "none" },
          migrationProbe: { type: "none" },
        };
        config.rollback = { policy: "always" };
      },
    });
    h.appAt("1.1.0", { kind: "never", migrates: 5 });
    result = await run();
    expect(result.outcome).toBe("rolled_back");
    expect(result.failure?.schemaChanged).toBeNull();
    expect(result.steps.find((step) => step.id === "backup")?.status).toBe("skipped");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);
  });

  it("the migrate hook: failure without schema change rolls back, with change needs attention, timeout removes the container", async () => {
    const configure = (
      config: Parameters<NonNullable<Parameters<typeof createHarness>[0]>["configure"] & {}>[0],
    ) => {
      config.hooks = { ...config.hooks, migrate: { service: "api", argv: ["migrate"] } };
    };
    await h.cleanup();
    await fresh({ configure });
    h.ops.migrateBehavior.set(writtenRef("app", "1.1.0"), { exitCode: 1 });
    let result = await run();
    expect(result.failure).toMatchObject({ code: "migrate.failed", step: "migrate" });
    expect(result.failure?.detail).toContain("exit code 1");
    expect(result.outcome).toBe("rolled_back");
    expect(await h.readEnv()).toBe(DEFAULT_ENV);

    await h.cleanup();
    await fresh({ configure });
    h.ops.migrateBehavior.set(writtenRef("app", "1.1.0"), { exitCode: 1, migrates: 1 });
    result = await run();
    expect(result.outcome).toBe("needs_attention");
    expect(result.failure?.schemaChanged).toBe(true);
    // The env file was never written: the new references lived in the process environment only.
    expect(await h.readEnv()).toBe(DEFAULT_ENV);

    await h.cleanup();
    await fresh({ configure });
    h.ops.migrateBehavior.set(writtenRef("app", "1.1.0"), { timesOut: true });
    result = await run();
    expect(result.failure?.code).toBe("migrate.timeout");
    expect(
      h.ops.callsTo("removeContainer").some((call) => call.includes("cicd-updater-migrate-")),
    ).toBe(true);
  });

  it("protects the backup of the newest needs_attention run from retention", async () => {
    h.appAt("1.1.0", { kind: "never", migrates: 1 });
    const attention = await run();
    const needed = attention.recovery?.backup?.file as string;
    for (const day of ["01", "02", "03"]) {
      await fs.writeFile(
        `${h.backups.directory}/notes-202701${day}-120000Z-1.0.0-to-1.1.0.pgdump`,
        "PGDMP-newer",
      );
    }
    // The operator restored the installation by hand; 1.1.0 runs.
    h.ops.appBehavior.set(writtenRef("app", "1.1.0"), { kind: "ready", reportsVersion: "1.1.0" });
    await h.ops.up(["api", "worker"]);
    await h.engine.acknowledge(attention.id, { id: null, label: "ops", via: "cli" });
    h.publish("1.2.0");
    h.clock.advance(10_000);
    await h.engine.schedule(scheduleRequest("1.2.0"), "api");
    await settle(h.engine);
    expect(h.engine.view().run?.outcome).toBe("succeeded");
    const files = (await h.backups.list()).map((backup) => backup.file);
    expect(files).toContain(needed);
    expect(files).toHaveLength(4);
  });
});

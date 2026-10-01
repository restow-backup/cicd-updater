import * as fs from "node:fs/promises";
import { journalEventSchema, runSchema, STEP_IDS, statusFileSchema } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { EngineError } from "../src/index.js";
import {
  createHarness,
  DEFAULT_ENV,
  digestOf,
  type Harness,
  OLD_APP,
  OLD_WEB,
  pullRef,
  releaseDigest,
  scheduleRequest,
  settle,
  writtenRef,
} from "../src/testing.js";

let h: Harness;

beforeEach(async () => {
  h = await createHarness();
});

afterEach(async () => {
  await h.cleanup();
});

async function runToEnd(version = "1.1.0") {
  await h.engine.schedule(scheduleRequest(version), "api");
  await settle(h.engine);
  return h.engine.view();
}

describe("image mode, keyless: success", () => {
  beforeEach(() => {
    h.publish("1.1.0");
    h.appAt("1.1.0", { kind: "ready", migrates: 2, reportsVersion: "1.1.0" });
  });

  it("runs every step and rewrites only the writable keys, byte for byte", async () => {
    const view = await runToEnd();
    expect(view.phase).toBe("succeeded");
    const run = view.run;
    expect(run?.outcome).toBe("succeeded");
    expect(run?.fromVersion).toBe("1.0.0");
    expect(run?.targetVersion).toBe("1.1.0");
    expect(run?.targetTag).toBe("v1.1.0");
    expect(run?.trustMode).toBe("keyless");
    expect(run?.release.document).toBe("verified");
    expect(run?.verification).toEqual({ signatures: "verified", digests: "verified" });
    expect(run?.images).toEqual({
      api: writtenRef("app", "1.1.0"),
      worker: writtenRef("app", "1.1.0"),
      web: writtenRef("web", "1.1.0"),
    });
    expect(run?.steps.map((step) => [step.id, step.status])).toEqual([
      ["prepare", "done"],
      ["fetch", "done"],
      ["backup", "done"],
      ["stop", "done"],
      ["migrate", "skipped"],
      ["start", "done"],
      ["health", "done"],
      ["smoke", "skipped"],
      ["finish", "done"],
    ]);
    expect(run?.progress).toBe(100);
    expect(run?.message).toEqual({ code: "run.succeeded", params: { version: "1.1.0" } });

    // The env file: two lines changed (the quoted one loses its quotes and comment), nothing else.
    expect(await h.readEnv()).toBe(
      DEFAULT_ENV.replace(
        `APP_IMAGE=${OLD_APP}`,
        `APP_IMAGE=${writtenRef("app", "1.1.0")}`,
      ).replace(
        `WEB_IMAGE="${OLD_WEB}" # pinned by hand`,
        `WEB_IMAGE=${writtenRef("web", "1.1.0")}`,
      ),
    );
    expect(h.ops.containers.get("api")?.image).toBe(writtenRef("app", "1.1.0"));
    expect(h.ops.containers.get("web")?.image).toBe(writtenRef("web", "1.1.0"));
    expect(await h.backups.list()).toHaveLength(1);
  });

  it("orders the side effects: verify, pull, baseline, backup, stop, up per group", async () => {
    await runToEnd();
    const relevant = h.ops.calls.filter((call) => /^(pull|stop|up) /.test(call));
    expect(relevant).toEqual([
      `pull ${pullRef("app", "1.1.0")}`,
      `pull ${pullRef("web", "1.1.0")}`,
      "stop worker -t 60",
      "up api",
      "up worker",
      "up web",
    ]);
    // Verified as a dry run when scheduling, and again before the pull.
    expect(h.verifier.imageChecks.map((check) => check.ref)).toEqual([
      pullRef("app", "1.1.0"),
      pullRef("web", "1.1.0"),
      pullRef("app", "1.1.0"),
      pullRef("web", "1.1.0"),
    ]);
    expect(
      h.verifier.imageChecks.every((check) => check.tag === "v1.1.0" && check.version === "1.1.0"),
    ).toBe(true);
    // The document was verified when scheduling and again at the start of the run.
    expect(h.verifier.documentChecks).toHaveLength(2);
    // The baseline was read before the backup.
    expect(h.hooks.probe.reads).toBe(1);
    expect(h.backup.runs).toEqual([{ runId: h.engine.view().run?.id, toVersion: "1.1.0" }]);
  });

  it("keeps progress monotonic and every state document valid", async () => {
    const seen: number[] = [];
    const original = h.store.save.bind(h.store);
    h.store.save = () => {
      seen.push(h.store.state.run?.progress ?? 0);
      expect(statusFileSchema.safeParse(JSON.parse(JSON.stringify(h.store.state))).success).toBe(
        true,
      );
      return original();
    };
    await runToEnd();
    expect(seen.length).toBeGreaterThan(10);
    for (let index = 1; index < seen.length; index++) {
      expect(seen[index] as number).toBeGreaterThanOrEqual(seen[index - 1] as number);
    }
    expect(seen.at(-1)).toBe(100);
  });

  it("journals scheduled, started and succeeded with sortable ids and the promised details", async () => {
    await runToEnd();
    const events = h.engine.view().events;
    expect(events.map((event) => event.action)).toEqual([
      "update.scheduled",
      "update.started",
      "update.succeeded",
    ]);
    for (const event of events) {
      expect(journalEventSchema.safeParse(event).success).toBe(true);
      expect(event.actor).toEqual({ id: "user-1", label: "admin@example.com", via: "api" });
      expect(event.target).toBe("1.1.0");
    }
    expect(events[2]?.details).toMatchObject({
      mode: "image",
      outcome: "succeeded",
      failureCode: null,
      fromVersion: "1.0.0",
      targetVersion: "1.1.0",
      trustMode: "keyless",
      verification: { signatures: "verified", digests: "verified" },
    });
    expect((events[2]?.details as { backupFile?: string } | undefined)?.backupFile).toMatch(
      /^notes-\d{8}-\d{6}Z-1\.0\.0-to-1\.1\.0\.pgdump$/,
    );
    expect([...events.map((event) => event.id)].sort()).toEqual(events.map((event) => event.id));
  });

  it("produces runs that match the API schema and keeps at most 200 short log lines", async () => {
    const view = await runToEnd();
    expect(runSchema.safeParse(view.run).success).toBe(true);
    expect(view.run?.log.length).toBeGreaterThan(5);
    expect(view.run?.log.length).toBeLessThanOrEqual(200);
    expect(view.run?.log.every((line) => line.length < 450)).toBe(true);
  });

  it("puts only versions, codes and counts into messages, never images, files or paths", async () => {
    const messages: string[] = [];
    const original = h.store.save.bind(h.store);
    h.store.save = () => {
      const message = h.store.state.run?.message;
      if (message) {
        messages.push(JSON.stringify(message));
      }
      return original();
    };
    await runToEnd();
    expect(messages.length).toBeGreaterThan(10);
    for (const message of messages) {
      expect(message).not.toMatch(/ghcr\.io|sha256|\.pgdump|\/state|\/tmp|worker|\bweb\b/);
    }
    const log = (h.engine.view().run?.log ?? []).join("\n");
    expect(log).toContain(pullRef("app", "1.1.0"));
    expect(log).toMatch(/notes-\d{8}-\d{6}Z-1\.0\.0-to-1\.1\.0\.pgdump/);
  });

  it("moves the finished run into the history and clears it on acknowledge", async () => {
    const view = await runToEnd();
    expect(view.history).toHaveLength(1);
    expect("log" in (view.history[0] ?? {})).toBe(false);
    await expect(
      h.engine.acknowledge("r-0-0000", { id: null, label: "x", via: "api" }),
    ).rejects.toMatchObject({
      code: "not_found",
    });
    await h.engine.acknowledge(view.run?.id ?? "", {
      id: "user-2",
      label: "other@example.com",
      via: "api",
    });
    const after = h.engine.view();
    expect(after.phase).toBe("idle");
    expect(after.run).toBeNull();
    expect(after.history[0]?.outcome).toBe("succeeded");
    expect(after.events.at(-1)).toMatchObject({
      action: "update.acknowledged",
      actor: { label: "other@example.com" },
    });
  });

  it("prunes images keeping the new and the previous references", async () => {
    await runToEnd();
    expect(h.ops.prunes).toHaveLength(1);
    expect(h.ops.prunes[0]?.keep).toEqual(
      expect.arrayContaining([
        writtenRef("app", "1.1.0"),
        writtenRef("web", "1.1.0"),
        OLD_APP,
        OLD_WEB,
      ]),
    );
    expect(h.ops.prunes[0]?.repositories).toEqual(
      expect.arrayContaining(["ghcr.io/acme/notes", "ghcr.io/acme/notes-web"]),
    );
    expect(h.ops.prunes[0]?.keepCount).toBe(1);
    expect(h.catalog.prunes).toBe(1);
  });

  it("keeps the configured number of backups", async () => {
    for (const [index, version] of ["1.1.0", "1.2.0", "1.3.0", "1.4.0"].entries()) {
      h.publish(version);
      h.clock.advance((index + 1) * 5000);
      await h.engine.schedule(scheduleRequest(version), "api");
      await settle(h.engine);
      expect(h.engine.view().run?.outcome, version).toBe("succeeded");
    }
    expect(await h.backups.list()).toHaveLength(3);
  });
});

describe("other configurations", () => {
  it("records 'not checked' in trust mode none but still requires and checks the digests", async () => {
    await h.cleanup();
    h = await createHarness({
      configure: (config) => {
        config.trust = { mode: "none", none: { acknowledgeUnsigned: true } };
      },
    });
    h.publish("1.1.0");
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.trustMode).toBe("none");
    expect(view.run?.release.document).toBe("not_checked");
    expect(view.run?.verification).toEqual({ signatures: "not_checked", digests: "verified" });
    expect(
      view.run?.log.some((line) => line.includes("Signature not checked (trust mode none)")),
    ).toBe(true);
    expect(view.events.at(-1)?.details).toMatchObject({ trustMode: "none" });
  });

  it("keeps an optional service on its image when the release lacks its key", async () => {
    await h.cleanup();
    h = await createHarness({
      configure: (config) => {
        const web = config.services.find((service) => service.name === "web");
        if (web) web.optional = true;
      },
    });
    h.catalog.add(
      "1.1.0",
      (await import("../src/testing.js")).releaseDocument("1.1.0", undefined, ["app"]),
    );
    h.appAt("1.1.0", { kind: "ready", reportsVersion: "1.1.0" });
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(view.run?.images).toEqual({
      api: writtenRef("app", "1.1.0"),
      worker: writtenRef("app", "1.1.0"),
    });
    const env = await h.readEnv();
    expect(env).toContain(`WEB_IMAGE="${OLD_WEB}" # pinned by hand`);
    expect(h.ops.callsTo("pull")).toEqual([`pull ${pullRef("app", "1.1.0")}`]);
  });

  it("writes env.versionVar and the migrate hook runs with the new references in the process environment only", async () => {
    await h.cleanup();
    h = await createHarness({
      configure: (config) => {
        config.env = { versionVar: "APP_VERSION" };
        config.hooks = {
          ...config.hooks,
          migrate: { service: "api", argv: ["npm", "run", "migrate"] },
        };
      },
    });
    h.publish("1.1.0");
    let envDuringMigrate = "";
    const original = h.ops.runOnce.bind(h.ops);
    h.ops.runOnce = async (spec) => {
      envDuringMigrate = await h.readEnv();
      expect(spec.env).toEqual({
        APP_IMAGE: writtenRef("app", "1.1.0"),
        WEB_IMAGE: writtenRef("web", "1.1.0"),
        APP_VERSION: "1.1.0",
      });
      return await original(spec);
    };
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(envDuringMigrate).toBe(DEFAULT_ENV);
    expect(view.run?.steps.find((step) => step.id === "migrate")?.status).toBe("done");
    expect(await h.readEnv()).toContain("APP_VERSION=1.1.0");
    expect(h.ops.callsTo("runOnce")[0]).toMatch(
      /^runOnce cicd-updater-migrate-r-\d+-[0-9a-f]{4} api npm run migrate$/,
    );
  });

  it("stops before backing up in quiesce order", async () => {
    await h.cleanup();
    h = await createHarness({
      configure: (config) => {
        config.hooks = {
          ...config.hooks,
          backup: { type: "postgres", service: "db", quiesce: true },
        };
      },
    });
    h.publish("1.1.0");
    const view = await runToEnd();
    expect(view.run?.steps.map((step) => step.id)).toEqual([
      "prepare",
      "fetch",
      "stop",
      "backup",
      "migrate",
      "start",
      "health",
      "smoke",
      "finish",
    ]);
    const stopIndex = h.ops.calls.findIndex((call) => call.startsWith("stop "));
    expect(stopIndex).toBeGreaterThan(-1);
    expect(view.run?.outcome).toBe("succeeded");
  });

  it("runs the smoke checks with retries and the per-service checks", async () => {
    await h.cleanup();
    h = await createHarness({
      configure: (config) => {
        config.hooks = {
          ...config.hooks,
          smoke: {
            checks: [{ type: "http", url: "http://web:8080/" }],
            retries: 3,
            intervalSeconds: 1,
          },
        };
        const web = config.services.find((service) => service.name === "web");
        if (web) web.health = { type: "http", url: "http://web:8080/healthz" };
      },
    });
    h.publish("1.1.0");
    h.hooks.checkResults.set("http://web:8080/", [
      { ok: false, detail: "HTTP 502" },
      { ok: true, detail: "HTTP 200" },
    ]);
    const view = await runToEnd();
    expect(view.run?.outcome).toBe("succeeded");
    expect(
      h.hooks.checks.map((check) => (check.type === "http" ? check.url : check.service)),
    ).toEqual(["http://web:8080/healthz", "http://web:8080/", "http://web:8080/"]);
  });

  it("builds from source in source mode and records signatures as not applicable", async () => {
    h.source.allowedValue = true;
    h.publish("1.1.0");
    h.ops.appBehavior.set("cicd-updater.local/notes/app:1.1.0", {
      kind: "ready",
      reportsVersion: "1.1.0",
    });
    await h.engine.schedule(scheduleRequest("1.1.0", { mode: "source" }), "cli");
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("succeeded");
    expect(run?.mode).toBe("source");
    expect(run?.verification).toEqual({ signatures: "not_applicable", digests: "not_applicable" });
    expect(run?.requestedBy.via).toBe("cli");
    expect(run?.images.api).toBe("cicd-updater.local/notes/app:1.1.0");
    expect(h.source.builds).toEqual([{ version: "1.1.0", tag: "v1.1.0", keys: ["app", "web"] }]);
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(h.verifier.imageChecks).toEqual([]);
    expect(await h.readEnv()).toContain("APP_IMAGE=cicd-updater.local/notes/app:1.1.0");
  });
});

describe("scheduling", () => {
  beforeEach(() => {
    h.publish("1.1.0");
  });

  it("counts down, starts at startsAt and can be cancelled before", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 300 }), "api");
    let view = h.engine.view();
    expect(view.phase).toBe("scheduled");
    expect(view.run?.message?.code).toBe("run.scheduled");
    expect(Date.parse(view.run?.startsAt ?? "") - Date.parse(view.run?.scheduledAt ?? "")).toBe(
      300_000,
    );
    expect(view.run?.leadSeconds).toBe(300);
    expect(h.ops.callsTo("pull")).toEqual([]);
    // The verified document is kept for the run.
    expect(h.catalog.stored.has("1.1.0")).toBe(true);

    await h.engine.cancel(view.run?.id ?? "", { id: "u", label: "admin@example.com", via: "api" });
    view = h.engine.view();
    expect(view.phase).toBe("idle");
    expect(view.history[0]).toMatchObject({ cancelled: true, outcome: null });
    expect(h.clock.pendingTimers).toBe(0);
    h.clock.advance(600_000);
    expect(h.engine.view().phase).toBe("idle");
    expect(view.events.map((event) => event.action)).toEqual([
      "update.scheduled",
      "update.cancelled",
    ]);
  });

  it("starts by itself when the lead time is over, or at an absolute time", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
    h.clock.advance(59_000);
    expect(h.engine.view().phase).toBe("scheduled");
    h.clock.advance(1000);
    await settle(h.engine);
    expect(h.engine.view().phase).toBe("succeeded");

    h.publish("1.2.0");
    const at = new Date(h.clock.now().getTime() + 3_600_000).toISOString();
    await h.engine.schedule(
      scheduleRequest("1.2.0", { leadSeconds: undefined, startsAt: at }),
      "api",
    );
    expect(h.engine.view().run).toMatchObject({ startsAt: at, leadSeconds: null });
  });

  it("reschedules a scheduled run and refuses to reschedule anything else", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
    const runId = h.engine.view().run?.id ?? "";
    const actor = { id: null, label: "ops", via: "cli" as const };
    await h.engine.reschedule(runId, { leadSeconds: 3600 }, actor);
    expect(h.engine.view().run?.message?.code).toBe("run.rescheduled");
    h.clock.advance(120_000);
    expect(h.engine.view().phase).toBe("scheduled");
    await expect(
      h.engine.reschedule(runId, { leadSeconds: 9_999_999 }, actor),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await h.engine.reschedule(runId, { leadSeconds: 0 }, actor);
    await settle(h.engine);
    expect(h.engine.view().phase).toBe("succeeded");
    await expect(h.engine.reschedule(runId, { leadSeconds: 10 }, actor)).rejects.toMatchObject({
      code: "not_scheduled",
    });
    expect(h.engine.view().events.map((event) => event.action)).toContain("update.rescheduled");
  });

  it("allows one run at a time and replaces a finished run, acknowledging it implicitly", async () => {
    await h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api");
    await expect(h.engine.schedule(scheduleRequest("1.1.0"), "api")).rejects.toMatchObject({
      code: "busy",
    });
    h.clock.advance(60_000);
    await settle(h.engine);
    expect(h.engine.view().phase).toBe("succeeded");
    h.publish("1.2.0");
    h.clock.advance(5000);
    await h.engine.schedule(scheduleRequest("1.2.0"), "api");
    await settle(h.engine);
    const view = h.engine.view();
    expect(view.run?.targetVersion).toBe("1.2.0");
    expect(view.history.map((entry) => entry.targetVersion)).toEqual(["1.2.0", "1.1.0"]);
    expect(view.events.find((event) => event.action === "update.acknowledged")?.details).toEqual({
      implicit: true,
    });
  });

  it("does not let two concurrent schedule calls both pass", async () => {
    const results = await Promise.allSettled([
      h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api"),
      h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 60 }), "api"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const rejected = results.find(
      (result) => result.status === "rejected",
    ) as PromiseRejectedResult;
    expect((rejected.reason as EngineError).code).toBe("busy");
  });

  it("refuses unverifiable, unknown and refused releases before announcing anything", async () => {
    const refuse = async (version: string, code: string) => {
      const error = await h.engine
        .schedule(scheduleRequest(version), "api")
        .catch((caught: unknown) => caught);
      expect(error, version).toBeInstanceOf(EngineError);
      expect((error as EngineError).code, version).toBe(code);
      expect(h.engine.view().phase).toBe("idle");
      return error as EngineError;
    };
    await refuse("9.9.9", "release_not_found");

    h.catalog.add("1.2.0", null);
    expect((await refuse("1.2.0", "release_not_found")).message).toContain("has no release.json");

    h.publish("1.0.0");
    expect((await refuse("1.0.0", "release_refused")).extensions.reasons).toEqual(["not_newer"]);

    h.publish("1.3.0", (doc) => {
      doc.upgrade.minimumFromVersion = "1.1.0";
      doc.upgrade.manualSteps = {
        required: true,
        summary: "Edit compose",
        url: "https://example.com/steps",
      };
      doc.requires = { updater: ">=2.0.0", env: ["NOTES_SEARCH_URL", "NOTES_DOMAIN"] };
      delete doc.images.web;
    });
    expect((await refuse("1.3.0", "release_refused")).extensions.reasons).toEqual([
      "below_minimum_version",
      "manual_steps_required",
      "updater_too_old",
      "env_missing",
      "image_missing",
    ]);

    h.publish("1.4.0", (doc) => {
      doc.images.app.platforms = ["linux/arm64"];
    });
    expect((await refuse("1.4.0", "release_refused")).extensions.reasons).toEqual([
      "platform_unsupported",
    ]);

    h.verifier.documentFailure = "signature_invalid";
    expect((await refuse("1.1.0", "release_unverifiable")).message).toContain("signature_invalid");
    h.verifier.documentFailure = null;

    h.verifier.imageFailures.set(pullRef("web", "1.1.0"), "signature_missing");
    const unsigned = await refuse("1.1.0", "release_unverifiable");
    expect(unsigned.extensions.checks?.images).toEqual([
      {
        key: "app",
        ref: pullRef("app", "1.1.0"),
        signature: "verified",
        exists: true,
        error: null,
      },
      {
        key: "web",
        ref: pullRef("web", "1.1.0"),
        signature: "failed",
        exists: null,
        error: "fetch.signature_missing",
      },
    ]);
    h.verifier.imageFailures.clear();

    h.catalog.add(
      "1.5.0",
      (await import("../src/testing.js")).releaseDocument("1.5.0", (doc) => {
        doc.project = "github.com/attacker/notes";
      }),
    );
    expect((await refuse("1.5.0", "release_unverifiable")).message).toContain("release.mismatch");

    h.catalog.listError = new (await import("../src/index.js")).CatalogError(
      "feed_unavailable",
      "rate_limited",
      "The feed is not available.",
    );
    expect((await refuse("1.1.0", "feed_unavailable")).extensions.feedError).toBe("rate_limited");
    h.catalog.listError = null;

    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(h.engine.view().events).toEqual([]);
  });

  it("refuses when the admin saw another document, when blocked, and source mode when it is off", async () => {
    await expect(
      h.engine.schedule(
        scheduleRequest("1.1.0", { expect: { releaseSha256: "0".repeat(64) } }),
        "api",
      ),
    ).rejects.toMatchObject({ code: "release_mismatch" });

    h.preflight.blockers = [
      { code: "docker_unreachable", detail: "connect ENOENT /var/run/docker.sock" },
    ];
    const blocked = (await h.engine
      .schedule(scheduleRequest("1.1.0"), "api")
      .catch((error: EngineError) => error)) as EngineError;
    expect(blocked).toMatchObject({ code: "blocked" });
    expect(blocked.extensions.blockers?.map((blocker) => blocker.code)).toEqual([
      "docker_unreachable",
    ]);
    h.preflight.blockers = [];

    await expect(
      h.engine.schedule(scheduleRequest("1.1.0", { mode: "source" }), "api"),
    ).rejects.toMatchObject({
      code: "source_not_allowed",
    });
    await expect(
      h.engine.schedule(scheduleRequest("1.1.0", { leadSeconds: 99_999_999 }), "api"),
    ).rejects.toMatchObject({
      code: "invalid_request",
    });
    await expect(
      h.engine.schedule(
        scheduleRequest("1.1.0", { leadSeconds: undefined, startsAt: "2020-01-01T00:00:00Z" }),
        "api",
      ),
    ).rejects.toMatchObject({ code: "invalid_request" });
    expect(h.engine.view().phase).toBe("idle");
  });

  it("refuses when the running version is unknown", async () => {
    h.ops.appBehavior.set(OLD_APP, { kind: "never" });
    await expect(h.engine.schedule(scheduleRequest("1.1.0"), "api")).rejects.toMatchObject({
      code: "release_refused",
      extensions: { reasons: ["running_version_unknown"] },
    });
  });

  it("accepts the expected document hash and a pre-release on the beta channel", async () => {
    const sha = (await import("../src/index.js")).sha256Hex(
      h.catalog.releases.get("1.1.0")?.document as Uint8Array,
    );
    await h.engine.schedule(scheduleRequest("1.1.0", { expect: { releaseSha256: sha } }), "api");
    await settle(h.engine);
    expect(h.engine.view().run?.release.sha256).toBe(sha);
    h.publish("1.2.0-rc.1");
    h.clock.advance(5000);
    await h.engine.schedule(scheduleRequest("1.2.0-rc.1"), "api");
    await settle(h.engine);
    expect(h.engine.view().run).toMatchObject({
      outcome: "succeeded",
      release: { channel: "beta" },
    });
  });
});

describe("journal cursor", () => {
  it("returns events after a cursor and reports gaps", async () => {
    h.publish("1.1.0");
    await runToEnd();
    const all = h.engine.eventsAfter(null, 100);
    expect(all.events).toHaveLength(3);
    expect(all.next).toBe(all.events[2]?.id);
    expect(all.gap).toBe(false);
    const rest = h.engine.eventsAfter(all.events[0]?.id ?? null, 1);
    expect(rest.events.map((event) => event.action)).toEqual(["update.started"]);
    expect(h.engine.eventsAfter(all.next, 10)).toEqual({ events: [], next: null, gap: false });
    // Pretend older events were dropped: an ancient cursor reports the gap.
    expect(h.engine.eventsAfter("000000000000001-000001", 10).gap).toBe(true);
    const first = all.events[0]?.id as string;
    const before = `${first.split("-")[0]}-${String(Number(first.split("-")[1]) - 1).padStart(6, "0")}`;
    expect(h.engine.eventsAfter(before, 10).gap).toBe(false);
  });
});

describe("what leaves the process", () => {
  it("never stores the env file's secrets, tokens in errors or registry credentials", async () => {
    h.publish("1.1.0");
    h.redactor.add("shared-token-value-0123456789");
    h.ops.registry.set(pullRef("app", "1.1.0"), "registry_unauthorized");
    const original = h.ops.pull.bind(h.ops);
    h.ops.pull = async (ref) => {
      try {
        await original(ref);
      } catch {
        throw new (await import("../src/index.js")).PullError(
          "registry_unauthorized",
          "denied for https://ci-user:hunter2hunter2@registry.example.com with Authorization: Bearer abcdefghijklmnop and super-secret-db-password and shared-token-value-0123456789",
        );
      }
    };
    await runToEnd();
    const raw = await fs.readFile(`${h.stateDir}/status.json`, "utf8");
    for (const secret of [
      "hunter2hunter2",
      "abcdefghijklmnop",
      "super-secret-db-password",
      "shared-token-value-0123456789",
    ]) {
      expect(raw).not.toContain(secret);
      expect(h.logger.lines.join("\n")).not.toContain(secret);
    }
    expect(h.engine.view().run?.failure?.code).toBe("fetch.registry_unauthorized");
    expect(h.engine.view().run?.failure?.detail).toContain("[redacted]");
  });

  it("uses digests that are unique per image key and version", () => {
    expect(releaseDigest("app", "1.1.0")).not.toBe(releaseDigest("web", "1.1.0"));
    expect(digestOf("x")).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

describe("steps list", () => {
  it("lists the steps of the design in order", () => {
    expect([...STEP_IDS]).toEqual([
      "prepare",
      "fetch",
      "backup",
      "stop",
      "migrate",
      "start",
      "health",
      "smoke",
      "finish",
    ]);
  });
});

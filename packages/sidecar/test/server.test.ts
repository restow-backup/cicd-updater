import { createHarness, type Harness, settle } from "@cicd-updater/engine/testing";
import {
  eventsViewSchema,
  publicStatusSchema,
  releasesViewSchema,
  runSchema,
  stateViewSchema,
  type UpdaterConfigInput,
  verificationResultSchema,
} from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer, CLIENT_HEADER, maintenanceFiles } from "../src/index.js";

const TOKEN = "b".repeat(64);
let h: Harness;
let remote: string | null;
let app: ReturnType<typeof buildServer>;

async function make(configure?: (config: UpdaterConfigInput) => void): Promise<void> {
  h = await createHarness({ configure });
  h.publish("1.1.0");
  remote = "172.18.0.5";
  app = buildServer({
    config: h.config,
    configHash: "c".repeat(64),
    updaterVersion: "1.0.0",
    engine: h.engine,
    preflight: h.preflight,
    releases: h.releases,
    running: h.running,
    backups: h.backups,
    source: h.source,
    token: () => TOKEN,
    now: () => h.clock.now(),
    logger: h.logger,
    redactor: h.redactor,
    latestAvailable: () => null,
    maintenance: () => maintenanceFiles(h.config),
    remoteAddress: () => remote,
  });
}

beforeEach(async () => {
  await make();
});

afterEach(async () => {
  await h.cleanup();
});

const auth = { authorization: `Bearer ${TOKEN}` };
const json = { ...auth, "content-type": "application/json" };

async function call(path: string, init: RequestInit = {}) {
  const response = await app.request(path, init);
  const text = await response.text();
  return { response, status: response.status, body: text ? JSON.parse(text) : null, text };
}

describe("conventions", () => {
  it("serves liveness and the public status without a token, everything else with one", async () => {
    expect((await call("/healthz")).body).toEqual({ status: "ok" });
    const status = await call("/public/v1/status");
    expect(publicStatusSchema.safeParse(status.body).success).toBe(true);
    const denied = await call("/v1/state");
    expect(denied.status).toBe(401);
    expect(denied.response.headers.get("www-authenticate")).toBe("Bearer");
    expect(denied.response.headers.get("content-type")).toBe("application/problem+json");
    expect(denied.body).toMatchObject({
      type: "urn:cicd-updater:problem:unauthorized",
      status: 401,
      code: "unauthorized",
    });
    expect(
      (await call("/v1/state", { headers: { authorization: `Bearer ${"x".repeat(64)}` } })).status,
    ).toBe(401);
    expect((await call("/v1/state", { headers: { authorization: `Basic ${TOKEN}` } })).status).toBe(
      401,
    );
    expect(denied.response.headers.get("cache-control")).toBe("no-store");
    expect(denied.response.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("never returns the token, in any response", async () => {
    for (const path of [
      "/v1/state",
      "/v1/config",
      "/v1/openapi.json",
      "/v1/backups",
      "/v1/events",
      "/v1/runs",
      "/public/v1/status",
    ]) {
      const result = await call(path, { headers: auth });
      expect(result.text, path).not.toContain(TOKEN);
    }
  });

  it("answers unknown paths with a not_found problem", async () => {
    const result = await call("/v1/nothing", { headers: auth });
    expect(result.status).toBe(404);
    expect(result.body.code).toBe("not_found");
  });

  it("refuses non-JSON, oversized and invalid bodies", async () => {
    const text = await call("/v1/runs", {
      method: "POST",
      headers: { ...auth, "content-type": "text/plain" },
      body: "version=1.1.0",
    });
    expect(text.status).toBe(415);
    const big = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ x: "y".repeat(70_000) }),
    });
    expect(big.status).toBe(413);
    const broken = await call("/v1/runs", { method: "POST", headers: json, body: "{" });
    expect(broken.status).toBe(422);
    const invalid = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "v1.1.0", requestedBy: {} }),
    });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("invalid_request");
    expect(invalid.body.errors.map((error: { path: string }) => error.path)).toEqual(
      expect.arrayContaining(["version", "requestedBy.label"]),
    );
  });
});

describe("state and releases", () => {
  it("returns a StateView that matches the contract, with features and trust summary", async () => {
    const result = await call("/v1/state?refresh=true", { headers: auth });
    expect(result.status).toBe(200);
    expect(stateViewSchema.safeParse(result.body).success).toBe(true);
    expect(result.body.api).toEqual({
      version: "1.0",
      features: ["abort", "reschedule", "verification", "events", "backups", "public_status"],
    });
    expect(result.body.trust).toEqual({
      mode: "keyless",
      identity: "https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v<version>",
      keys: null,
    });
    expect(result.body.running).toEqual({ version: "1.0.0", source: "health" });
    expect(result.body.updater).toEqual({
      version: "1.0.0",
      configHash: "c".repeat(64),
      latestAvailable: null,
    });
  });

  it("lists releases and verifies one as a dry run", async () => {
    const releases = await call("/v1/releases", { headers: auth });
    expect(releasesViewSchema.safeParse(releases.body).success).toBe(true);
    expect(releases.body.nextInstallable).toBe("1.1.0");
    const verification = await call("/v1/releases/1.1.0/verification", {
      method: "POST",
      headers: auth,
    });
    expect(verificationResultSchema.safeParse(verification.body).success).toBe(true);
    expect(verification.body.refusals).toEqual([]);
    expect(h.ops.callsTo("pull")).toEqual([]);
    expect(
      (await call("/v1/releases/9.9.9/verification", { method: "POST", headers: auth })).body.code,
    ).toBe("release_not_found");
    expect(
      (await call("/v1/releases/latest/verification", { method: "POST", headers: auth })).status,
    ).toBe(422);
  });
});

describe("runs", () => {
  it("schedules, reports, reschedules and cancels a run with journal attribution", async () => {
    const scheduled = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        version: "1.1.0",
        leadSeconds: 600,
        requestedBy: { id: "u1", label: "admin@example.com" },
      }),
    });
    expect(scheduled.status).toBe(202);
    expect(scheduled.body.phase).toBe("scheduled");
    const runId = scheduled.body.run.id as string;
    expect(
      (
        await call("/v1/runs", {
          method: "POST",
          headers: json,
          body: JSON.stringify({ version: "1.1.0", requestedBy: { label: "x" } }),
        })
      ).body.code,
    ).toBe("busy");
    const run = await call(`/v1/runs/${runId}`, { headers: auth });
    expect(runSchema.safeParse(run.body).success).toBe(true);
    const moved = await call(`/v1/runs/${runId}`, {
      method: "PATCH",
      headers: json,
      body: JSON.stringify({ leadSeconds: 1200, requestedBy: { label: "ops@example.com" } }),
    });
    expect(moved.status).toBe(200);
    expect(
      (
        await call(`/v1/runs/${runId}`, {
          method: "PATCH",
          headers: json,
          body: JSON.stringify({}),
        })
      ).status,
    ).toBe(422);
    const cancelled = await call(`/v1/runs/${runId}/cancel`, { method: "POST", headers: auth });
    expect(cancelled.status).toBe(200);
    expect(cancelled.body.phase).toBe("idle");
    const events = await call("/v1/events?limit=10", { headers: auth });
    expect(eventsViewSchema.safeParse(events.body).success).toBe(true);
    expect(
      events.body.events.map((event: { action: string; actor: { label: string } }) => [
        event.action,
        event.actor.label,
      ]),
    ).toEqual([
      ["update.scheduled", "admin@example.com"],
      ["update.rescheduled", "ops@example.com"],
      ["update.cancelled", "api"],
    ]);
    const history = await call("/v1/runs?limit=5", { headers: auth });
    expect(history.body.runs[0]).toMatchObject({ id: runId, cancelled: true });
    const old = await call(`/v1/runs/${runId}`, { headers: auth });
    expect(old.body.log).toEqual([]);
    expect((await call("/v1/runs/r-1-abcd", { headers: auth })).status).toBe(404);
  });

  it("runs, refuses to abort after the point of no return, and acknowledges", async () => {
    const started = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "1.1.0", requestedBy: { label: "admin" } }),
    });
    expect(started.status).toBe(202);
    const runId = started.body.run.id as string;
    expect(started.body.phase).toBe("running");
    await settle(h.engine);
    expect(
      (await call(`/v1/runs/${runId}/cancel`, { method: "POST", headers: auth })).body.code,
    ).toBe("not_scheduled");
    const ack = await call(`/v1/runs/${runId}/acknowledge`, {
      method: "POST",
      headers: json,
      body: JSON.stringify({ requestedBy: { label: "ops" } }),
    });
    expect(ack.status).toBe(200);
    expect(ack.body.phase).toBe("idle");
  });

  it("maps refusals to problems with their extensions", async () => {
    h.publish("1.0.0");
    const refused = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "1.0.0", requestedBy: { label: "a" } }),
    });
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({ code: "release_refused", reasons: ["not_newer"] });
    h.preflight.blockers = [{ code: "disk_space", detail: "10 MB free" }];
    const blocked = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "1.1.0", requestedBy: { label: "a" } }),
    });
    expect(blocked.body).toMatchObject({
      code: "blocked",
      blockers: [{ code: "disk_space", detail: "10 MB free" }],
    });
    h.preflight.blockers = [];
    const mismatch = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        version: "1.1.0",
        requestedBy: { label: "a" },
        expect: { releaseSha256: "0".repeat(64) },
      }),
    });
    expect(mismatch.body.code).toBe("release_mismatch");
    const source = await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "1.1.0", mode: "source", requestedBy: { label: "a" } }),
    });
    expect(source.body.code).toBe("source_not_allowed");
  });

  it("marks requests from the CLI on loopback, never from the network", async () => {
    remote = "127.0.0.1";
    await call("/v1/runs", {
      method: "POST",
      headers: { ...json, [CLIENT_HEADER]: "cli" },
      body: JSON.stringify({ version: "1.1.0", leadSeconds: 60, requestedBy: { label: "cli" } }),
    });
    expect(h.engine.view().run?.requestedBy.via).toBe("cli");
    await h.engine.cancel(h.engine.view().run?.id ?? "", { id: null, label: "x", via: "api" });
    remote = "172.18.0.9";
    await call("/v1/runs", {
      method: "POST",
      headers: { ...json, [CLIENT_HEADER]: "cli" },
      body: JSON.stringify({ version: "1.1.0", leadSeconds: 60, requestedBy: { label: "app" } }),
    });
    expect(h.engine.view().run?.requestedBy.via).toBe("api");
  });

  it("validates the event cursor and limit", async () => {
    expect((await call("/v1/events?after=abc", { headers: auth })).status).toBe(422);
    expect((await call("/v1/events?limit=501", { headers: auth })).status).toBe(422);
    expect((await call("/v1/events?after=000000000000001-000001", { headers: auth })).body).toEqual(
      { events: [], next: null, gap: false },
    );
  });
});

describe("configuration, OpenAPI and public pages", () => {
  it("returns the configuration with its hash and the OpenAPI document", async () => {
    const config = await call("/v1/config", { headers: auth });
    expect(config.body.configHash).toBe("c".repeat(64));
    expect(config.body.config.compose.projectName).toBe("notes");
    const openapi = await call("/v1/openapi.json", { headers: auth });
    expect(openapi.body.openapi).toBe("3.1.0");
  });

  it("hides versions in the public status unless configured", async () => {
    await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({
        version: "1.1.0",
        leadSeconds: 600,
        requestedBy: { label: "admin@example.com" },
      }),
    });
    const hidden = await call("/public/v1/status");
    expect(hidden.body.phase).toBe("scheduled");
    expect(hidden.text).not.toContain("1.1.0");
    expect(hidden.text).not.toContain("admin@example.com");
    await h.cleanup();
    await make((config) => {
      config.publicStatus = { showVersions: true };
    });
    await call("/v1/runs", {
      method: "POST",
      headers: json,
      body: JSON.stringify({ version: "1.1.0", leadSeconds: 600, requestedBy: { label: "a" } }),
    });
    expect((await call("/public/v1/status")).body.targetVersion).toBe("1.1.0");
  });

  it("serves the maintenance page only when enabled, with a strict CSP", async () => {
    expect((await call("/public/v1/maintenance/")).status).toBe(404);
    await h.cleanup();
    await make((config) => {
      config.maintenancePage = { enabled: true };
      config.publicStatus = { enabled: false };
    });
    const page = await app.request("/public/v1/maintenance/");
    expect(page.status).toBe(200);
    expect(page.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(page.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect((await app.request("/public/v1/maintenance/maintenance.js")).status).toBe(200);
    expect((await app.request("/public/v1/maintenance/../v1/state")).status).toBe(404);
    expect((await call("/public/v1/status")).status).toBe(404);
  });
});

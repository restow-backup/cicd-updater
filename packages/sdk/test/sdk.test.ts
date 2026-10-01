import type { JournalEvent, PublicStatus, StateView } from "@cicd-updater/protocol";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTokenVerifier } from "../src/auth.js";
import {
  createUpdaterClient,
  maintenanceViewOf,
  syncJournal,
  UpdaterProblemError,
  UpdaterUnavailableError,
} from "../src/index.js";
import { de } from "../src/messages.js";
import {
  countdownOf,
  formatCountdown,
  MaintenanceBanner,
  type MaintenanceSnapshot,
  MaintenanceTracker,
  UpdateProgress,
} from "../src/react.js";

const TOKEN = "a".repeat(64);
const NOW = Date.parse("2026-11-02T10:00:00Z");

function stateView(overrides: Partial<StateView> = {}): StateView {
  return {
    api: { version: "1.0", features: ["abort"] },
    updater: { version: "1.0.0", configHash: "c".repeat(64), latestAvailable: null },
    phase: "idle",
    run: null,
    history: [],
    running: { version: "1.0.0", source: "health" },
    trust: { mode: "keyless", identity: null, keys: null },
    sourceMode: { enabled: false, allowlist: [] },
    capabilities: {
      ready: true,
      blockers: [],
      warnings: [],
      docker: { serverVersion: null, apiVersion: null, architecture: null, imageStore: null },
      compose: { projectName: "notes", projectDir: "/opt/notes", files: [], envFile: ".env" },
      backups: [],
      checkedAt: "2026-11-02T10:00:00.000Z",
    },
    serverTime: "2026-11-02T10:00:00.000Z",
    ...overrides,
  };
}

function server(handler: (request: Request) => Response | Promise<Response>) {
  const requests: Request[] = [];
  const fetcher = (async (url: string, init: RequestInit) => {
    const request = new Request(url, init);
    requests.push(request);
    expect(init.redirect).toBe("error");
    return handler(request);
  }) as typeof fetch;
  return { requests, fetcher };
}

describe("createUpdaterClient", () => {
  it("reads the state with the token and shares concurrent and recent calls", async () => {
    const { requests, fetcher } = server(() => Response.json(stateView()));
    let now = NOW;
    const client = createUpdaterClient({
      url: "http://updater:8090/",
      token: TOKEN,
      fetch: fetcher,
      now: () => now,
    });
    const [a, b] = await Promise.all([client.state(), client.state()]);
    expect(a?.phase).toBe("idle");
    expect(b).toEqual(a);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("http://updater:8090/v1/state");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    await client.state();
    expect(requests).toHaveLength(1);
    now += 2500;
    await client.state();
    expect(requests).toHaveLength(2);
    await client.state({ refreshCapabilities: true });
    expect(requests.at(-1)?.url).toBe("http://updater:8090/v1/state?refresh=true");
  });

  it("treats a missing sidecar as a normal result and remembers it briefly", async () => {
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    let now = NOW;
    const client = createUpdaterClient({
      url: "http://updater:8090",
      token: TOKEN,
      fetch: fetcher,
      now: () => now,
    });
    expect(await client.state()).toBeNull();
    expect(await client.state()).toBeNull();
    expect(calls).toBe(1);
    now += 9000;
    await client.state();
    expect(calls).toBe(2);
    expect(await createUpdaterClient({ url: "", token: TOKEN }).state()).toBeNull();
    await expect(
      createUpdaterClient({ url: "http://updater:8090", fetch: fetcher }).schedule({
        version: "1.1.0",
        requestedBy: { label: "a" },
      }),
    ).rejects.toMatchObject({
      reason: "no_token",
    });
  });

  it("reports another major version as incompatible", async () => {
    const { fetcher } = server(() =>
      Response.json({ ...stateView(), api: { version: "2.0", features: [] } }),
    );
    const client = createUpdaterClient({
      url: "http://updater:8090",
      token: TOKEN,
      fetch: fetcher,
    });
    await expect(client.state()).rejects.toBeInstanceOf(UpdaterUnavailableError);
    await expect(client.state()).rejects.toMatchObject({ reason: "incompatible" });
  });

  it("accepts a newer 1.x sidecar with fields it does not know", async () => {
    const { fetcher } = server(() =>
      Response.json({
        ...stateView(),
        api: { version: "1.4", features: ["future"] },
        futureField: { x: 1 },
      }),
    );
    const view = await createUpdaterClient({
      url: "http://updater:8090",
      token: TOKEN,
      fetch: fetcher,
    }).state();
    expect(view?.api.version).toBe("1.4");
  });

  it("re-reads the token file once after a 401", async () => {
    let token = "old-token-value-0123456789abcdef";
    const { requests, fetcher } = server((request) =>
      request.headers.get("authorization") === "Bearer new-token-value-0123456789abcdef"
        ? Response.json(stateView())
        : new Response("{}", { status: 401 }),
    );
    const client = createUpdaterClient({
      url: "http://updater:8090",
      tokenFile: "/run/cicd-updater/token",
      readFile: async () => `${token}\n`,
      fetch: fetcher,
    });
    expect(await client.state()).toBeNull();
    token = "new-token-value-0123456789abcdef";
    expect((await client.state({ fresh: true }))?.phase).toBe("idle");
    // The first state() retried once after the 401 with the re-read (still old) token.
    expect(requests.map((request) => request.headers.get("authorization"))).toEqual([
      "Bearer old-token-value-0123456789abcdef",
      "Bearer old-token-value-0123456789abcdef",
      "Bearer new-token-value-0123456789abcdef",
    ]);
  });

  it("turns problem documents into UpdaterProblemError and sends the actions", async () => {
    const { requests, fetcher } = server((request) => {
      if (request.method === "POST" && new URL(request.url).pathname === "/v1/runs") {
        return Response.json(
          {
            type: "urn:cicd-updater:problem:release_refused",
            title: "x",
            status: 409,
            code: "release_refused",
            reasons: ["not_newer"],
          },
          { status: 409, headers: { "content-type": "application/problem+json" } },
        );
      }
      return Response.json(stateView({ phase: "idle" }));
    });
    const client = createUpdaterClient({
      url: "http://updater:8090",
      token: TOKEN,
      fetch: fetcher,
    });
    const error = await client
      .schedule({ version: "1.0.0", requestedBy: { label: "admin" } })
      .catch((caught: unknown) => caught as UpdaterProblemError);
    expect(error).toBeInstanceOf(UpdaterProblemError);
    expect(error).toMatchObject({
      status: 409,
      code: "release_refused",
      problem: { reasons: ["not_newer"] },
    });
    await client.reschedule(
      "r-1-abcd",
      { startsAt: new Date("2026-11-02T12:00:00Z") },
      { label: "ops" },
    );
    await client.cancel("r-1-abcd");
    await client.acknowledge("r-1-abcd", { id: "u1", label: "ops" });
    const sent = await Promise.all(
      requests
        .slice(1)
        .map(async (request) => [
          request.method,
          new URL(request.url).pathname,
          await request.text(),
        ]),
    );
    expect(sent).toEqual([
      [
        "PATCH",
        "/v1/runs/r-1-abcd",
        JSON.stringify({ startsAt: "2026-11-02T12:00:00.000Z", requestedBy: { label: "ops" } }),
      ],
      ["POST", "/v1/runs/r-1-abcd/cancel", ""],
      [
        "POST",
        "/v1/runs/r-1-abcd/acknowledge",
        JSON.stringify({ requestedBy: { id: "u1", label: "ops" } }),
      ],
    ]);
  });
});

describe("public status", () => {
  it("reads the public status without sending the token", async () => {
    const { requests, fetcher } = server(() =>
      Response.json({
        phase: "idle",
        runId: null,
        outcome: null,
        startsAt: null,
        startedAt: null,
        finishedAt: null,
        step: null,
        steps: [],
        progress: 0,
        message: null,
        failureCode: null,
        serverTime: "2026-11-02T10:00:00.000Z",
      }),
    );
    const client = createUpdaterClient({ url: "http://updater:8090", fetch: fetcher });
    expect((await client.publicStatus()).phase).toBe("idle");
    expect(requests[0]?.headers.get("authorization")).toBeNull();
    expect(new URL(requests[0]?.url ?? "").pathname).toBe("/public/v1/status");
  });
});

describe("syncJournal", () => {
  function event(n: number): JournalEvent {
    return {
      id: `${String(1_793_000_000_000 + n).padStart(15, "0")}-${String(n).padStart(6, "0")}`,
      at: "2026-11-02T10:00:00.000Z",
      action: "update.started",
      runId: "r-1-abcd",
      actor: { id: null, label: "x", via: "api" },
      target: "1.1.0",
      details: {},
    };
  }

  it("ingests every event exactly once, in order, across batches and restarts", async () => {
    const all = Array.from({ length: 7 }, (_, index) => event(index + 1));
    const { fetcher } = server((request) => {
      const url = new URL(request.url);
      const after = url.searchParams.get("after");
      const limit = Number(url.searchParams.get("limit"));
      const events = all
        .filter((candidate) => after === null || candidate.id > after)
        .slice(0, limit);
      return Response.json({ events, next: events.at(-1)?.id ?? null, gap: false });
    });
    const client = createUpdaterClient({
      url: "http://updater:8090",
      token: TOKEN,
      fetch: fetcher,
    });
    let cursor: string | null = null;
    const audit: string[] = [];
    const result = await syncJournal({
      client,
      batchSize: 3,
      loadCursor: async () => cursor,
      ingest: async (item) => {
        audit.push(item.id);
        cursor = item.id;
      },
    });
    expect(result).toEqual({ ingested: 7, gap: false });
    expect(audit).toEqual(all.map((item) => item.id));
    expect(
      await syncJournal({ client, loadCursor: async () => cursor, ingest: async () => undefined }),
    ).toEqual({ ingested: 0, gap: false });
  });

  it("reports a gap once", async () => {
    const { fetcher } = server(() => Response.json({ events: [], next: null, gap: true }));
    const gaps: (string | null)[] = [];
    const result = await syncJournal({
      client: createUpdaterClient({ url: "http://updater:8090", token: TOKEN, fetch: fetcher }),
      loadCursor: async () => "000000000000001-000001",
      ingest: async () => undefined,
      onGap: async (info) => {
        gaps.push(info.after);
      },
    });
    expect(result.gap).toBe(true);
    expect(gaps).toEqual(["000000000000001-000001"]);
  });
});

describe("createTokenVerifier", () => {
  it("recognizes exactly the sidecar's bearer token", async () => {
    let content = `${TOKEN}\n`;
    let now = NOW;
    const verifier = createTokenVerifier({
      tokenFile: "/run/cicd-updater/token",
      readFile: async () => content,
      now: () => now,
    });
    expect(await verifier.isUpdater(`Bearer ${TOKEN}`)).toBe(true);
    expect(await verifier.isUpdater(`bearer ${TOKEN}`)).toBe(true);
    expect(await verifier.isUpdater(`Bearer ${TOKEN}x`)).toBe(false);
    expect(await verifier.isUpdater(TOKEN)).toBe(false);
    expect(await verifier.isUpdater(null)).toBe(false);
    content = "b".repeat(64);
    expect(await verifier.isUpdater(`Bearer ${TOKEN}`)).toBe(true);
    now += 31_000;
    expect(await verifier.isUpdater(`Bearer ${TOKEN}`)).toBe(false);
    const missing = createTokenVerifier({
      tokenFile: "/nope",
      readFile: async () => {
        throw new Error("ENOENT");
      },
    });
    expect(await missing.isUpdater("Bearer ")).toBe(false);
  });
});

describe("maintenance", () => {
  const scheduled: PublicStatus = {
    phase: "scheduled",
    runId: "r-1-abcd",
    outcome: null,
    startsAt: "2026-11-02T10:05:00.000Z",
    startedAt: null,
    finishedAt: null,
    step: null,
    steps: [],
    progress: 0,
    message: { code: "run.scheduled", params: { startsAt: "2026-11-02T10:05:00.000Z" } },
    failureCode: null,
    serverTime: "2026-11-02T10:00:30.000Z",
  };

  it("tracks the clock offset, counts down and reloads once after a run it saw succeed", () => {
    const tracker = new MaintenanceTracker();
    tracker.observe(scheduled, NOW, true);
    expect(tracker.snapshot.offsetMs).toBe(30_000);
    expect(tracker.snapshot.countdownSeconds).toBe(270);
    expect(tracker.nextPollMs(30_000, 2000)).toBe(2000);
    const done = {
      ...scheduled,
      phase: "succeeded" as const,
      outcome: "succeeded" as const,
      finishedAt: "2026-11-02T10:10:00.000Z",
    };
    expect(tracker.observe(done, NOW + 600_000, true).reload).toBe(true);
    expect(tracker.observe(done, NOW + 602_000, true).reload).toBe(false);
    expect(tracker.nextPollMs(30_000, 2000)).toBe(30_000);
  });

  it("does not announce an old failure to a page that did not see the run", () => {
    const tracker = new MaintenanceTracker();
    const failed = {
      ...scheduled,
      phase: "failed" as const,
      outcome: "unchanged" as const,
      finishedAt: "2026-10-30T10:00:00.000Z",
      serverTime: "2026-11-02T10:00:00.000Z",
    };
    tracker.observe(failed, NOW, true);
    expect(tracker.snapshot.phase).toBe("idle");
    const recent = { ...failed, finishedAt: "2026-11-02T09:00:00.000Z" };
    tracker.observe(recent, NOW, true);
    expect(tracker.snapshot.phase).toBe("failed");
  });

  it("formats countdowns", () => {
    expect(formatCountdown(75)).toBe("1:15");
    expect(formatCountdown(3725)).toBe("1:02:05");
    expect(countdownOf("2026-11-02T10:00:10.000Z", 0, NOW)).toBe(10);
    expect(countdownOf("2026-11-02T09:00:00.000Z", 0, NOW)).toBe(0);
  });

  it("renders the banner and the progress headlessly, with data-state hooks", () => {
    const snapshot = (view: PublicStatus | null): MaintenanceSnapshot => ({
      view,
      apiReachable: true,
      offsetMs: 0,
      phase: view?.phase ?? "idle",
      countdownSeconds: null,
    });
    expect(
      renderToStaticMarkup(createElement(MaintenanceBanner, { snapshot: snapshot(null) })),
    ).toBe("");
    const running = {
      ...scheduled,
      phase: "running" as const,
      step: "fetch" as const,
      steps: [
        { id: "prepare" as const, status: "done" as const },
        { id: "fetch" as const, status: "running" as const },
        { id: "migrate" as const, status: "skipped" as const },
      ],
      progress: 20,
      message: { code: "step.fetch.pulling", params: { index: 1, total: 2 } },
    };
    const banner = renderToStaticMarkup(
      createElement(MaintenanceBanner, {
        snapshot: snapshot(running),
        messages: de,
        className: "banner",
      }),
    );
    expect(banner).toContain('data-state="running"');
    expect(banner).toContain("Ein Update läuft.");
    expect(banner).toContain("Abbild 1 von 2 wird heruntergeladen.");
    const progress = renderToStaticMarkup(
      createElement(UpdateProgress, { snapshot: snapshot(running) }),
    );
    expect(progress).toContain('aria-valuenow="20"');
    expect(progress).toContain('<li data-status="running">Downloading and verifying</li>');
    expect(progress).not.toContain("Migrating");
  });

  it("derives the app's maintenance view from the sidecar state, with versions", () => {
    expect(maintenanceViewOf(null, new Date(NOW)).phase).toBe("idle");
  });
});

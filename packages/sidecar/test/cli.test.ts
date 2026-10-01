import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Writable } from "node:stream";
import { createHarness, type Harness, settle } from "@cicd-updater/engine/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  buildServer,
  type CliDeps,
  dockerClientVersion,
  EXIT,
  maintenanceFiles,
  parseDuration,
  runCli,
} from "../src/index.js";

const TOKEN = "d".repeat(64);
let h: Harness;
let configFile: string;
let out: string[];
let err: string[];
let requests: { method: string; url: string; headers: Headers }[];

beforeEach(async () => {
  h = await createHarness();
  h.publish("1.1.0");
  const shared = path.join(h.dir, "shared");
  await fs.mkdir(shared, { recursive: true });
  await fs.writeFile(path.join(shared, "token"), `${TOKEN}\n`);
  configFile = path.join(h.dir, "updater.yaml");
  await fs.writeFile(
    configFile,
    stringify({
      version: 1,
      compose: { projectDir: h.projectDir, projectName: "notes" },
      auth: { sharedDir: shared },
      state: { dir: h.stateDir },
      release: { feed: { type: "github", url: "https://github.com/acme/notes" } },
      trust: {
        keyless: {
          github: { repository: "acme/notes", workflow: ".github/workflows/release.yml" },
        },
      },
      services: [
        { name: "api", image: "app", imageVar: "APP_IMAGE", stopBeforeUpdate: false },
        { name: "worker", image: "app", imageVar: "APP_IMAGE", startOrder: 2 },
        {
          name: "web",
          image: "web",
          imageVar: "WEB_IMAGE",
          startOrder: 3,
          stopBeforeUpdate: false,
        },
      ],
    }),
  );
  out = [];
  err = [];
  requests = [];
});

afterEach(async () => {
  await h.cleanup();
});

function deps(overrides: Partial<CliDeps> = {}): CliDeps {
  const app = buildServer({
    config: h.config,
    configHash: "e".repeat(64),
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
    remoteAddress: () => "127.0.0.1",
  });
  const chunks: Buffer[] = [];
  return {
    env: { CICD_UPDATER_CONFIG: configFile },
    io: { out: (line) => out.push(line), err: (line) => err.push(line) },
    fetch: (async (input: string, init: RequestInit) => {
      const request = new Request(input, init);
      requests.push({ method: request.method, url: request.url, headers: request.headers });
      return app.request(new URL(request.url).pathname + new URL(request.url).search, init);
    }) as typeof fetch,
    confirm: async () => true,
    stdout: new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk as Buffer);
        callback();
      },
    }),
    ...overrides,
  };
}

describe("cli", () => {
  it("parses durations", () => {
    expect(parseDuration("90s")).toBe(90);
    expect(parseDuration("15m")).toBe(900);
    expect(parseDuration("2h")).toBe(7200);
    expect(parseDuration("1d")).toBe(86400);
    expect(parseDuration("300")).toBe(300);
    expect(() => parseDuration("soon")).toThrow();
  });

  it("checks the configuration offline and exits 64 on problems", async () => {
    expect(await runCli(["config", "check"], deps())).toBe(EXIT.ok);
    expect(out[0]).toBe(`${configFile}: valid`);
    expect(out[1]).toMatch(/^configHash [0-9a-f]{64}$/);
    await fs.writeFile(configFile, "version: 2\n");
    out = [];
    expect(await runCli(["config", "check", "--json"], deps())).toBe(EXIT.config);
    expect(JSON.parse(out.join("\n"))).toMatchObject({ ok: false });
    expect(await runCli(["status"], deps())).toBe(EXIT.config);
  });

  it("reports usage errors with exit 2 and unknown flags", async () => {
    expect(await runCli(["status", "--nope"], deps())).toBe(EXIT.usage);
    expect(await runCli(["config"], deps())).toBe(EXIT.usage);
    expect(await runCli(["frobnicate"], deps())).toBe(EXIT.usage);
    expect(await runCli(["schedule"], deps())).toBe(EXIT.usage);
    expect(await runCli(["--help"], deps())).toBe(EXIT.ok);
  });

  it("schedules with confirmation through the local API, marked as CLI, and shows the status", async () => {
    expect(await runCli(["schedule", "1.1.0", "--in", "15m", "--label", "ops"], deps())).toBe(
      EXIT.ok,
    );
    expect(
      requests.find((request) => request.method === "POST")?.headers.get("x-cicd-updater-client"),
    ).toBe("cli");
    expect(requests[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(h.engine.view().run).toMatchObject({
      targetVersion: "1.1.0",
      requestedBy: { label: "ops", via: "cli" },
    });
    out = [];
    expect(await runCli(["status"], deps())).toBe(EXIT.ok);
    expect(out[0]).toBe("phase: scheduled (Update scheduled)");
    expect(out.join("\n")).toContain("1.0.0 -> 1.1.0");
    expect(await runCli(["reschedule", "--in", "1h"], deps())).toBe(EXIT.ok);
    expect(await runCli(["cancel"], deps())).toBe(EXIT.ok);
    expect(h.engine.view().phase).toBe("idle");
  });

  it("refuses to schedule without confirmation", async () => {
    expect(await runCli(["schedule", "1.1.0"], deps({ confirm: async () => false }))).toBe(
      EXIT.failed,
    );
    expect(await runCli(["schedule", "1.1.0"], deps({ confirm: null }))).toBe(EXIT.failed);
    expect(h.engine.view().phase).toBe("idle");
  });

  it("prints refusals, verification results, releases and logs", async () => {
    h.publish("1.0.0");
    expect(await runCli(["schedule", "1.0.0", "--yes"], deps())).toBe(EXIT.failed);
    expect(err.join("\n")).toContain("not_newer");
    expect(await runCli(["verify", "1.1.0"], deps())).toBe(EXIT.ok);
    expect(out.join("\n")).toContain("installable");
    out = [];
    expect(await runCli(["releases", "--json"], deps())).toBe(EXIT.ok);
    expect(JSON.parse(out.join("\n")).nextInstallable).toBe("1.1.0");
    expect(await runCli(["schedule", "1.1.0", "--yes"], deps())).toBe(EXIT.ok);
    await settle(h.engine);
    out = [];
    expect(await runCli(["logs"], deps())).toBe(EXIT.ok);
    expect(out.length).toBeGreaterThan(5);
    expect(await runCli(["ack"], deps())).toBe(EXIT.ok);
    expect(await runCli(["backups", "list"], deps())).toBe(EXIT.ok);
  });

  it("exits 3 when the sidecar does not answer or refuses the token", async () => {
    const down = deps({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(await runCli(["status"], down)).toBe(EXIT.unreachable);
    await fs.writeFile(path.join(h.dir, "shared", "token"), `${"0".repeat(64)}\n`);
    expect(await runCli(["status"], deps())).toBe(EXIT.unreachable);
  });

  it("answers the image health check from /healthz without the token", async () => {
    expect(await runCli(["healthcheck"], deps())).toBe(EXIT.ok);
    expect(requests.at(-1)?.url).toBe("http://127.0.0.1:8090/healthz");
    expect(requests.at(-1)?.headers.get("authorization")).toBeNull();
    const down = deps({
      fetch: (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch,
    });
    expect(await runCli(["healthcheck"], down)).toBe(EXIT.unreachable);
  });

  it("restores the captured env lines of a needs_attention run, only with confirmation", async () => {
    h.appAt("1.1.0", { kind: "never", migrates: 1 });
    await h.engine.schedule(
      { version: "1.1.0", mode: "image", leadSeconds: 0, requestedBy: { label: "a" } },
      "api",
    );
    await settle(h.engine);
    const run = h.engine.view().run;
    expect(run?.outcome).toBe("needs_attention");
    await h.store.flush();
    const before = await h.readEnv();
    expect(before).toContain("1.1.0@sha256");
    expect(
      await runCli(["recover", "restore-env", run?.id ?? ""], deps({ confirm: async () => false })),
    ).toBe(EXIT.failed);
    expect(await h.readEnv()).toBe(before);
    expect(await runCli(["recover", "restore-env", run?.id ?? "", "--yes"], deps())).toBe(EXIT.ok);
    expect(await h.readEnv()).toContain("APP_IMAGE=ghcr.io/acme/notes:1.0.0");
    expect(await runCli(["recover", "show", run?.id ?? ""], deps())).toBe(EXIT.ok);
    expect(out.join("\n")).toContain("pg_restore");
  });

  it("streams a backup to stdout and refuses names that are not backups", async () => {
    await h.engine.schedule(
      { version: "1.1.0", mode: "image", leadSeconds: 0, requestedBy: { label: "a" } },
      "api",
    );
    await settle(h.engine);
    const [backup] = await h.backups.list();
    const chunks: Buffer[] = [];
    const stdout = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(chunk as Buffer);
        callback();
      },
    });
    expect(await runCli(["backups", "cat", backup?.file ?? ""], deps({ stdout }))).toBe(EXIT.ok);
    expect(Buffer.concat(chunks).subarray(0, 5).toString()).toBe("PGDMP");
    expect(await runCli(["backups", "cat", "../status.json"], deps())).toBe(EXIT.failed);
  });

  it("exports the maintenance page", async () => {
    const target = path.join(h.dir, "page");
    expect(await runCli(["maintenance-page", "export", "--out", target], deps())).toBe(EXIT.ok);
    expect((await fs.readdir(target)).sort()).toEqual([
      "index.html",
      "maintenance.css",
      "maintenance.js",
    ]);
    expect(await fs.readFile(path.join(target, "index.html"), "utf8")).toContain(
      'data-status-url="/public/v1/status"',
    );
  });
});

describe("version", () => {
  it("reads the Docker client version without a daemon", () => {
    expect(dockerClientVersion("Docker version 29.8.2, build 7fc2dff")).toBe("29.8.2");
    expect(dockerClientVersion("not available")).toBe("not available");
  });
});

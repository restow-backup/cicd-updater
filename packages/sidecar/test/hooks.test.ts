import { ProbeError, Redactor } from "@cicd-updater/engine";
import { baseConfig } from "@cicd-updater/engine/testing";
import {
  PROBE_PRESETS,
  type UpdaterConfig,
  type UpdaterConfigInput,
  validateConfig,
} from "@cicd-updater/protocol";
import { describe, expect, it } from "vitest";
import {
  CliDocker,
  FINGERPRINT_QUERIES,
  MYSQL_QUERY_SCRIPT,
  normalizeProbeValue,
  POSTGRES_QUERY_SCRIPT,
  PRESET_QUERIES,
  SidecarHooks,
  TIMEOUT_WRAPPER,
} from "../src/index.js";
import { ScriptedRunner } from "./helpers.js";

const TOKEN = "f".repeat(64);

function config(change: (input: UpdaterConfigInput) => void = () => undefined): UpdaterConfig {
  const input = baseConfig("/opt/notes");
  change(input);
  const result = validateConfig(input);
  if (!result.ok) {
    throw new Error(JSON.stringify(result.problems));
  }
  return result.config;
}

function hooks(runner: ScriptedRunner, cfg: UpdaterConfig, fetcher?: typeof fetch) {
  const docker = new CliDocker({
    runner,
    redactor: new Redactor(),
    compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
    timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
  });
  return new SidecarHooks({
    config: cfg,
    docker,
    redactor: new Redactor(),
    token: () => TOKEN,
    fetch: fetcher,
  });
}

describe("migration probe", () => {
  it("runs the preset and the fingerprint through the constant script, data as positional parameters", async () => {
    const runner = new ScriptedRunner()
      .when(["command -v timeout >/dev/null 2>&1"], { exitCode: 0 })
      .answer((spec) =>
        spec.argv.includes(PRESET_QUERIES["node-pg-migrate"].postgres)
          ? { stdout: " 42 \n" }
          : undefined,
      )
      .answer((spec) =>
        spec.argv.includes(FINGERPRINT_QUERIES.postgres)
          ? { stdout: "d41d8cd98f00b204e9800998ecf8427e\n" }
          : undefined,
      );
    const probe = hooks(runner, config()).probe;
    expect(await probe.read()).toBe("42#d41d8cd98f00b204e9800998ecf8427e");
    const query = runner.argvs.find((argv) =>
      argv.includes(PRESET_QUERIES["node-pg-migrate"].postgres),
    );
    expect(query).toEqual([
      "docker",
      "compose",
      "-p",
      "notes",
      "exec",
      "-T",
      "db",
      "sh",
      "-c",
      TIMEOUT_WRAPPER,
      "sh",
      "60",
      "sh",
      "-c",
      POSTGRES_QUERY_SCRIPT,
      "sh",
      "",
      "",
      PRESET_QUERIES["node-pg-migrate"].postgres,
    ]);
    // Asked once per service whether `timeout` exists.
    expect(
      runner.argvs.filter((argv) => argv.includes("command -v timeout >/dev/null 2>&1")),
    ).toHaveLength(1);
  });

  it("uses user and database when configured and runs without the wrapper when timeout is missing", async () => {
    const runner = new ScriptedRunner()
      .answer(() => ({ stdout: "7\n" }))
      .when(["command -v timeout >/dev/null 2>&1"], { exitCode: 1 });
    const cfg = config((input) => {
      input.hooks = {
        ...input.hooks,
        migrationProbe: {
          type: "mysql",
          service: "db",
          user: "notes",
          database: "notes",
          preset: "prisma",
          fingerprint: false,
        },
      };
    });
    expect(await hooks(runner, cfg).probe.read()).toBe("7");
    expect(runner.argvs.at(-1)?.slice(7)).toEqual([
      "sh",
      "-c",
      MYSQL_QUERY_SCRIPT,
      "sh",
      "notes",
      "notes",
      PRESET_QUERIES.prisma.mysql,
    ]);
  });

  it("reports failures, overlong and non-printable values as probe failures", async () => {
    const failing = new ScriptedRunner().answer(() => ({
      exitCode: 2,
      errorTail: "relation pgmigrations does not exist",
    }));
    await expect(hooks(failing, config()).probe.read()).rejects.toBeInstanceOf(ProbeError);
    expect(normalizeProbeValue("  a \n\t b  ")).toBe("a b");
    expect(() => normalizeProbeValue("x".repeat(1025))).toThrow(ProbeError);
    expect(() => normalizeProbeValue("café")).toThrow(ProbeError);
  });

  it("reads command and HTTP probes", async () => {
    const runner = new ScriptedRunner().answer(() => ({ stdout: "v42\n" }));
    const commandConfig = config((input) => {
      input.hooks = {
        ...input.hooks,
        migrationProbe: {
          type: "command",
          command: { service: "api", argv: ["node", "schema-version.js"] },
        },
      };
    });
    expect(await hooks(runner, commandConfig).probe.read()).toBe("v42");
    expect(runner.argvs.at(-1)?.slice(4)).toEqual([
      "exec",
      "-T",
      "api",
      "node",
      "schema-version.js",
    ]);

    const seen: Request[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      seen.push(new Request(url, init));
      return new Response(JSON.stringify({ schema: { version: 17 } }));
    }) as typeof fetch;
    const httpConfig = config((input) => {
      input.hooks = {
        ...input.hooks,
        migrationProbe: {
          type: "http",
          http: { url: "http://api:3000/schema", jsonPath: "$.schema.version" },
        },
      };
    });
    expect(await hooks(new ScriptedRunner(), httpConfig, fetcher).probe.read()).toBe("17");
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.redirect).toBe("manual");
  });

  it("has a query for every preset and family as the design lists them", () => {
    for (const preset of PROBE_PRESETS) {
      expect(PRESET_QUERIES[preset].postgres).toMatch(/^SELECT /);
    }
    expect(PRESET_QUERIES["node-pg-migrate"].mysql).toBeNull();
    expect(PRESET_QUERIES.drizzle.postgres).toBe(
      "SELECT count(*) FROM drizzle.__drizzle_migrations",
    );
    expect(PRESET_QUERIES.sequelize.mysql).toBe("SELECT count(*) FROM `SequelizeMeta`");
    expect(FINGERPRINT_QUERIES.mysql).toContain("group_concat_max_len");
  });
});

describe("app health check", () => {
  function fetchAnswering(body: unknown, status = 200, seen: Request[] = []) {
    return (async (url: string, init: RequestInit) => {
      seen.push(new Request(url, init));
      return new Response(typeof body === "string" ? body : JSON.stringify(body), { status });
    }) as typeof fetch;
  }

  it("sends the token, reads the version and checks the conditions", async () => {
    const seen: Request[] = [];
    const cfg = config((input) => {
      input.hooks = {
        ...input.hooks,
        health: {
          type: "http",
          http: {
            url: "http://api:3000/healthz",
            versionJsonPath: "$.version",
            conditions: [{ path: "$.checks.db", equals: "ok" }],
          },
        },
      };
    });
    const ok = await hooks(
      new ScriptedRunner(),
      cfg,
      fetchAnswering({ version: "1.1.0", checks: { db: "ok" } }, 200, seen),
    ).appCheck();
    expect(ok).toEqual({ healthy: true, version: "1.1.0", detail: null });
    expect(seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    const bad = await hooks(
      new ScriptedRunner(),
      cfg,
      fetchAnswering({ version: "1.1.0", checks: { db: "down" } }),
    ).appCheck();
    expect(bad).toMatchObject({ healthy: false, detail: "condition $.checks.db does not hold" });
    const status = await hooks(new ScriptedRunner(), cfg, fetchAnswering({}, 503)).appCheck();
    expect(status).toEqual({ healthy: false, version: null, detail: "HTTP 503" });
    const redirect = await hooks(new ScriptedRunner(), cfg, fetchAnswering("", 302)).appCheck();
    expect(redirect).toMatchObject({ healthy: false, detail: "HTTP 302" });
  });

  it("does not send the token when told not to, and reports a version from a command", async () => {
    const seen: Request[] = [];
    const cfg = config((input) => {
      input.hooks = {
        ...input.hooks,
        health: { type: "http", http: { url: "http://api:3000/up", sendToken: false } },
      };
    });
    expect(
      await hooks(new ScriptedRunner(), cfg, fetchAnswering("ok", 200, seen)).appCheck(),
    ).toEqual({ healthy: true, version: null, detail: null });
    expect(seen[0]?.headers.get("authorization")).toBeNull();

    const commandConfig = config((input) => {
      input.hooks = {
        ...input.hooks,
        health: {
          type: "command",
          command: { service: "api", argv: ["app", "version"], versionFromStdout: true },
        },
      };
    });
    const runner = new ScriptedRunner().answer(() => ({ stdout: "1.1.0\nextra\n" }));
    expect(await hooks(runner, commandConfig).appCheck()).toEqual({
      healthy: true,
      version: "1.1.0",
      detail: null,
    });
  });
});

describe("smoke checks", () => {
  it("check status and body for HTTP and the exit code for commands", async () => {
    const cfg = config();
    const fetcher = (async () =>
      new Response("<title>Notes</title>", { status: 200 })) as unknown as typeof fetch;
    const subject = hooks(
      new ScriptedRunner().answer(() => ({ exitCode: 3, errorTail: "password=hunter2 failed" })),
      cfg,
      fetcher,
    );
    expect(
      await subject.check({
        type: "http",
        url: "http://web:8080/",
        expectStatus: [200],
        bodyContains: "Notes",
        sendToken: false,
      }),
    ).toEqual({
      ok: true,
      detail: "HTTP 200",
    });
    expect(
      await subject.check({
        type: "http",
        url: "http://web:8080/",
        expectStatus: [200],
        bodyContains: "Missing",
        sendToken: false,
      }),
    ).toMatchObject({ ok: false });
    expect(
      await subject.check({
        type: "http",
        url: "http://web:8080/",
        expectStatus: [204],
        bodyContains: null,
        sendToken: false,
      }),
    ).toMatchObject({
      ok: false,
      detail: "HTTP 200",
    });
    const command = await subject.check({
      type: "command",
      service: "api",
      argv: ["check"],
      expectExitCode: 0,
    });
    expect(command.ok).toBe(false);
    expect(command.detail).toContain("exit code 3");
    expect(command.detail).not.toContain("hunter2");
  });
});

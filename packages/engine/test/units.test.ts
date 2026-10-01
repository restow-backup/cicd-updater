import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { validateConfig } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BackupStore,
  buildImagePlan,
  CatalogError,
  clip,
  initialState,
  parseState,
  projectMatches,
  REDACTED,
  Redactor,
  renderRecoveryCommands,
  repositoryOf,
  StatusStore,
  sensitiveEnvValues,
  systemClock,
  versionForFileName,
} from "../src/index.js";
import {
  baseConfig,
  createHarness,
  memoryLogger,
  releaseDocument,
  writtenRef,
} from "../src/testing.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-units-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe("Redactor", () => {
  const redactor = new Redactor();

  it.each([
    ["Authorization: Bearer abcdef123456", "Authorization: [redacted]"],
    ["authorization: token ghp_abcdefghijklmnop", "authorization: [redacted]"],
    ["Authorization: Basic dXNlcjpwYXNz", "Authorization: [redacted]"],
    ['{"Authorization":"Bearer abc.def.ghi"}', '{"Authorization":"[redacted]"}'],
    ["PRIVATE-TOKEN: glpat-abcdefghijklmnopqrst", "PRIVATE-TOKEN: [redacted]"],
  ])("removes the value of an authorization header: %s", (input, expected) => {
    expect(redactor.redact(input)).toBe(expected);
  });

  it("removes bearer values, token-looking values and well-known token prefixes", () => {
    expect(redactor.redact("got Bearer abc.def-123_456")).toBe(`got Bearer ${REDACTED}`);
    expect(redactor.redact("using token ghp_1234567890abcdefgh now")).toBe(
      `using token ${REDACTED} now`,
    );
    expect(
      redactor.redact(
        "gho_abcdefghijklmnopqrstu github_pat_11ABCDEFG0abcdefghijkl glpat-abcdefghijklmnopqrst npm_abcdefghijklmnopqrstuvwxyz0123456789",
      ),
    ).toBe(`${REDACTED} ${REDACTED} ${REDACTED} ${REDACTED}`);
    expect(redactor.redact(`AGE-SECRET-KEY-1${"Q".repeat(58)}`)).toBe(REDACTED);
  });

  it("leaves ordinary words after 'token' alone", () => {
    expect(redactor.redact("fetch.token_unavailable: the feed has no token stored")).toBe(
      "fetch.token_unavailable: the feed has no token stored",
    );
  });

  it("removes credentials from URLs and credential-named pairs", () => {
    expect(redactor.redact("postgres://notes:hunter2@db:5432/notes")).toBe(
      `postgres://${REDACTED}@db:5432/notes`,
    );
    expect(redactor.redact("see https://example.com/path?a=b for details")).toBe(
      "see https://example.com/path?a=b for details",
    );
    expect(
      redactor.redact("POSTGRES_PASSWORD=hunter2 and MASTER_KEY: abcdef and MYSQL_PWD=x1"),
    ).toBe(`POSTGRES_PASSWORD=${REDACTED} and MASTER_KEY: ${REDACTED} and MYSQL_PWD=${REDACTED}`);
    expect(redactor.redact('{"password":"secret value","user":"x"}')).toBe(
      `{"password":"${REDACTED}","user":"x"}`,
    );
  });

  it("removes registered secrets wherever they appear and forgets them on request", () => {
    const local = new Redactor();
    expect(local.add("0123456789abcdef0123456789abcdef")).toBe(true);
    expect(local.add("short")).toBe(false);
    expect(local.redact("prefix0123456789abcdef0123456789abcdefsuffix")).toBe(
      `prefix${REDACTED}suffix`,
    );
    local.forget("0123456789abcdef0123456789abcdef");
    expect(local.redact("0123456789abcdef0123456789abcdef")).toBe(
      "0123456789abcdef0123456789abcdef",
    );
    local.add("abcdef123456");
    local.add("abcdef123456-and-more");
    expect(local.redact("x abcdef123456-and-more y")).toBe(`x ${REDACTED} y`);
  });

  it("applies the operator's extra patterns", () => {
    const local = new Redactor(["acme_[a-z0-9]{8}"]);
    expect(local.redact("key acme_abcd1234 used")).toBe(`key ${REDACTED} used`);
  });

  it("collapses to one line, clips and keeps surrogate pairs whole", () => {
    expect(redactor.oneLine("a\n  b\r\n\tc  ")).toBe("a b c");
    const long = redactor.oneLine("x".repeat(5000), 100);
    expect(long).toHaveLength(100);
    expect(long.endsWith("…")).toBe(true);
    expect(redactor.tail("1\n2\n3", 3)).toBe("...2\n3");
    const clipped = clip(`${"a".repeat(9)}\u{1F600}tail`, 11);
    expect(clipped).not.toMatch(/[\ud800-\udbff]$/u);
  });

  it("finds the credential-looking values of an env file with the configured key pattern", () => {
    const text = [
      "POSTGRES_PASSWORD=super-secret-db-password",
      'SESSION_SECRET="quoted secret value" # note',
      "export MASTER_KEY='single-quoted-key'",
      "S3_ACCESS_KEY_ID=short",
      "DATABASE_DSN=postgres://u:p@db/x",
      "NOTES_DOMAIN=example.com",
    ].join("\r\n");
    expect(sensitiveEnvValues(text)).toEqual([
      "super-secret-db-password",
      "quoted secret value",
      "single-quoted-key",
      "postgres://u:p@db/x",
    ]);
    expect(sensitiveEnvValues(text, "DOMAIN")).toEqual(["example.com"]);
  });
});

describe("StatusStore", () => {
  it("creates a state with an instance id, writes atomically with mode 0600 and reads back", async () => {
    const logger = memoryLogger(new Redactor());
    const store = await StatusStore.open(dir, logger, () => new Date());
    expect(store.state.phase).toBe("idle");
    expect(store.state.instanceId).toMatch(/^[0-9a-f-]{36}$/);
    const stat = await fs.stat(path.join(dir, "status.json"));
    expect(stat.mode & 0o777).toBe(0o600);
    const reopened = await StatusStore.open(dir, logger, () => new Date());
    expect(reopened.state.instanceId).toBe(store.state.instanceId);
  });

  it("keeps writes in order and limits history and events", async () => {
    const store = await StatusStore.open(dir, memoryLogger(new Redactor()), () => new Date(), {
      historyLimit: 2,
      eventLimit: 50,
    });
    for (let index = 0; index < 60; index++) {
      store.addEvent(
        {
          at: new Date().toISOString(),
          action: "update.started",
          runId: "r",
          actor: { id: null, label: "x", via: "system" },
          target: "1.0.0",
          details: {},
        },
        1_000 + index,
      );
    }
    await Promise.all([store.save(), store.save(), store.save()]);
    expect(store.state.events).toHaveLength(50);
    const raw = JSON.parse(await fs.readFile(path.join(dir, "status.json"), "utf8"));
    expect(raw.events).toHaveLength(50);
    expect(raw.eventCounter).toBe(60);
  });

  it("generates event ids that sort chronologically, also when the clock steps back", async () => {
    const store = await StatusStore.open(dir, memoryLogger(new Redactor()), () => new Date());
    const event = {
      at: "2026-11-02T10:00:00.000Z",
      action: "update.started" as const,
      runId: "r",
      actor: { id: null, label: "x", via: "system" as const },
      target: "1.0.0",
      details: {},
    };
    const first = store.addEvent(event, 2000);
    const second = store.addEvent(event, 1000);
    expect(first.id).toBe("000000000002000-000001");
    expect(second.id).toBe("000000000002000-000002");
    expect(second.id > first.id).toBe(true);
  });

  it.each([
    ["broken JSON", '{"schemaVersion":1,'],
    ["a schema mismatch", JSON.stringify({ ...initialState(), phase: "exploding" })],
    ["a newer schema version", JSON.stringify({ ...initialState(), schemaVersion: 2 })],
  ])(
    "moves aside %s and continues idle, keeping the newest five broken files",
    async (_name, content) => {
      let now = 1000;
      for (let index = 0; index < 7; index++) {
        await fs.writeFile(path.join(dir, "status.json"), content);
        await StatusStore.open(dir, memoryLogger(new Redactor()), () => new Date(now++));
      }
      const names = (await fs.readdir(dir)).filter((name) =>
        name.startsWith("status.json.corrupt-"),
      );
      expect(names).toHaveLength(5);
    },
  );

  it("explains where a document is wrong without echoing values", () => {
    expect(parseState("{")).toEqual({ ok: false, reason: "not valid JSON" });
    const result = parseState(JSON.stringify({ ...initialState(), phase: "running" }));
    expect(result).toEqual({ ok: false, reason: "schema mismatch at run" });
  });
});

describe("BackupStore", () => {
  it("names backups by project, UTC time, versions and type", () => {
    const store = new BackupStore(dir, "notes");
    const at = new Date("2026-11-02T08:05:09Z");
    expect(store.fileName(at, "1.0.0", "1.1.0", "postgres")).toBe(
      "notes-20261102-080509Z-1.0.0-to-1.1.0.pgdump",
    );
    expect(store.fileName(at, null, "1.1.0-rc.1", "mysql", true)).toBe(
      "notes-20261102-080509Z-unknown-to-1.1.0-rc.1.sql.gz.age",
    );
    expect(store.fileName(at, "1.0.0", "1.1.0", "volume")).toMatch(/\.tar\.gz$/);
    expect(store.fileName(at, "1.0.0", "1.1.0", "command")).toMatch(/\.bin$/);
    expect(versionForFileName("1.0/../x")).toBe("1.0_.._x");
    expect(store.isBackupName("other-20261102-080509Z-1.0.0-to-1.1.0.pgdump")).toBe(false);
    expect(store.isBackupName("notes-20261102-080509Z-1.0.0-to-1.1.0.pgdump.json")).toBe(false);
    expect(() => store.pathOf("../status.json")).toThrow();
    expect(() => new BackupStore(dir, "Bad Name")).toThrow();
  });

  it("lists newest first with metadata, keeps by count and age, never deletes protected or foreign files", async () => {
    const store = new BackupStore(dir, "notes");
    await store.ensureDirectory();
    const days = ["20261001", "20261020", "20261030", "20261031", "20261101"];
    for (const day of days) {
      await fs.writeFile(path.join(dir, `notes-${day}-120000Z-1.0.0-to-1.1.0.pgdump`), "PGDMP");
    }
    await store.writeMetadata("notes-20261101-120000Z-1.0.0-to-1.1.0.pgdump", {
      type: "postgres",
      bytes: 5,
      sha256: "a".repeat(64),
      createdAt: "2026-11-01T12:00:00.000Z",
      runId: "r-1-abcd",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      verified: true,
      encrypted: false,
    });
    await fs.writeFile(path.join(dir, "operator.txt"), "mine");
    const listed = await store.list(new Set(["notes-20261001-120000Z-1.0.0-to-1.1.0.pgdump"]));
    expect(listed.map((backup) => backup.file.slice(6, 14))).toEqual([
      "20261101",
      "20261031",
      "20261030",
      "20261020",
      "20261001",
    ]);
    expect(listed[0]).toMatchObject({ sha256: "a".repeat(64), verified: true, runId: "r-1-abcd" });
    expect(listed[4]).toMatchObject({ verified: false, protected: true, sha256: null });
    const deleted = await store.prune({
      keep: 3,
      maxAgeDays: 14,
      protectedFiles: new Set(["notes-20261001-120000Z-1.0.0-to-1.1.0.pgdump"]),
      now: new Date("2026-11-02T12:00:00Z"),
    });
    expect(deleted).toEqual(["notes-20261020-120000Z-1.0.0-to-1.1.0.pgdump"]);
    const left = await fs.readdir(dir);
    expect(left).toContain("operator.txt");
    expect(left).toContain("notes-20261001-120000Z-1.0.0-to-1.1.0.pgdump");
    expect(left).not.toContain(
      "notes-20261101-120000Z-1.0.0-to-1.1.0.pgdump.json".replace("1101", "1020"),
    );
  });

  it("removes only its own partial files", async () => {
    const store = new BackupStore(dir, "notes");
    await store.ensureDirectory();
    await fs.writeFile(path.join(dir, "notes-20261101-120000Z-1.0.0-to-1.1.0.pgdump.partial"), "x");
    await fs.writeFile(path.join(dir, "something.partial"), "x");
    expect(await store.purgePartials()).toEqual([
      "notes-20261101-120000Z-1.0.0-to-1.1.0.pgdump.partial",
    ]);
    expect(await fs.readdir(dir)).toEqual(["something.partial"]);
  });
});

describe("recovery commands", () => {
  const base = {
    projectName: "notes",
    profiles: ["updater"],
    selfService: "updater",
    stopServices: ["api", "worker"],
    runId: "r-1793642400000-abcd",
    databaseService: "db",
    volumes: [],
  };

  it("render a PostgreSQL restore, the env restore and the start", () => {
    expect(
      renderRecoveryCommands({
        ...base,
        backup: {
          file: "notes-20261102-100000Z-1.0.0-to-1.1.0.pgdump",
          bytes: 1,
          sha256: "a".repeat(64),
          type: "postgres",
          encrypted: false,
        },
      }),
    ).toEqual([
      "docker compose -p notes --profile updater stop api worker",
      `docker compose -p notes --profile updater exec -T updater cicd-updater backups cat notes-20261102-100000Z-1.0.0-to-1.1.0.pgdump | docker compose -p notes --profile updater exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "\${POSTGRES_DB:-$POSTGRES_USER}" --clean --if-exists'`,
      "docker compose -p notes --profile updater exec -T updater cicd-updater recover restore-env r-1793642400000-abcd",
      "docker compose -p notes --profile updater up -d",
    ]);
  });

  it("decrypt encrypted MySQL backups on the operator's side and leave other types to the operator", () => {
    const mysql = renderRecoveryCommands({
      ...base,
      backup: {
        file: "notes-x.sql.gz.age",
        bytes: 1,
        sha256: "a".repeat(64),
        type: "mysql",
        encrypted: true,
      },
    });
    expect(mysql[1]).toContain("| age -d -i <path-to-your-age-identity> | gunzip |");
    const none = renderRecoveryCommands({ ...base, stopServices: [], backup: null });
    expect(none).toEqual([
      "docker compose -p notes --profile updater exec -T updater cicd-updater recover restore-env r-1793642400000-abcd",
      "docker compose -p notes --profile updater up -d",
    ]);
  });
});

describe("release helpers", () => {
  it("match the release project with the feed, also without a Forgejo prefix", () => {
    expect(projectMatches("github.com/Acme/Notes", "github.com/acme/notes")).toBe(true);
    expect(projectMatches("git.example.com/acme/notes", "git.example.com/forge/acme/notes")).toBe(
      true,
    );
    expect(projectMatches("git.example.com/other/notes", "git.example.com/forge/acme/notes")).toBe(
      false,
    );
    expect(projectMatches("evil.example.com/acme/notes", "git.example.com/acme/notes")).toBe(false);
    expect(projectMatches("github.com/notes", "github.com/acme/notes")).toBe(false);
  });

  it("plan pull and write references, with mirrors and optional services", () => {
    const validated = validateConfig({
      ...baseConfig("/opt/notes"),
      images: { web: { repository: "mirror.example.com/acme/notes-web" } },
    });
    if (!validated.ok) throw new Error("config");
    const { plan, missing } = buildImagePlan(
      validated.config,
      JSON.parse(releaseDocument("1.1.0").toString()),
    );
    expect(missing).toEqual([]);
    expect(plan.api?.ref).toBe(writtenRef("app", "1.1.0"));
    expect(plan.web?.pullRef).toMatch(/^mirror\.example\.com\/acme\/notes-web@sha256:/);
    expect(plan.web?.ref).toMatch(/^mirror\.example\.com\/acme\/notes-web:1\.1\.0@sha256:/);
    const appOnly = JSON.parse(releaseDocument("1.1.0", undefined, ["app"]).toString());
    expect(buildImagePlan(validated.config, appOnly).missing).toEqual(["web"]);
  });

  it("find the repository of a reference", () => {
    expect(repositoryOf("ghcr.io/acme/notes:1.1.0@sha256:abc")).toBe("ghcr.io/acme/notes");
    expect(repositoryOf("registry.example.com:5000/acme/notes@sha256:abc")).toBe(
      "registry.example.com:5000/acme/notes",
    );
    expect(repositoryOf("registry.example.com:5000/acme/notes")).toBe(
      "registry.example.com:5000/acme/notes",
    );
    expect(repositoryOf("notes:local")).toBe("notes");
  });
});

describe("running version", () => {
  it("prefers the health check, then the image label, then the last run, then the env key", async () => {
    const h = await createHarness({
      configure: (config) => {
        config.env = { versionVar: "APP_VERSION" };
      },
    });
    try {
      expect(await h.running.detect(true)).toEqual({ version: "1.0.0", source: "health" });
      h.ops.appBehavior.set("ghcr.io/acme/notes:1.0.0", { kind: "never" });
      h.ops.imageLabels.set("ghcr.io/acme/notes:1.0.0", {
        "org.opencontainers.image.version": "v1.0.0",
      });
      expect(await h.running.detect(true)).toEqual({ version: "1.0.0", source: "label" });
      h.ops.imageLabels.clear();
      expect(await h.running.detect(true)).toEqual({ version: null, source: null });
      await fs.appendFile(`${h.projectDir}/.env`, "APP_VERSION=1.0.0\n");
      expect(await h.running.detect(true)).toEqual({ version: "1.0.0", source: "env" });
      // Cached for 30 seconds.
      await fs.appendFile(`${h.projectDir}/.env`, "APP_VERSION=2.0.0\n");
      expect((await h.running.detect()).version).toBe("1.0.0");
      h.clock.advance(31_000);
      expect((await h.running.detect()).version).toBe("2.0.0");
    } finally {
      await h.cleanup();
    }
  });
});

describe("releases view", () => {
  it("lists newer releases of the channel with their refusals and the next installable one", async () => {
    const h = await createHarness();
    try {
      h.publish("1.1.0");
      h.publish("1.2.0", (doc) => {
        doc.upgrade.minimumFromVersion = "1.1.0";
      });
      h.catalog.add("1.3.0", null);
      h.publish("0.9.0");
      h.publish("2.0.0-beta.1");
      const view = await h.releases.releasesView(true);
      expect(view.channel).toBe("stable");
      expect(view.running).toBe("1.0.0");
      expect(view.releases.map((release) => [release.version, release.refusals])).toEqual([
        ["1.3.0", ["no_release_document"]],
        ["1.2.0", ["below_minimum_version"]],
        ["1.1.0", []],
        ["0.9.0", ["not_newer"]],
      ]);
      expect(view.releases.find((release) => release.version === "1.1.0")).toMatchObject({
        verified: false,
        releaseSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
        minimumFromVersion: null,
      });
      expect(view.nextInstallable).toBe("1.1.0");

      h.catalog.listError = new CatalogError("feed_unavailable", "rate_limited", "rate limited");
      await expect(h.releases.releasesView(true)).rejects.toMatchObject({
        code: "feed_unavailable",
        extensions: { feedError: "rate_limited" },
      });
    } finally {
      await h.cleanup();
    }
  });
});

describe("system clock", () => {
  it("sleeps, wakes early on abort and runs and cancels timers", async () => {
    const started = Date.now();
    await systemClock.sleep(5);
    expect(Date.now() - started).toBeGreaterThanOrEqual(4);
    const aborted = new AbortController();
    aborted.abort();
    await systemClock.sleep(60_000, aborted.signal);
    const later = new AbortController();
    const sleeping = systemClock.sleep(60_000, later.signal);
    later.abort();
    await sleeping;
    let ran = 0;
    await new Promise<void>((resolve) => {
      systemClock.setTimer(() => {
        ran += 1;
        resolve();
      }, 1);
    });
    const cancelled = systemClock.setTimer(() => {
      ran += 10;
    }, 1);
    cancelled.cancel();
    await systemClock.sleep(10);
    expect(ran).toBe(1);
    expect(systemClock.now()).toBeInstanceOf(Date);
  });
});

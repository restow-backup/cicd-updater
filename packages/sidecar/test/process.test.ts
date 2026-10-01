import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Redactor } from "@cicd-updater/engine";
import { memoryLogger } from "@cicd-updater/engine/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  consoleLogger,
  isAuthorized,
  loadBranding,
  loadConfig,
  loadOrCreateToken,
  MAINTENANCE_CSP,
  maintenanceFiles,
  ownContainerIds,
  parseConfigText,
  projectNameOf,
  readOperatorToken,
  renderIndexHtml,
  StateLock,
  StateLockedError,
  splitListen,
  TokenError,
} from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-process-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const VALID = `version: 1
compose:
  projectDir: /opt/notes
release:
  feed: { type: github, url: https://github.com/acme/notes }
trust:
  keyless:
    github: { repository: acme/notes, workflow: .github/workflows/release.yml }
services:
  - { name: api, image: app, imageVar: APP_IMAGE }
`;

describe("updater.yaml loading", () => {
  it("loads, applies environment overrides and hashes the effective configuration", async () => {
    const file = path.join(dir, "updater.yaml");
    await fs.writeFile(file, VALID);
    const loaded = await loadConfig({
      CICD_UPDATER_CONFIG: file,
      CICD_UPDATER_COMPOSE__PROJECT_DIR: "/srv/notes",
    });
    expect(loaded.ok).toBe(true);
    if (!loaded.ok) return;
    expect(loaded.config.compose.projectDir).toBe("/srv/notes");
    expect(loaded.overrides).toEqual(["CICD_UPDATER_COMPOSE__PROJECT_DIR"]);
    expect(loaded.configHash).toMatch(/^[0-9a-f]{64}$/);
    const again = await loadConfig({
      CICD_UPDATER_CONFIG: file,
      CICD_UPDATER_COMPOSE__PROJECT_DIR: "/srv/notes",
    });
    expect(again.ok && again.configHash).toBe(loaded.configHash);
    const other = await loadConfig({ CICD_UPDATER_CONFIG: file });
    expect(other.ok && other.configHash).not.toBe(loaded.configHash);
  });

  it("refuses anchors, aliases, several documents, duplicate keys and oversized files", () => {
    expect(parseConfigText(`${VALID}x: &a 1\ny: *a\n`).problems[0]?.message).toBe(
      "anchors and aliases are not allowed",
    );
    expect(parseConfigText(`${VALID}---\nversion: 1\n`).problems[0]?.message).toBe(
      "must contain exactly one YAML document",
    );
    expect(parseConfigText(`${VALID}version: 1\n`).problems[0]?.path).toMatch(
      /^\(line \d+, column \d+\)$/,
    );
    expect(parseConfigText("- a\n- b\n").problems[0]).toEqual({
      path: "(root)",
      message: "must be a mapping",
    });
    expect(parseConfigText(`${VALID}#${"x".repeat(300 * 1024)}`).problems[0]?.message).toMatch(
      /larger than/,
    );
    expect(parseConfigText("").problems[0]?.message).toMatch(/empty|mapping/);
  });

  it("collects schema and override problems together and reports a missing file by path", async () => {
    const file = path.join(dir, "updater.yaml");
    await fs.writeFile(file, VALID.replace("imageVar: APP_IMAGE", "imageVar: app"));
    const loaded = await loadConfig({
      CICD_UPDATER_CONFIG: file,
      CICD_UPDATER_SERVER__LISTEN: "",
      CICD_UPDATER_NOPE: "1",
    });
    expect(loaded.ok).toBe(false);
    if (loaded.ok) return;
    expect(loaded.problems.map((problem) => problem.path)).toEqual(
      expect.arrayContaining([
        "CICD_UPDATER_NOPE",
        "CICD_UPDATER_SERVER__LISTEN (server.listen)",
        "services.0.imageVar",
      ]),
    );
    const missing = await loadConfig({ CICD_UPDATER_CONFIG: path.join(dir, "absent.yaml") });
    expect(missing).toMatchObject({
      ok: false,
      problems: [{ path: "(file)", message: "cannot be read (ENOENT)" }],
    });
  });
});

describe("token", () => {
  it("generates a 64-hex token with mode 0640 once and keeps it", async () => {
    const logger = memoryLogger(new Redactor());
    const token = await loadOrCreateToken(path.join(dir, "shared"), 0, logger);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    const stat = await fs.stat(path.join(dir, "shared", "token"));
    expect(stat.mode & 0o777).toBe(0o640);
    await fs.chmod(path.join(dir, "shared", "token"), 0o666);
    expect(await loadOrCreateToken(path.join(dir, "shared"), 0, logger)).toBe(token);
    expect((await fs.stat(path.join(dir, "shared", "token"))).mode & 0o777).toBe(0o640);
    await fs.writeFile(path.join(dir, "shared", "token"), "garbage");
    expect(await loadOrCreateToken(path.join(dir, "shared"), 0, logger)).not.toBe(token);
  });

  it("reads an operator token file and reports problems by path only", async () => {
    const file = path.join(dir, "secret");
    await fs.writeFile(file, `${"A".repeat(40)}\n`);
    expect(await readOperatorToken(file)).toBe("A".repeat(40));
    await fs.writeFile(file, "short-secret-value");
    const error = await readOperatorToken(file).catch((caught: unknown) => caught as TokenError);
    expect(error).toBeInstanceOf(TokenError);
    expect((error as TokenError).message).toContain(file);
    expect((error as TokenError).message).not.toContain("short-secret-value");
  });

  it("accepts exactly 'Bearer <token>'", () => {
    const token = "a".repeat(64);
    expect(isAuthorized(`Bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`bearer ${token}`, token)).toBe(true);
    expect(isAuthorized(`Basic ${token}`, token)).toBe(false);
    expect(isAuthorized(token, token)).toBe(false);
    expect(isAuthorized(`Bearer ${token}x`, token)).toBe(false);
    expect(isAuthorized(undefined, token)).toBe(false);
    expect(isAuthorized("", token)).toBe(false);
  });
});

describe("state lock", () => {
  const logger = memoryLogger(new Redactor());

  it("refuses a live lock of another container and takes over a stale one or its own", async () => {
    const now = new Date("2026-11-02T10:00:00Z");
    const first = await StateLock.acquire({
      stateDir: dir,
      instanceId: "i",
      hostname: "aaaaaaaaaaaa",
      logger,
      now: () => now,
    });
    await expect(
      StateLock.acquire({
        stateDir: dir,
        instanceId: "i",
        hostname: "bbbbbbbbbbbb",
        logger,
        now: () => new Date(now.getTime() + 30_000),
      }),
    ).rejects.toBeInstanceOf(StateLockedError);
    const takeover = await StateLock.acquire({
      stateDir: dir,
      instanceId: "i",
      hostname: "bbbbbbbbbbbb",
      logger,
      now: () => new Date(now.getTime() + 61_000),
    });
    // The first process may not delete the lock it lost.
    await first.release();
    expect(JSON.parse(await fs.readFile(path.join(dir, ".lock"), "utf8")).hostname).toBe(
      "bbbbbbbbbbbb",
    );
    const restarted = await StateLock.acquire({
      stateDir: dir,
      instanceId: "i",
      hostname: "bbbbbbbbbbbb",
      logger,
      now: () => new Date(now.getTime() + 62_000),
    });
    await takeover.release();
    await restarted.release();
    await expect(fs.access(path.join(dir, ".lock"))).rejects.toThrow();
  });
});

describe("maintenance page", () => {
  it("escapes branding, validates colors and links, and embeds only the configured catalogs", async () => {
    await fs.writeFile(path.join(dir, "logo.svg"), "<svg/>");
    await fs.writeFile(
      path.join(dir, "branding.json"),
      JSON.stringify({
        productName: '<script>alert("x")</script>',
        accentColor: "red; background:url(x)",
        supportUrl: "javascript:alert(1)",
        logoFile: "logo.svg",
      }),
    );
    const branding = await loadBranding(path.join(dir, "branding.json"));
    expect(branding.accentColor).toBe("#2563eb");
    expect(branding.supportUrl).toBeNull();
    expect(branding.logo?.type).toBe("image/svg+xml");
    const html = renderIndexHtml(branding, ["de"]);
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&#60;script&#62;");
    expect(html).toContain('lang="de"');
    expect(html).toContain('"Wartung"');
    expect(html).not.toContain('"Maintenance in progress"');
    expect(html).toContain('<script src="maintenance.js"></script>');
    expect(MAINTENANCE_CSP).toContain("script-src 'self'");
  });

  it("lets a template directory replace the page and the stylesheet, but not the script", async () => {
    await fs.mkdir(path.join(dir, "tpl"));
    await fs.writeFile(path.join(dir, "tpl", "index.html"), "<p>custom</p>");
    await fs.writeFile(path.join(dir, "tpl", "maintenance.js"), "evil()");
    const files = await maintenanceFiles({
      maintenancePage: {
        enabled: true,
        brandingFile: null,
        templateDir: path.join(dir, "tpl"),
        languages: ["en"],
      },
    });
    expect(files["index.html"]?.body).toBe("<p>custom</p>");
    expect(String(files["maintenance.js"]?.body)).not.toContain("evil");
    expect(Object.keys(files).sort()).toEqual(["index.html", "maintenance.css", "maintenance.js"]);
  });
});

describe("process helpers", () => {
  it("finds its own container id in mountinfo or the hostname", () => {
    const id = "e".repeat(64);
    expect(
      ownContainerIds(
        "abcdef012345",
        `1 2 0:1 /var/lib/docker/containers/${id}/hostname /etc/hostname rw`,
      ),
    ).toEqual([id, "abcdef012345"]);
    expect(ownContainerIds("my-host", null)).toEqual([]);
  });

  it("derives the project name and splits the listen address", () => {
    const config = { compose: { projectName: null, projectDir: "/opt/My.Notes" } } as never;
    expect(projectNameOf(config, null)).toBe("mynotes");
    expect(projectNameOf(config, { projectName: "notes" } as never)).toBe("notes");
    expect(splitListen("0.0.0.0:8090")).toEqual(["0.0.0.0", "8090"]);
    expect(splitListen("[::]:8090")).toEqual(["::", "8090"]);
  });

  it("logs redacted text or JSON lines above the level", () => {
    const lines: string[] = [];
    const redactor = new Redactor();
    redactor.add("super-secret-token-value");
    const logger = consoleLogger({
      redactor,
      level: "info",
      format: "json",
      now: () => new Date("2026-11-02T10:00:00Z"),
      write: (_stream, line) => lines.push(line),
    });
    logger.debug("hidden");
    logger.warn("token super-secret-token-value leaked?");
    expect(lines).toEqual([
      JSON.stringify({
        time: "2026-11-02T10:00:00.000Z",
        level: "warn",
        message: "token [redacted] leaked?",
      }),
    ]);
  });
});

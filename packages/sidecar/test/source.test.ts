import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type CatalogError, Redactor, type SourceError } from "@cicd-updater/engine";
import { baseConfig, memoryLogger, releaseDocument } from "@cicd-updater/engine/testing";
import type { FetchLike } from "@cicd-updater/feed";
import { type UpdaterConfigInput, validateConfig } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ArchiveSourceBuilder,
  CliDocker,
  extractTarGz,
  SidecarCatalog,
  safeEntryPath,
  sourceAllowed,
  UnsafeArchiveError,
} from "../src/index.js";
import { rejection, ScriptedRunner, tarGz } from "./helpers.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-source-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

async function extract(entries: Parameters<typeof tarGz>[0], maxBytes = 1024 * 1024) {
  const archive = path.join(dir, `a-${Math.random()}.tar.gz`);
  await fs.writeFile(archive, tarGz(entries));
  const target = path.join(dir, `t-${Math.random()}`);
  await extractTarGz(archive, target, { maxBytes });
  return target;
}

describe("safe tar extraction", () => {
  it("drops the top-level directory and writes files, directories and inner links", async () => {
    const target = await extract([
      { name: "notes-1.1.0/", type: "5" },
      { name: "notes-1.1.0/Dockerfile", body: "FROM scratch\n" },
      { name: "notes-1.1.0/src/", type: "5" },
      { name: "notes-1.1.0/src/main.js", body: "console.log(1)", mode: 0o4755 },
      { name: "notes-1.1.0/link", type: "2", linkname: "src/main.js" },
      { name: `notes-1.1.0/${"deep/".repeat(25)}file.txt`, body: "long name" },
    ]);
    expect(await fs.readFile(path.join(target, "Dockerfile"), "utf8")).toBe("FROM scratch\n");
    expect(await fs.readFile(path.join(target, "link"), "utf8")).toBe("console.log(1)");
    expect((await fs.stat(path.join(target, "src/main.js"))).mode & 0o7000).toBe(0);
    expect(await fs.readFile(path.join(target, `${"deep/".repeat(25)}file.txt`), "utf8")).toBe(
      "long name",
    );
  });

  it.each([
    ["an absolute path", [{ name: "/etc/passwd", body: "x" }]],
    ["a .. segment", [{ name: "top/../../escape", body: "x" }]],
    ["a link outside the tree", [{ name: "top/link", type: "2", linkname: "../../etc/passwd" }]],
    ["an absolute link", [{ name: "top/link", type: "2", linkname: "/etc/passwd" }]],
    [
      "a hard link",
      [
        { name: "top/a", body: "x" },
        { name: "top/b", type: "1", linkname: "top/a" },
      ],
    ],
    ["a device file", [{ name: "top/dev", type: "3" }]],
    ["a FIFO", [{ name: "top/fifo", type: "6" }]],
  ])("refuses %s", async (_name, entries) => {
    await expect(extract(entries as Parameters<typeof tarGz>[0])).rejects.toBeInstanceOf(
      UnsafeArchiveError,
    );
  });

  it("refuses to write through a link that leaves the tree", async () => {
    await expect(
      extract([
        { name: "top/inner", type: "2", linkname: "." },
        { name: "top/inner/../../x", body: "x" },
      ]),
    ).rejects.toBeInstanceOf(UnsafeArchiveError);
  });

  it("stops past the size limit", async () => {
    await expect(extract([{ name: "top/big", body: "x".repeat(5000) }], 1000)).rejects.toThrow(
      /larger than allowed/,
    );
  });

  it("computes safe entry paths", () => {
    expect(safeEntryPath("top/a/b", 1)).toBe("a/b");
    expect(safeEntryPath("top/", 1)).toBeNull();
    expect(safeEntryPath("./top/./a", 1)).toBe("a");
    expect(() => safeEntryPath("C:/x", 0)).toThrow(UnsafeArchiveError);
  });
});

function config(change: (input: UpdaterConfigInput) => void = () => undefined) {
  const input = baseConfig("/opt/notes");
  input.state = { dir: path.join(dir, "state") };
  change(input);
  const result = validateConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  return result.config;
}

describe("source mode", () => {
  it("is allowed only for an allowlisted feed repository or its host", () => {
    expect(sourceAllowed([], "github.com/acme/notes")).toBe(false);
    expect(sourceAllowed(["github.com/acme/notes"], "github.com/acme/notes")).toBe(true);
    expect(sourceAllowed(["github.com/acme/other"], "github.com/acme/notes")).toBe(false);
    expect(sourceAllowed(["git.example.com"], "git.example.com/forge/acme/notes")).toBe(true);
    expect(sourceAllowed(["git.example.com/acme/notes"], "git.example.com/forge/acme/notes")).toBe(
      true,
    );
    expect(sourceAllowed(["github.com/acme/notes"], null)).toBe(false);
  });

  it("downloads the tag's archive with the token to its origin only, builds every key and removes the tree", async () => {
    const tokenFile = path.join(dir, "token");
    await fs.writeFile(tokenFile, "ghp_sourcetoken1234567890\n");
    const cfg = config((input) => {
      input.source = {
        allowlist: ["github.com/acme/notes"],
        tokenFile,
        build: { web: { context: "web", target: "edge", buildArgs: { APP_VERSION: "{version}" } } },
      };
    });
    const seen: { url: string; authorization: string | undefined }[] = [];
    const archive = tarGz([
      { name: "acme-notes-abc/Dockerfile", body: "FROM scratch\n" },
      { name: "acme-notes-abc/web/Dockerfile", body: "FROM scratch\n" },
    ]);
    const fetcher: FetchLike = async (url, init) => {
      seen.push({ url, authorization: init.headers.authorization });
      if (url.startsWith("https://api.github.com/")) {
        return new Response(null, {
          status: 302,
          headers: { location: "https://codeload.github.com/acme/notes/legacy.tar.gz/v1.1.0" },
        });
      }
      return new Response(archive);
    };
    const runner = new ScriptedRunner();
    const docker = new CliDocker({
      runner,
      redactor: new Redactor(),
      compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
      timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
    });
    const builder = new ArchiveSourceBuilder({
      config: cfg,
      stateDir: path.join(dir, "state"),
      projectName: "notes",
      docker,
      redactor: new Redactor(),
      logger: memoryLogger(new Redactor()),
      project: "github.com/acme/notes",
      archiveUrl: (tag) => `https://api.github.com/repos/acme/notes/tarball/${tag}`,
      fetch: fetcher,
    });
    expect(builder.allowed()).toBe(true);
    const stages: string[] = [];
    const built = await builder.build({
      runId: "r-1-abcd",
      version: "1.1.0",
      tag: "v1.1.0",
      imageKeys: ["app", "web"],
      signal: new AbortController().signal,
      onStage: async (stage, index, total) => {
        stages.push(`${stage} ${index}/${total}`);
      },
    });
    expect(built).toEqual({
      app: "cicd-updater.local/notes/app:1.1.0",
      web: "cicd-updater.local/notes/web:1.1.0",
    });
    expect(stages).toEqual(["downloading 0/2", "building 1/2", "building 2/2"]);
    expect(seen).toEqual([
      {
        url: "https://api.github.com/repos/acme/notes/tarball/v1.1.0",
        authorization: "Bearer ghp_sourcetoken1234567890",
      },
      {
        url: "https://codeload.github.com/acme/notes/legacy.tar.gz/v1.1.0",
        authorization: undefined,
      },
    ]);
    const web = runner.argvs[1] as string[];
    expect(web).toEqual(
      expect.arrayContaining(["--target", "edge", "--build-arg", "APP_VERSION=1.1.0"]),
    );
    expect(web.at(-1)).toMatch(/src\/r-1-abcd\/tree\/web$/);
    expect(await fs.readdir(path.join(dir, "state", "src"))).toEqual([]);
  });

  it("refuses when not allowed, maps download and build failures, and needs a Dockerfile", async () => {
    const make = (allowlist: string[], fetcher: FetchLike, runner = new ScriptedRunner()) =>
      new ArchiveSourceBuilder({
        config: config((input) => {
          input.source = { allowlist };
        }),
        stateDir: path.join(dir, "state"),
        projectName: "notes",
        docker: new CliDocker({
          runner,
          redactor: new Redactor(),
          compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
          timeouts: { pullSeconds: 1, upSeconds: 1, composeSeconds: 10, stopSeconds: 1 },
        }),
        redactor: new Redactor(),
        logger: memoryLogger(new Redactor()),
        project: "github.com/acme/notes",
        archiveUrl: () => "https://api.github.com/repos/acme/notes/tarball/v1.1.0",
        fetch: fetcher,
      });
    const input = {
      runId: "r-1-abcd",
      version: "1.1.0",
      tag: "v1.1.0",
      imageKeys: ["app"],
      signal: new AbortController().signal,
      onStage: async () => undefined,
    };
    expect(
      (await rejection<SourceError>(make([], async () => new Response("")).build(input))).kind,
    ).toBe("source_not_allowed");
    expect(
      (
        await rejection<SourceError>(
          make(["github.com"], async () => new Response("", { status: 404 })).build(input),
        )
      ).kind,
    ).toBe("download_failed");
    const noDockerfile = async () => new Response(tarGz([{ name: "top/README.md", body: "x" }]));
    expect(
      (await rejection<SourceError>(make(["github.com"], noDockerfile).build(input))).kind,
    ).toBe("build_failed");
    const failing = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail: "failed to solve",
    }));
    const withDockerfile = async () =>
      new Response(tarGz([{ name: "top/Dockerfile", body: "FROM scratch" }]));
    expect(
      (await rejection<SourceError>(make(["github.com"], withDockerfile, failing).build(input)))
        .kind,
    ).toBe("build_failed");
  });
});

describe("release catalog", () => {
  it("reads a file feed: index, documents and bundles by plain file name", async () => {
    const feedDir = path.join(dir, "feed");
    await fs.mkdir(feedDir);
    await fs.writeFile(
      path.join(feedDir, "index.json"),
      JSON.stringify({
        schemaVersion: 1,
        releases: [
          {
            version: "1.1.0",
            tag: "v1.1.0",
            prerelease: false,
            releaseJson: "1.1.0.json",
            bundle: "1.1.0.bundle.json",
          },
          { version: "1.0.0", tag: "v1.0.0", prerelease: false, releaseJson: "../escape.json" },
        ],
      }),
    );
    await fs.writeFile(path.join(feedDir, "1.1.0.json"), releaseDocument("1.1.0"));
    await fs.writeFile(path.join(feedDir, "1.1.0.bundle.json"), "{}");
    const catalog = new SidecarCatalog({
      config: config((input) => {
        input.release = { feed: { type: "file", path: feedDir } };
      }),
      stateDir: path.join(dir, "state"),
      redactor: new Redactor(),
      logger: memoryLogger(new Redactor()),
      now: () => new Date(),
    });
    expect(catalog.project).toBeNull();
    const list = await catalog.list(true);
    expect(list.map((entry) => [entry.version, entry.hasDocument])).toEqual([
      ["1.1.0", true],
      ["1.0.0", false],
    ]);
    const fetched = await catalog.fetch("1.1.0");
    expect(Buffer.from(fetched.document as Uint8Array).toString()).toContain('"version": "1.1.0"');
    expect(Buffer.from(fetched.bundle as Uint8Array).toString()).toBe("{}");
    await expect(catalog.fetch("9.9.9")).rejects.toMatchObject({ code: "release_not_found" });
  });

  it("reads a remote feed through the guarded client, caches it and maps feed errors", async () => {
    let calls = 0;
    const fetcher: FetchLike = async (url) => {
      calls += 1;
      if (url.includes("/releases?")) {
        return new Response(
          JSON.stringify([
            {
              tag_name: "v1.1.0",
              assets: [
                {
                  name: "release.json",
                  browser_download_url:
                    "https://github.com/acme/notes/releases/download/v1.1.0/release.json",
                },
              ],
            },
          ]),
        );
      }
      return new Response(releaseDocument("1.1.0"));
    };
    let now = Date.parse("2026-11-02T10:00:00Z");
    const catalog = new SidecarCatalog({
      config: config(),
      stateDir: path.join(dir, "state"),
      redactor: new Redactor(),
      logger: memoryLogger(new Redactor()),
      now: () => new Date(now),
      fetch: fetcher,
    });
    expect(catalog.project).toBe("github.com/acme/notes");
    expect(catalog.archiveUrl("v1.1.0")).toBe(
      "https://api.github.com/repos/acme/notes/tarball/v1.1.0",
    );
    await catalog.list(false);
    await catalog.list(false);
    expect(calls).toBe(1);
    now += 301_000;
    await catalog.list(false);
    expect(calls).toBe(2);
    const fetched = await catalog.fetch("1.1.0");
    expect(fetched.document).not.toBeNull();
    expect(fetched.bundle).toBeNull();

    const failing = new SidecarCatalog({
      config: config(),
      stateDir: path.join(dir, "state"),
      redactor: new Redactor(),
      logger: memoryLogger(new Redactor()),
      now: () => new Date(),
      fetch: async () =>
        new Response("{}", { status: 403, headers: { "x-ratelimit-remaining": "0" } }),
    });
    const error = await rejection<CatalogError>(failing.list(true));
    expect(error).toMatchObject({ code: "feed_unavailable", feedError: "rate_limited" });
  });

  it("stores verified documents and keeps the newest five", async () => {
    const catalog = new SidecarCatalog({
      config: config(),
      stateDir: path.join(dir, "state"),
      redactor: new Redactor(),
      logger: memoryLogger(new Redactor()),
      now: () => new Date(),
    });
    for (const version of ["1.0.0", "1.1.0", "1.2.0", "1.3.0", "1.10.0", "2.0.0-rc.1"]) {
      await catalog.store(
        version,
        Buffer.from(version),
        version === "1.0.0" ? null : Buffer.from("bundle"),
      );
    }
    expect(await catalog.load("1.0.0")).toEqual({ document: Buffer.from("1.0.0"), bundle: null });
    await catalog.prune(5);
    expect((await fs.readdir(path.join(dir, "state", "releases"))).sort()).toEqual([
      "1.1.0",
      "1.10.0",
      "1.2.0",
      "1.3.0",
      "2.0.0-rc.1",
    ]);
    expect(await catalog.load("9.9.9")).toBeNull();
    await expect(catalog.store("../x", Buffer.from("x"), null)).rejects.toThrow();
  });
});

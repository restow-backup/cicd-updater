import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { parseReleaseDocument } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parse } from "yaml";
import {
  attestSbomArgs,
  buildImages,
  checkTag,
  composeVariables,
  createIndexes,
  createReleaseDocument,
  documentedVariables,
  type Exec,
  type ExecResult,
  envCheck,
  generateSboms,
  indexEntries,
  noRestartOverride,
  ociLabels,
  parseCosignVersion,
  parsePolicy,
  projectOf,
  publishRelease,
  runReleaseCli,
  runSigning,
  runSmoke,
  serializeReleaseDocument,
  sidecarUpgradePlan,
  signBlobArgs,
  signImageArgs,
  smokeEnvFile,
  verifyBlobArgs,
} from "../src/index.js";

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-release-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const DIGEST_APP = `sha256:${"1".repeat(64)}`;
const DIGEST_WEB = `sha256:${"2".repeat(64)}`;
const IMAGES = {
  app: {
    repository: "ghcr.io/acme/notes",
    tag: "1.4.0",
    digest: DIGEST_APP,
    platforms: ["linux/amd64", "linux/arm64"] as ("linux/amd64" | "linux/arm64")[],
  },
  web: {
    repository: "ghcr.io/acme/notes-web",
    tag: "1.4.0",
    digest: DIGEST_WEB,
    platforms: ["linux/amd64", "linux/arm64"] as ("linux/amd64" | "linux/arm64")[],
  },
};

describe("release.json creation", () => {
  const base = {
    images: IMAGES,
    version: "1.4.0",
    tag: "v1.4.0",
    project: "github.com/acme/notes",
    commit: "4f1c0b6e2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b",
    createdAt: new Date("2026-11-02T18:04:11.123Z"),
    notesUrl: "https://github.com/acme/notes/releases/tag/v1.4.0",
    policy: parsePolicy("minimumFromVersion: 1.2.0\nrequiresEnv: [NOTES_SEARCH_URL]\n"),
    signing: { mode: "keyless" as const, toolVersion: "3.1.3" },
  };

  it("builds the document of the design from the published images and the policy", () => {
    const document = createReleaseDocument(base);
    expect(document).toEqual({
      schemaVersion: 1,
      project: "github.com/acme/notes",
      version: "1.4.0",
      tag: "v1.4.0",
      channel: "stable",
      commit: "4f1c0b6e2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b",
      createdAt: "2026-11-02T18:04:11Z",
      notesUrl: "https://github.com/acme/notes/releases/tag/v1.4.0",
      images: IMAGES,
      upgrade: {
        minimumFromVersion: "1.2.0",
        manualSteps: { required: false, summary: null, url: null },
      },
      requires: { updater: ">=1.0.0", env: ["NOTES_SEARCH_URL"] },
      signing: { mode: "keyless", tool: "cosign", toolVersion: "3.1.3" },
    });
    const bytes = serializeReleaseDocument(document);
    expect(bytes.endsWith("}\n")).toBe(true);
    expect(parseReleaseDocument(bytes, { tagPattern: "v{version}" }).ok).toBe(true);
  });

  it("marks pre-releases beta and refuses documents that break the rules", () => {
    const beta = createReleaseDocument({
      ...base,
      version: "1.5.0-rc.1",
      tag: "v1.5.0-rc.1",
      images: { app: { ...IMAGES.app, tag: "1.5.0-rc.1" } },
      policy: parsePolicy(null),
    });
    expect(beta.channel).toBe("beta");
    expect(() => createReleaseDocument({ ...base, version: "v1.4.0" })).toThrow(/plain version/);
    expect(() => createReleaseDocument({ ...base, tag: "v1.4.1" })).toThrow(
      /release\.tag_mismatch/,
    );
    expect(() =>
      createReleaseDocument({ ...base, images: { app: { ...IMAGES.app, tag: "latest" } } }),
    ).toThrow(/image_tag_mismatch/);
    expect(() =>
      createReleaseDocument({ ...base, policy: parsePolicy("minimumFromVersion: 1.4.0\n") }),
    ).toThrow(/minimum_not_lower/);
    expect(() =>
      createReleaseDocument({
        ...base,
        images: { app: { ...IMAGES.app, digest: "sha256:short" } },
      }),
    ).toThrow(/release\.json/);
  });

  it("reads the policy file strictly and derives the project", () => {
    expect(parsePolicy(null)).toEqual({
      minimumFromVersion: null,
      requiresUpdater: ">=1.0.0",
      requiresEnv: [],
      manualSteps: { required: false, summary: null, url: null },
    });
    expect(() => parsePolicy("minimumFromVerison: 1.0.0\n")).toThrow(/release policy/);
    expect(() =>
      parsePolicy("manualSteps:\n  required: true\n  url: http://example.com\n"),
    ).toThrow(/manualSteps\.url/);
    expect(projectOf("https://github.com", "Acme/Notes")).toBe("github.com/acme/notes");
    expect(projectOf("https://git.example.com/forge/", "acme/notes")).toBe(
      "git.example.com/forge/acme/notes",
    );
  });
});

describe("env check", () => {
  it("finds referenced variables, ignoring escapes and comments", () => {
    const compose = [
      "services:",
      "  api:",
      "    image: ${APP_IMAGE:?set APP_IMAGE}",
      "    environment:",
      "      URL: ${PUBLIC_URL:-http://localhost}",
      "      PLAIN: $PLAIN_VAR",
      "      COST: $$NOT_A_VAR",
      "      # OLD: ${COMMENTED}",
    ].join("\n");
    expect([...composeVariables(compose)].sort()).toEqual(["APP_IMAGE", "PLAIN_VAR", "PUBLIC_URL"]);
    expect([...documentedVariables("A=1\n# B=\nexport C=x\n#  D=2\nnot a line\n")].sort()).toEqual([
      "A",
      "B",
      "C",
      "D",
    ]);
    expect(envCheck([compose], "APP_IMAGE=\n# PUBLIC_URL=\n")).toEqual({
      ok: false,
      missing: ["PLAIN_VAR"],
      referenced: ["APP_IMAGE", "PLAIN_VAR", "PUBLIC_URL"],
    });
  });

  it("derives the smoke env file from the example as written plus the image variables", () => {
    expect(
      smokeEnvFile("# comment\nAPP_IMAGE=old\nOPTIONAL=\n# COMMENTED=x\nDOMAIN=example.com\n", {
        APP_IMAGE: "ghcr.io/x@sha256:a",
      }),
    ).toBe("OPTIONAL=\nDOMAIN=example.com\nAPP_IMAGE=ghcr.io/x@sha256:a\n");
    expect(() => smokeEnvFile("", { "BAD KEY": "x" })).toThrow();
  });
});

describe("cosign", () => {
  const ref = `ghcr.io/acme/notes@${DIGEST_APP}`;

  it("builds sign commands per mode, by digest only", () => {
    expect(signImageArgs(ref, { mode: "keyless" })).toEqual(["cosign", "sign", "--yes", ref]);
    expect(signImageArgs(ref, { mode: "key", key: "cosign.key" })).toEqual([
      "cosign",
      "sign",
      "--yes",
      "--key",
      "cosign.key",
      "--tlog-upload=false",
      ref,
    ]);
    expect(
      signImageArgs(ref, { mode: "key", key: "awskms:///alias/notes", transparencyLog: true }),
    ).toEqual(["cosign", "sign", "--yes", "--key", "awskms:///alias/notes", ref]);
    expect(signImageArgs(ref, { mode: "none" })).toBeNull();
    expect(() => signImageArgs("ghcr.io/acme/notes:1.4.0", { mode: "keyless" })).toThrow(
      /by digest/,
    );
    expect(() => signImageArgs(ref, { mode: "key" })).toThrow(/needs a key/);
    expect(signBlobArgs("release.json", "release.json.sigstore.json", { mode: "keyless" })).toEqual(
      ["cosign", "sign-blob", "--yes", "--bundle", "release.json.sigstore.json", "release.json"],
    );
  });

  it("passes the key password only through the environment", async () => {
    const calls: { argv: readonly string[]; env: Record<string, string> | undefined }[] = [];
    const exec: Exec = async (argv, options) => {
      calls.push({ argv, env: options?.env as Record<string, string> | undefined });
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    await runSigning(exec, signImageArgs(ref, { mode: "key", key: "cosign.key" }), "pw-123456");
    expect(calls[0]?.env).toEqual({ COSIGN_PASSWORD: "pw-123456" });
    expect(calls[0]?.argv.join(" ")).not.toContain("pw-123456");
    await runSigning(exec, null, "pw");
    expect(calls).toHaveLength(1);
    const failing: Exec = async () => ({
      exitCode: 1,
      stdout: "",
      stderr: "error: signing failed",
    });
    await expect(
      runSigning(failing, signImageArgs(ref, { mode: "keyless" }), null),
    ).rejects.toThrow(/signing failed/);
  });

  it("builds verify-blob commands and reads the cosign version", () => {
    expect(
      verifyBlobArgs("release.json", "b.json", {
        mode: "keyless",
        keyless: {
          identity: "https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0",
          issuer: "https://token.actions.githubusercontent.com",
          github: { repository: "acme/notes", ref: "refs/tags/v1.4.0", trigger: "push" },
        },
      }),
    ).toContain("--certificate-github-workflow-ref");
    expect(verifyBlobArgs("r", "b", { mode: "key", publicKey: "k.pub" })).toEqual([
      "cosign",
      "verify-blob",
      "--bundle",
      "b",
      "--key",
      "k.pub",
      "--insecure-ignore-tlog=true",
      "r",
    ]);
    expect(parseCosignVersion('{"gitVersion":"v3.1.3","gitCommit":"x"}')).toBe("3.1.3");
    expect(parseCosignVersion("GitVersion:    v2.4.1\n")).toBe("2.4.1");
    expect(parseCosignVersion("nonsense")).toBeNull();
  });
});

describe("publishing", () => {
  function fakeHost(routes: Record<string, (request: Request) => Response | Promise<Response>>) {
    const requests: { method: string; url: string; headers: Headers; body: string }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      const request = new Request(url, init);
      const body =
        init.body instanceof FormData
          ? "[form]"
          : init.body
            ? Buffer.from(init.body as Uint8Array).toString()
            : "";
      requests.push({ method: request.method, url, headers: request.headers, body });
      const key = `${request.method} ${new URL(url).pathname}`;
      const handler = routes[key];
      if (!handler) {
        return new Response(`no route ${key}`, { status: 599 });
      }
      return handler(request);
    }) as typeof fetch;
    return { requests, fetcher };
  }

  it("github: creates a draft, replaces existing assets, uploads and publishes", async () => {
    const file = path.join(dir, "release.json");
    await fs.writeFile(file, "{}\n");
    const { requests, fetcher } = fakeHost({
      "GET /repos/acme/notes/releases": () =>
        Response.json([
          {
            id: 7,
            tag_name: "v1.4.0",
            draft: true,
            assets: [{ id: 99, name: "release.json" }],
            upload_url:
              "https://uploads.github.com/repos/acme/notes/releases/7/assets{?name,label}",
          },
        ]),
      "DELETE /repos/acme/notes/releases/assets/99": () => new Response(null, { status: 204 }),
      "POST /repos/acme/notes/releases/7/assets": () => Response.json({}, { status: 201 }),
      "PATCH /repos/acme/notes/releases/7": () =>
        Response.json({ html_url: "https://github.com/acme/notes/releases/tag/v1.4.0" }),
    });
    const result = await publishRelease({
      host: "github",
      apiUrl: "https://api.github.com",
      repository: "acme/notes",
      token: "ghs_token",
      tag: "v1.4.0",
      name: "Notes 1.4.0",
      notes: null,
      prerelease: false,
      files: [file],
      publish: true,
      fetch: fetcher,
    });
    expect(result).toEqual({
      url: "https://github.com/acme/notes/releases/tag/v1.4.0",
      uploaded: ["release.json"],
    });
    expect(requests.map((request) => `${request.method} ${request.url}`)).toEqual([
      "GET https://api.github.com/repos/acme/notes/releases?per_page=100",
      "DELETE https://api.github.com/repos/acme/notes/releases/assets/99",
      "POST https://uploads.github.com/repos/acme/notes/releases/7/assets?name=release.json",
      "PATCH https://api.github.com/repos/acme/notes/releases/7",
    ]);
    expect(requests[0]?.headers.get("authorization")).toBe("Bearer ghs_token");
    expect(JSON.parse(requests[3]?.body ?? "{}")).toMatchObject({ draft: false });
  });

  it("refuses to change a published release", async () => {
    const { fetcher } = fakeHost({
      "GET /repos/acme/notes/releases": () =>
        Response.json([{ id: 7, tag_name: "v1.4.0", draft: false }]),
    });
    await expect(
      publishRelease({
        host: "github",
        apiUrl: "https://api.github.com",
        repository: "acme/notes",
        token: "t",
        tag: "v1.4.0",
        name: "x",
        notes: null,
        prerelease: false,
        files: [],
        publish: true,
        fetch: fetcher,
      }),
    ).rejects.toThrow(/already published/);
  });

  it("gitea: creates the draft, uploads attachments as multipart and publishes", async () => {
    const file = path.join(dir, "release.json");
    await fs.writeFile(file, "{}\n");
    const { requests, fetcher } = fakeHost({
      "GET /forge/api/v1/repos/acme/notes/releases": () => Response.json([]),
      "POST /forge/api/v1/repos/acme/notes/releases": () =>
        Response.json({ id: 3, draft: true }, { status: 201 }),
      "POST /forge/api/v1/repos/acme/notes/releases/3/assets": () =>
        Response.json({}, { status: 201 }),
      "PATCH /forge/api/v1/repos/acme/notes/releases/3": () =>
        Response.json({ html_url: "https://git.example.com/forge/acme/notes/releases/tag/v1.4.0" }),
    });
    const result = await publishRelease({
      host: "gitea",
      apiUrl: "https://git.example.com/forge/api/v1",
      repository: "acme/notes",
      token: "tok",
      tag: "v1.4.0",
      name: "1.4.0",
      notes: "notes",
      prerelease: false,
      files: [file],
      publish: true,
      fetch: fetcher,
    });
    expect(result.url).toContain("/releases/tag/v1.4.0");
    expect(requests[1]?.headers.get("authorization")).toBe("token tok");
    expect(requests[2]?.body).toBe("[form]");
  });

  it("gitlab: uploads to the package registry and creates the release with asset links last", async () => {
    const file = path.join(dir, "release.json");
    await fs.writeFile(file, "{}\n");
    const { requests, fetcher } = fakeHost({
      "GET /api/v4/projects/group%2Fnotes/releases/v1.4.0": () =>
        new Response("{}", { status: 404 }),
      "PUT /api/v4/projects/group%2Fnotes/packages/generic/release-assets/v1.4.0/release.json":
        () => Response.json({}, { status: 201 }),
      "POST /api/v4/projects/group%2Fnotes/releases": () =>
        Response.json(
          { _links: { self: "https://gitlab.example.com/group/notes/-/releases/v1.4.0" } },
          { status: 201 },
        ),
    });
    await publishRelease({
      host: "gitlab",
      apiUrl: "https://gitlab.example.com/api/v4",
      repository: "group/notes",
      token: "job",
      tag: "v1.4.0",
      name: "1.4.0",
      notes: null,
      prerelease: false,
      files: [file],
      publish: true,
      jobToken: true,
      fetch: fetcher,
    });
    expect(requests[1]?.headers.get("job-token")).toBe("job");
    const created = JSON.parse(requests[2]?.body ?? "{}");
    expect(created.assets.links[0]).toMatchObject({ name: "release.json", link_type: "other" });
  });
});

describe("tag checks", () => {
  it("require a dated changelog section and matching package versions", () => {
    const changelog = "# Changelog\n\n## [Unreleased]\n\n## [1.0.0] - 2026-11-02\n\n### Added\n";
    expect(
      checkTag({ tag: "v1.0.0", changelog, packageVersions: { "package.json": "1.0.0" } }),
    ).toEqual({ ok: true, version: "1.0.0", problems: [] });
    expect(checkTag({ tag: "v1.0.1", changelog, packageVersions: {} }).problems).toEqual([
      "CHANGELOG.md has no section for 1.0.1.",
    ]);
    expect(
      checkTag({ tag: "v1.0.0", changelog: "## [1.0.0]\n", packageVersions: {} }).problems[0],
    ).toMatch(/no date/);
    expect(
      checkTag({
        tag: "v1.0.0",
        changelog,
        packageVersions: { "packages/sdk/package.json": "0.9.0" },
      }).ok,
    ).toBe(false);
    expect(checkTag({ tag: "1.0.0", changelog, packageVersions: {} }).ok).toBe(false);
  });
});

describe("smoke", () => {
  async function project() {
    await fs.writeFile(
      path.join(dir, "docker-compose.yml"),
      "services:\n  api:\n    image: ${APP_IMAGE}\n",
    );
    await fs.writeFile(path.join(dir, ".env.example"), "APP_IMAGE=\n# DEBUG=\n");
  }

  function world(options: { healthy?: boolean; exits?: boolean; upFails?: boolean } = {}) {
    const calls: string[][] = [];
    let now = 0;
    const exec: Exec = async (argv) => {
      calls.push([...argv]);
      const args = argv.join(" ");
      if (args.includes("config --services"))
        return { exitCode: 0, stdout: "api\ndb\n", stderr: "" } as ExecResult;
      if (args.includes(" up ") && options.upFails)
        return { exitCode: 1, stdout: "", stderr: "pull access denied" };
      if (args.includes("ps -a"))
        return {
          exitCode: 0,
          stdout: options.exits
            ? JSON.stringify({ Service: "api", State: "exited", ExitCode: 1 })
            : "",
          stderr: "",
        };
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const fetcher = (async () =>
      options.healthy === false
        ? new Response("starting", { status: 503 })
        : Response.json({ version: "1.4.0" })) as unknown as typeof fetch;
    return {
      calls,
      deps: {
        exec,
        fetch: fetcher,
        now: () => now,
        sleep: async (ms: number) => {
          now += ms;
        },
        log: () => undefined,
      },
    };
  }

  const options = () => ({
    composeFiles: ["docker-compose.yml"],
    envExample: ".env.example",
    images: { app: { repository: "ghcr.io/acme/notes", digest: DIGEST_APP } },
    imageVars: { app: "APP_IMAGE" },
    healthUrl: "http://localhost:8080/healthz",
    healthVersionPath: "$.version",
    expectVersion: "1.4.0",
    upgradeFrom: null,
    timeoutSeconds: 60,
    cwd: dir,
  });

  it("checks the env, starts by digest without restart policies, waits for the version and tears down", async () => {
    await project();
    const { calls, deps } = world();
    const result = await runSmoke(options(), deps);
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => [step.name, step.ok])).toEqual([
      ["env-check", true],
      ["compose config", true],
      ["start", true],
      ["health", true],
      ["teardown", true],
    ]);
    const up = calls.find((argv) => argv.includes("up"));
    expect(up).toEqual(expect.arrayContaining(["--no-build", "--env-file"]));
    expect(calls.at(-1)).toEqual(expect.arrayContaining(["down", "-v", "--remove-orphans"]));
    expect(result.report).toContain("- Verdict: passed");
    expect(noRestartOverride(["api", "db"])).toBe(
      'services:\n  api:\n    restart: "no"\n  db:\n    restart: "no"\n',
    );
  });

  it("fails on undocumented variables, crashes and timeouts, and still tears down", async () => {
    await project();
    await fs.writeFile(path.join(dir, ".env.example"), "# nothing\n");
    let run = world();
    let result = await runSmoke(options(), run.deps);
    expect(result.ok).toBe(false);
    expect(result.steps[0]).toMatchObject({
      name: "env-check",
      ok: false,
      detail: "not in .env.example: APP_IMAGE",
    });
    expect(run.calls.at(-1)).toContain("down");

    await project();
    run = world({ exits: true, healthy: false });
    result = await runSmoke(options(), run.deps);
    expect(result.steps.find((step) => step.name === "health")?.detail).toMatch(
      /^exited: api \(1\)/,
    );

    run = world({ healthy: false });
    result = await runSmoke(options(), run.deps);
    expect(result.steps.find((step) => step.name === "health")?.detail).toMatch(
      /not healthy within 60 s/,
    );
    expect(result.steps.at(-1)?.name).toBe("teardown");
  });

  it("upgrades from the previous release by recreating with the new digests", async () => {
    await project();
    const { calls, deps } = world();
    const result = await runSmoke(
      {
        ...options(),
        healthVersionPath: null,
        upgradeFrom: {
          version: "1.3.0",
          images: { app: { repository: "ghcr.io/acme/notes", digest: DIGEST_WEB } },
        },
      },
      deps,
    );
    expect(result.steps.map((step) => step.name)).toEqual([
      "env-check",
      "compose config",
      "start 1.3.0",
      "health",
      "upgrade",
      "health after upgrade",
      "teardown",
    ]);
    expect(calls.filter((argv) => argv.includes("up"))).toHaveLength(2);
  });

  it("prepares the upgrade through the sidecar with a file feed and trust mode none", async () => {
    await project();
    await fs.writeFile(
      path.join(dir, "updater.yaml"),
      "version: 1\ncompose:\n  projectDir: /opt/notes\nrelease:\n  feed: { type: github, url: https://github.com/acme/notes }\ntrust:\n  keyless:\n    github: { repository: acme/notes, workflow: .github/workflows/release.yml }\nservices:\n  - { name: api, image: app, imageVar: APP_IMAGE }\n",
    );
    const work = path.join(dir, "work");
    await fs.mkdir(work);
    const plan = await sidecarUpgradePlan({
      options: {
        ...options(),
        updater: { configFile: "updater.yaml", image: "ghcr.io/restow-backup/cicd-updater:1.0.0" },
      },
      updater: { configFile: "updater.yaml", image: "ghcr.io/restow-backup/cicd-updater:1.0.0" },
      work,
      project: "cicd-updater-smoke-abc",
      envFile: path.join(dir, ".cicd-updater-smoke.env"),
    });
    const config = parse(await fs.readFile(plan.configFile, "utf8"));
    expect(config.trust).toEqual({
      mode: "none",
      none: { acknowledgeUnsigned: true },
      verifier: { isolate: false },
    });
    expect(config.release.feed).toEqual({ type: "file", path: "/smoke-feed" });
    expect(config.compose).toMatchObject({
      projectDir: dir,
      projectName: "cicd-updater-smoke-abc",
      envFile: ".cicd-updater-smoke.env",
    });
    const document = await fs.readFile(path.join(plan.feedDir, "release.json"));
    expect(parseReleaseDocument(document)).toMatchObject({ ok: true });
    const override = parse(plan.override("services: {}\n"));
    expect(override.services.updater.volumes).toContain(
      "/var/run/docker.sock:/var/run/docker.sock",
    );
    expect(override.services.updater.profiles).toEqual(["updater"]);
  });
});

describe("release CLI", () => {
  const io = () => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      io: { out: (line: string) => out.push(line), err: (line: string) => err.push(line) },
    };
  };
  const exec: Exec = async (argv) =>
    argv[1] === "version"
      ? { exitCode: 0, stdout: '{"gitVersion":"v3.1.3"}', stderr: "" }
      : { exitCode: 0, stdout: "", stderr: "" };

  it("creates and validates release.json and writes GitHub outputs", async () => {
    const output = path.join(dir, "github-output");
    const target = path.join(dir, "release.json");
    const streams = io();
    const code = await runReleaseCli(
      [
        "json",
        "create",
        "--images",
        JSON.stringify(IMAGES),
        "--version",
        "1.4.0",
        "--tag",
        "v1.4.0",
        "--policy-file",
        path.join(dir, "absent.yaml"),
        "--out",
        target,
      ],
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "acme/notes",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_OUTPUT: output,
        },
        io: streams.io,
        exec,
        fetch,
        now: () => new Date("2026-11-02T18:00:00Z"),
      },
    );
    expect(code).toBe(1);
    expect(streams.err[0]).toMatch(/absent\.yaml cannot be read/);
    const ok = await runReleaseCli(
      [
        "json",
        "create",
        "--images",
        JSON.stringify(IMAGES),
        "--version",
        "1.4.0",
        "--tag",
        "v1.4.0",
        "--out",
        target,
      ],
      {
        env: {
          GITHUB_ACTIONS: "true",
          GITHUB_SERVER_URL: "https://github.com",
          GITHUB_REPOSITORY: "acme/notes",
          GITHUB_SHA: "a".repeat(40),
          GITHUB_OUTPUT: output,
        },
        io: io().io,
        exec,
        fetch,
        now: () => new Date("2026-11-02T18:00:00Z"),
      },
    );
    expect(ok).toBe(0);
    const document = JSON.parse(await fs.readFile(target, "utf8"));
    expect(document).toMatchObject({
      project: "github.com/acme/notes",
      commit: "a".repeat(40),
      signing: { mode: "keyless", toolVersion: "3.1.3" },
    });
    expect(await fs.readFile(output, "utf8")).toMatch(/^path=.+\nsha256=[0-9a-f]{64}\n$/);
    const validate = io();
    expect(
      await runReleaseCli(["json", "validate", "--file", target, "--tag", "v1.4.0"], {
        env: {},
        io: validate.io,
        exec,
        fetch,
        now: () => new Date(),
      }),
    ).toBe(0);
    expect(
      await runReleaseCli(["json", "validate", "--file", target, "--tag", "v1.4.1"], {
        env: {},
        io: io().io,
        exec,
        fetch,
        now: () => new Date(),
      }),
    ).toBe(1);
  });

  it("requires an explicit signing mode outside GitHub Actions and GitLab CI, and flags usage errors", async () => {
    const streams = io();
    expect(
      await runReleaseCli(["sign-images", "--images", JSON.stringify(IMAGES)], {
        env: {},
        io: streams.io,
        exec,
        fetch,
        now: () => new Date(),
      }),
    ).toBe(2);
    expect(streams.err[0]).toMatch(/--signing must be/);
    expect(
      await runReleaseCli(["frobnicate"], {
        env: {},
        io: io().io,
        exec,
        fetch,
        now: () => new Date(),
      }),
    ).toBe(2);
    expect(
      await runReleaseCli(["json", "create", "--bogus"], {
        env: {},
        io: io().io,
        exec,
        fetch,
        now: () => new Date(),
      }),
    ).toBe(2);
    const none = io();
    expect(
      await runReleaseCli(
        ["sign-images", "--images", JSON.stringify(IMAGES), "--signing", "none"],
        { env: {}, io: none.io, exec, fetch, now: () => new Date() },
      ),
    ).toBe(0);
    expect(none.out[0]).toBe("signing none: nothing was signed");
  });
});

describe("indexes and versions", () => {
  const AMD = `sha256:${"a".repeat(64)}`;
  const ARM = `sha256:${"b".repeat(64)}`;
  const INDEX = `sha256:${"c".repeat(64)}`;
  const indexBody = (digests: string[]) =>
    JSON.stringify({
      mediaType: "application/vnd.oci.image.index.v1+json",
      manifests: [
        ...digests.map((digest, i) => ({
          digest,
          platform: { os: "linux", architecture: i === 0 ? "amd64" : "arm64" },
        })),
        {
          digest: `sha256:${"d".repeat(64)}`,
          platform: { os: "unknown", architecture: "unknown" },
        },
      ],
    });
  const registry = (existing: string | null) => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push([...argv]);
      const args = argv.slice(3);
      if (args[0] === "inspect" && args[1] === "--raw") {
        if (args[2]?.endsWith(":1.4.0")) {
          return existing === null
            ? { exitCode: 1, stdout: "", stderr: "ERROR: ghcr.io/acme/notes:1.4.0: not found" }
            : { exitCode: 0, stdout: existing, stderr: "" };
        }
        if (args[2]?.endsWith(INDEX)) {
          return { exitCode: 0, stdout: indexBody([AMD, ARM]), stderr: "" };
        }
        const manifest = { mediaType: "application/vnd.oci.image.manifest.v1+json", layers: [] };
        return { exitCode: 0, stdout: JSON.stringify(manifest), stderr: "" };
      }
      if (args[0] === "inspect") {
        return { exitCode: 0, stdout: JSON.stringify({ digest: INDEX }), stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    return { exec, calls };
  };
  const images = { app: { repository: "ghcr.io/acme/notes", digests: [ARM, AMD] } };

  it("creates one tagged index per image from the platform digests", async () => {
    const { exec, calls } = registry(null);
    const published = await createIndexes(exec, { images, tag: "1.4.0", extraTags: ["1"] });
    expect(published).toEqual({
      app: {
        repository: "ghcr.io/acme/notes",
        tag: "1.4.0",
        digest: INDEX,
        platforms: ["linux/amd64", "linux/arm64"],
      },
    });
    expect(calls).toContainEqual([
      "docker",
      "buildx",
      "imagetools",
      "create",
      "--tag",
      "ghcr.io/acme/notes:1.4.0",
      "--tag",
      "ghcr.io/acme/notes:1",
      `ghcr.io/acme/notes@${AMD}`,
      `ghcr.io/acme/notes@${ARM}`,
    ]);
  });

  it("refuses a version tag with other content and accepts a re-run with the same images", async () => {
    const other = registry(indexBody([`sha256:${"e".repeat(64)}`, ARM]));
    await expect(createIndexes(other.exec, { images, tag: "1.4.0" })).rejects.toThrow(
      /already exists with other content/,
    );
    expect(other.calls.some((call) => call[3] === "create")).toBe(false);
    const same = registry(indexBody([AMD, ARM]));
    await expect(createIndexes(same.exec, { images, tag: "1.4.0" })).resolves.toMatchObject({
      app: { digest: INDEX },
    });
    await expect(createIndexes(same.exec, { images, tag: "1.4.0; rm" })).rejects.toThrow(
      /not a valid image tag/,
    );
    expect(indexEntries(JSON.parse(indexBody([AMD])))).toEqual([
      { digest: AMD, platform: "linux/amd64" },
    ]);
  });

  it("derives the version from a tag and writes outputs", async () => {
    const output = path.join(dir, "out");
    const deps = (env: Record<string, string>) => ({
      env,
      io: { out: () => {}, err: () => {} },
      exec: registry(null).exec,
      fetch,
      now: () => new Date(),
    });
    expect(
      await runReleaseCli(["version", "--tag", "v1.5.0-rc.1"], deps({ GITHUB_OUTPUT: output })),
    ).toBe(0);
    expect(await fs.readFile(output, "utf8")).toBe(
      "version=1.5.0-rc.1\nprerelease=true\nchannel=beta\n",
    );
    expect(
      await runReleaseCli(
        ["version", "--tag", "release-2.0.0", "--tag-pattern", "release-{version}"],
        deps({}),
      ),
    ).toBe(0);
    expect(await runReleaseCli(["version", "--tag", "main"], deps({}))).toBe(1);
    const indexOutput = path.join(dir, "index-out");
    expect(
      await runReleaseCli(
        ["index", "--images", JSON.stringify(images), "--version", "1.4.0"],
        deps({ GITHUB_OUTPUT: indexOutput }),
      ),
    ).toBe(0);
    expect(await fs.readFile(indexOutput, "utf8")).toMatch(/^images=\{"app":\{"repository"/);
    expect(
      await runReleaseCli(
        ["index", "--images", JSON.stringify(images), "--version", "v1.4.0"],
        deps({}),
      ),
    ).toBe(2);
  });
});

describe("build", () => {
  it("builds by digest with the OCI labels and without attestations", async () => {
    const calls: string[][] = [];
    const exec: Exec = async (argv) => {
      calls.push([...argv]);
      const metadata = argv[argv.indexOf("--metadata-file") + 1] as string;
      await fs.writeFile(
        metadata,
        JSON.stringify({ "containerimage.digest": `sha256:${"f".repeat(64)}` }),
      );
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const built = await buildImages(exec, {
      images: {
        app: {
          repository: "ghcr.io/acme/notes",
          file: "docker/app.Dockerfile",
          target: "runtime",
          buildArgs: { APP_VERSION: "{version}" },
        },
      },
      platforms: ["linux/amd64", "linux/arm64"],
      version: "1.4.0",
      revision: "a".repeat(40),
      source: "https://github.com/acme/notes",
      created: "2026-11-02T18:00:00Z",
      push: true,
      workDir: dir,
    });
    expect(built).toEqual({
      app: { repository: "ghcr.io/acme/notes", digests: [`sha256:${"f".repeat(64)}`] },
    });
    expect(calls[0]).toEqual([
      "docker",
      "buildx",
      "build",
      "--platform",
      "linux/amd64,linux/arm64",
      "--file",
      "docker/app.Dockerfile",
      "--target",
      "runtime",
      "--build-arg",
      "APP_VERSION=1.4.0",
      "--label",
      "org.opencontainers.image.version=1.4.0",
      "--label",
      `org.opencontainers.image.revision=${"a".repeat(40)}`,
      "--label",
      "org.opencontainers.image.source=https://github.com/acme/notes",
      "--label",
      "org.opencontainers.image.created=2026-11-02T18:00:00Z",
      "--provenance=false",
      "--sbom=false",
      "--output",
      "type=image,name=ghcr.io/acme/notes,push-by-digest=true,name-canonical=true,push=true",
      "--metadata-file",
      path.join(dir, "build-app.json"),
      ".",
    ]);
    expect(ociLabels({ version: "1.0.0", revision: null, source: null, created: null })).toEqual([
      "--label",
      "org.opencontainers.image.version=1.0.0",
    ]);
  });

  it("refuses other platforms, versions with a v and paths outside the repository", async () => {
    const exec: Exec = async () => ({ exitCode: 0, stdout: "", stderr: "" });
    const base = {
      revision: null,
      source: null,
      created: null,
      push: false,
      workDir: dir,
    };
    const images = { app: { repository: "ghcr.io/acme/notes" } };
    await expect(
      buildImages(exec, { ...base, images, platforms: ["linux/s390x"], version: "1.0.0" }),
    ).rejects.toThrow(/not supported/);
    await expect(
      buildImages(exec, { ...base, images, platforms: ["linux/amd64"], version: "v1.0.0" }),
    ).rejects.toThrow(/plain version/);
    await expect(
      buildImages(exec, {
        ...base,
        images: { app: { repository: "ghcr.io/acme/notes", context: "../other" } },
        platforms: ["linux/amd64"],
        version: "1.0.0",
      }),
    ).rejects.toThrow(/relative path/);
  });
});

describe("sbom", () => {
  it("scans each platform image and attests it signed like the image", async () => {
    const AMD = `sha256:${"a".repeat(64)}`;
    const ARM = `sha256:${"b".repeat(64)}`;
    const calls: { argv: string[]; env: Record<string, string> | undefined }[] = [];
    const exec: Exec = async (argv, options) => {
      calls.push({ argv: [...argv], env: options?.env as Record<string, string> | undefined });
      if (argv[1] === "buildx") {
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            manifests: [
              { digest: AMD, platform: { os: "linux", architecture: "amd64" } },
              { digest: ARM, platform: { os: "linux", architecture: "arm64" } },
              {
                digest: `sha256:${"c".repeat(64)}`,
                platform: { os: "unknown", architecture: "unknown" },
              },
            ],
          }),
          stderr: "",
        };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const files = await generateSboms(
      exec,
      { app: IMAGES.app },
      {
        mode: "key",
        key: "cosign.key",
        password: "secret-password",
        outDir: dir,
      },
    );
    expect(files).toEqual([
      path.join(dir, "app-1.4.0-linux-amd64.spdx.json"),
      path.join(dir, "app-1.4.0-linux-arm64.spdx.json"),
    ]);
    const attest = calls.find((call) => call.argv[1] === "attest");
    expect(attest?.argv).toEqual([
      "cosign",
      "attest",
      "--yes",
      "--key",
      "cosign.key",
      "--tlog-upload=false",
      "--type",
      "spdxjson",
      "--predicate",
      path.join(dir, "app-1.4.0-linux-amd64.spdx.json"),
      `ghcr.io/acme/notes@${AMD}`,
    ]);
    expect(attest?.env).toEqual({ COSIGN_PASSWORD: "secret-password" });
    expect(calls.every((call) => !call.argv.includes("secret-password"))).toBe(true);
    calls.length = 0;
    await generateSboms(exec, { app: IMAGES.app }, { mode: "none", password: null, outDir: dir });
    expect(calls.filter((call) => call.argv[0] === "syft")).toHaveLength(2);
    expect(calls.some((call) => call.argv[1] === "attest")).toBe(false);
    expect(() => attestSbomArgs("ghcr.io/acme/notes:1.4.0", "x.json", { mode: "keyless" })).toThrow(
      /by digest/,
    );
  });
});

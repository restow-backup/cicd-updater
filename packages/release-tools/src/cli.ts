import { appendFileSync } from "node:fs";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { parseArgs } from "node:util";
import { FeedReader, type RemoteFeedType } from "@cicd-updater/feed";
import {
  channelOf,
  compareVersions,
  isPlainVersion,
  isValidTagPattern,
  keylessIdentity,
  parseReleaseDocument,
  type TrustMode,
  versionFromTag,
} from "@cicd-updater/protocol";
import { buildImages } from "./build.js";
import { checkTag } from "./changelog.js";
import {
  parseCosignVersion,
  runSigning,
  signBlobArgs,
  signImageArgs,
  verifyBlobArgs,
} from "./cosign.js";
import {
  createReleaseDocument,
  DEFAULT_POLICY_FILE,
  parsePolicy,
  projectOf,
  publishedImagesSchema,
  serializeReleaseDocument,
  validateReleaseBytes,
} from "./document.js";
import { envCheck } from "./env-check.js";
import { exec as defaultExec, type Exec, expectOk } from "./exec.js";
import { builtImagesSchema, createIndexes } from "./images.js";
import { publishRelease, type ReleaseHostType } from "./publish.js";
import { generateSboms } from "./sbom.js";
import { runSmoke, type SmokeImage } from "./smoke.js";

/**
 * `cicd-updater release <command>` (design 10.6): the release-side functions
 * for any CI. The composite actions under `actions/` call the same code
 * (bundled as `actions/lib/release-tools.mjs`). Exit codes: 0 success,
 * 1 failed, 2 usage error.
 */

export interface ReleaseIo {
  out(line: string): void;
  err(line: string): void;
}

export interface ReleaseCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  io: ReleaseIo;
  exec: Exec;
  fetch: typeof fetch;
  now: () => Date;
}

export const RELEASE_USAGE = `Usage: cicd-updater release <command> [flags]

  env-check   --compose-files a.yml,b.yml [--env-example .env.example]
  json create --images <json|@file> --version V --tag T [--policy-file F] [--notes-url U]
              [--signing keyless|key|none] [--project host/owner/repo] [--commit SHA] [--out release.json]
              [--tag-pattern v{version}]
  json validate --file release.json [--tag T]
  json sign   --file release.json [--bundle release.json.sigstore.json] --signing keyless|key|none
              [--key K] [--transparency-log]   (password: COSIGN_PASSWORD)
  json verify --file release.json [--bundle B] (--github-repository R --workflow W | --public-key P)
  sign-images --images <json|@file> --signing keyless|key|none [--key K] [--transparency-log]
  sbom        --images <json|@file> --signing keyless|key|none [--key K] [--transparency-log]
              [--out-dir sbom]   (syft per platform image; attested unless signing is none)
  upload      --host github|gitea|gitlab --api-url U --repository R --tag T --files a,b
              [--name N] [--notes-file F] [--prerelease] [--draft]   (token: RELEASE_TOKEN or GITHUB_TOKEN)
  smoke       --compose-files a.yml --images <json> --image-vars <json> --health-url U
              [--env-example .env.example] [--health-version-path P] [--expect-version V]
              [--upgrade-from previous|none|V --feed-type T --feed-url U] [--updater-config F --updater-image I]
              [--timeout-seconds 600] [--report report.md]
  check-tag   --tag vX.Y.Z [--changelog CHANGELOG.md] [--package package.json ...]
  build       --images <json|@file> --version V [--platforms linux/amd64,linux/arm64] [--no-push]
              [--cache-from X] [--cache-to Y]
              (images: {key: {repository, context, file, target, buildArgs}}; pushes by digest,
              untagged; prints images for index and smoke-images for smoke)
  version     --tag T [--tag-pattern v{version}]      (version, prerelease, channel of a tag)
  index       --images <json|@file> --version V [--extra-tags a,b] [--allow-existing]
              (images: {key: {repository, digests: [per-platform digests]}}; prints the
              published images JSON for json create and sign-images)

Flags for every command: --github-output <file> (write outputs for GitHub/Forgejo Actions)`;

async function readJsonArg(value: string): Promise<unknown> {
  return JSON.parse(value.startsWith("@") ? await fs.readFile(value.slice(1), "utf8") : value);
}

function list(value: string | undefined): string[] {
  return (value ?? "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function trustMode(value: string | undefined, env: ReleaseCliDeps["env"]): TrustMode {
  const mode =
    value ?? (env.GITHUB_ACTIONS === "true" || env.GITLAB_CI === "true" ? "keyless" : undefined);
  if (mode !== "keyless" && mode !== "key" && mode !== "none") {
    throw new UsageError(
      "--signing must be keyless, key or none (there is no default outside GitHub Actions and GitLab CI)",
    );
  }
  return mode;
}

class UsageError extends Error {}

function output(
  deps: ReleaseCliDeps,
  file: string | undefined,
  values: Record<string, string>,
): void {
  for (const [key, value] of Object.entries(values)) {
    deps.io.out(`${key}=${value}`);
  }
  const target = file ?? deps.env.GITHUB_OUTPUT;
  if (target) {
    for (const [key, value] of Object.entries(values)) {
      appendFileSync(
        target,
        value.includes("\n")
          ? `${key}<<__CICD_UPDATER__\n${value}\n__CICD_UPDATER__\n`
          : `${key}=${value}\n`,
      );
    }
  }
}

export async function runReleaseCli(
  argv: readonly string[],
  deps: ReleaseCliDeps,
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "help") {
    deps.io.out(RELEASE_USAGE);
    return command ? 0 : 2;
  }
  let parsed: ReturnType<typeof parseArgs>;
  try {
    parsed = parseArgs({
      args: [...rest],
      allowPositionals: true,
      options: {
        "compose-files": { type: "string" },
        "env-example": { type: "string" },
        images: { type: "string" },
        "image-vars": { type: "string" },
        version: { type: "string" },
        tag: { type: "string" },
        "policy-file": { type: "string" },
        "notes-url": { type: "string" },
        signing: { type: "string" },
        project: { type: "string" },
        commit: { type: "string" },
        out: { type: "string" },
        file: { type: "string" },
        bundle: { type: "string" },
        key: { type: "string" },
        "transparency-log": { type: "boolean", default: false },
        "github-repository": { type: "string" },
        workflow: { type: "string" },
        "public-key": { type: "string" },
        host: { type: "string" },
        "api-url": { type: "string" },
        repository: { type: "string" },
        files: { type: "string" },
        name: { type: "string" },
        "notes-file": { type: "string" },
        prerelease: { type: "boolean", default: false },
        draft: { type: "boolean", default: false },
        "health-url": { type: "string" },
        "health-version-path": { type: "string" },
        "expect-version": { type: "string" },
        "upgrade-from": { type: "string" },
        "feed-type": { type: "string" },
        "feed-url": { type: "string" },
        "updater-config": { type: "string" },
        "updater-image": { type: "string" },
        "timeout-seconds": { type: "string" },
        report: { type: "string" },
        changelog: { type: "string" },
        package: { type: "string", multiple: true },
        "github-output": { type: "string" },
        "tag-pattern": { type: "string" },
        "extra-tags": { type: "string" },
        platforms: { type: "string" },
        "out-dir": { type: "string" },
        "no-push": { type: "boolean", default: false },
        "cache-from": { type: "string" },
        "cache-to": { type: "string" },
        "allow-existing": { type: "boolean", default: false },
      },
    });
  } catch (error) {
    deps.io.err((error as Error).message);
    deps.io.err(RELEASE_USAGE);
    return 2;
  }
  const flags = parsed.values as Record<string, string | boolean | string[] | undefined>;
  const str = (name: string): string | undefined =>
    typeof flags[name] === "string" ? (flags[name] as string) : undefined;
  const need = (name: string): string => {
    const value = str(name);
    if (!value) {
      throw new UsageError(`--${name} is required`);
    }
    return value;
  };
  const sub = parsed.positionals[0];
  const githubOutput = str("github-output");
  try {
    switch (command) {
      case "env-check": {
        const files = list(need("compose-files"));
        const example = await fs.readFile(str("env-example") ?? ".env.example", "utf8");
        const result = envCheck(
          await Promise.all(files.map((file) => fs.readFile(file, "utf8"))),
          example,
        );
        if (!result.ok) {
          deps.io.err(
            `Not documented in ${str("env-example") ?? ".env.example"}: ${result.missing.join(", ")}`,
          );
          return 1;
        }
        deps.io.out(`All ${result.referenced.length} variables are documented.`);
        return 0;
      }
      case "json": {
        if (sub === "create") {
          const images = publishedImagesSchema.parse(await readJsonArg(need("images")));
          const policyFile = str("policy-file") ?? DEFAULT_POLICY_FILE;
          const policyText = await fs.readFile(policyFile, "utf8").catch(() => null);
          if (policyText === null && str("policy-file")) {
            throw new Error(`${policyFile} cannot be read`);
          }
          const serverUrl = deps.env.GITHUB_SERVER_URL ?? deps.env.CI_SERVER_URL;
          const repository = deps.env.GITHUB_REPOSITORY ?? deps.env.CI_PROJECT_PATH;
          const project =
            str("project") ??
            (serverUrl && repository ? projectOf(serverUrl, repository) : undefined);
          if (!project) {
            throw new UsageError(
              "--project is required outside GitHub/Forgejo Actions and GitLab CI",
            );
          }
          const mode = trustMode(str("signing"), deps.env);
          let toolVersion: string | null = null;
          if (mode !== "none") {
            const version = await deps.exec(["cosign", "version", "--json"]);
            toolVersion = version.exitCode === 0 ? parseCosignVersion(version.stdout) : null;
          }
          const document = createReleaseDocument({
            images,
            version: need("version"),
            tag: need("tag"),
            project,
            commit: str("commit") ?? deps.env.GITHUB_SHA ?? deps.env.CI_COMMIT_SHA ?? null,
            createdAt: deps.now(),
            notesUrl: str("notes-url") ?? null,
            policy: parsePolicy(policyText),
            signing: { mode, toolVersion },
            tagPattern: str("tag-pattern") ?? "v{version}",
          });
          const out = str("out") ?? "release.json";
          await fs.writeFile(out, serializeReleaseDocument(document));
          const sha = (await import("node:crypto"))
            .createHash("sha256")
            .update(serializeReleaseDocument(document))
            .digest("hex");
          output(deps, githubOutput, { path: out, sha256: sha });
          return 0;
        }
        if (sub === "validate") {
          const bytes = await fs.readFile(need("file"));
          const result = validateReleaseBytes(bytes, str("tag") ? { gitTag: str("tag") } : {});
          if (!result.ok) {
            deps.io.err(`${result.code}: ${result.detail}`);
            return 1;
          }
          deps.io.out(
            `valid: ${result.document.project} ${result.document.version} (${Object.keys(result.document.images).join(", ")})`,
          );
          return 0;
        }
        if (sub === "sign") {
          const file = need("file");
          const bundle = str("bundle") ?? `${file}.sigstore.json`;
          const mode = trustMode(str("signing"), deps.env);
          await runSigning(
            deps.exec,
            signBlobArgs(file, bundle, {
              mode,
              key: str("key") ?? null,
              transparencyLog: flags["transparency-log"] === true,
            }),
            deps.env.COSIGN_PASSWORD ?? null,
          );
          output(deps, githubOutput, { bundle: mode === "none" ? "" : bundle });
          return 0;
        }
        if (sub === "verify") {
          const file = need("file");
          const bundle = str("bundle") ?? `${file}.sigstore.json`;
          const parsedDoc = parseReleaseDocument(await fs.readFile(file));
          if (!parsedDoc.ok) {
            deps.io.err(`${parsedDoc.code}: ${parsedDoc.detail}`);
            return 1;
          }
          const tag = parsedDoc.document.tag;
          const args = str("public-key")
            ? verifyBlobArgs(file, bundle, {
                mode: "key",
                publicKey: need("public-key"),
                transparencyLog: flags["transparency-log"] === true,
              })
            : verifyBlobArgs(file, bundle, {
                mode: "keyless",
                keyless: keylessIdentity(
                  {
                    github: {
                      repository: need("github-repository"),
                      workflow: str("workflow") ?? ".github/workflows/release.yml",
                    },
                  },
                  tag,
                  parsedDoc.document.version,
                ),
              });
          expectOk(await deps.exec(args as [string, ...string[]]), "cosign verify-blob");
          deps.io.out(`verified: ${file}`);
          return 0;
        }
        throw new UsageError("json create|validate|sign|verify");
      }
      case "sign-images": {
        const images = publishedImagesSchema.parse(await readJsonArg(need("images")));
        const mode = trustMode(str("signing"), deps.env);
        for (const image of Object.values(images)) {
          await runSigning(
            deps.exec,
            signImageArgs(`${image.repository}@${image.digest}`, {
              mode,
              key: str("key") ?? null,
              transparencyLog: flags["transparency-log"] === true,
            }),
            deps.env.COSIGN_PASSWORD ?? null,
          );
        }
        deps.io.out(
          mode === "none"
            ? "signing none: nothing was signed"
            : `signed ${Object.keys(images).length} images (${mode})`,
        );
        return 0;
      }
      case "sbom": {
        const images = publishedImagesSchema.parse(await readJsonArg(need("images")));
        const mode = trustMode(str("signing"), deps.env);
        const files = await generateSboms(deps.exec, images, {
          mode,
          key: str("key") ?? null,
          transparencyLog: flags["transparency-log"] === true,
          password: deps.env.COSIGN_PASSWORD ?? null,
          outDir: str("out-dir") ?? "sbom",
        });
        output(deps, githubOutput, { files: files.join("\n") });
        return 0;
      }
      case "upload": {
        const host = need("host") as ReleaseHostType;
        if (!["github", "gitea", "gitlab"].includes(host)) {
          throw new UsageError("--host must be github, gitea or gitlab");
        }
        const token = deps.env.RELEASE_TOKEN ?? deps.env.GITHUB_TOKEN ?? deps.env.CI_JOB_TOKEN;
        if (!token) {
          throw new UsageError("RELEASE_TOKEN (or GITHUB_TOKEN, CI_JOB_TOKEN) is required");
        }
        const notesFile = str("notes-file");
        const result = await publishRelease({
          host,
          apiUrl:
            str("api-url") ??
            (host === "github"
              ? (deps.env.GITHUB_API_URL ?? "https://api.github.com")
              : need("api-url")),
          repository: need("repository"),
          token,
          tag: need("tag"),
          name: str("name") ?? need("tag"),
          notes: notesFile ? await fs.readFile(notesFile, "utf8") : null,
          prerelease: flags.prerelease === true,
          files: list(need("files")),
          publish: flags.draft !== true,
          jobToken:
            !deps.env.RELEASE_TOKEN && !deps.env.GITHUB_TOKEN && Boolean(deps.env.CI_JOB_TOKEN),
          fetch: deps.fetch,
        });
        output(deps, githubOutput, { url: result.url ?? "", uploaded: result.uploaded.join(",") });
        return 0;
      }
      case "smoke": {
        const images = (await readJsonArg(need("images"))) as Record<string, SmokeImage>;
        const imageVars = (await readJsonArg(need("image-vars"))) as Record<string, string>;
        const expectVersion = str("expect-version") ?? null;
        let upgradeFrom: { version: string; images: Record<string, SmokeImage> } | null = null;
        const from = str("upgrade-from") ?? "none";
        if (from !== "none") {
          upgradeFrom = await previousRelease(
            from,
            expectVersion,
            str("feed-type"),
            str("feed-url"),
            deps,
          );
          if (!upgradeFrom) {
            deps.io.out("upgrade-from: no earlier release, the upgrade test is skipped");
          }
        }
        const result = await runSmoke(
          {
            composeFiles: list(need("compose-files")),
            envExample: str("env-example") ?? ".env.example",
            images,
            imageVars,
            healthUrl: need("health-url"),
            healthVersionPath: str("health-version-path") ?? null,
            expectVersion,
            upgradeFrom,
            timeoutSeconds: Number(str("timeout-seconds") ?? "600"),
            cwd: process.cwd(),
            updater: str("updater-config")
              ? { configFile: need("updater-config"), image: need("updater-image") }
              : null,
          },
          {
            exec: deps.exec,
            fetch: deps.fetch,
            now: () => deps.now().getTime(),
            sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
            log: deps.io.out,
          },
        );
        const report = str("report") ?? "smoke-report.md";
        await fs.writeFile(report, result.report);
        output(deps, githubOutput, { report });
        return result.ok ? 0 : 1;
      }
      case "check-tag": {
        const packages: Record<string, string> = {};
        for (const file of (flags.package as string[] | undefined) ?? []) {
          packages[file] = String(
            (JSON.parse(await fs.readFile(file, "utf8")) as { version?: unknown }).version,
          );
        }
        const result = checkTag({
          tag: need("tag"),
          changelog: await fs.readFile(str("changelog") ?? "CHANGELOG.md", "utf8"),
          packageVersions: packages,
        });
        for (const problem of result.problems) {
          deps.io.err(problem);
        }
        if (result.ok) {
          output(deps, githubOutput, {
            version: result.version as string,
            prerelease: String((result.version as string).includes("-")),
            channel: (result.version as string).includes("-") ? "beta" : "stable",
          });
        }
        return result.ok ? 0 : 1;
      }
      case "version": {
        const tag = need("tag");
        const pattern = str("tag-pattern") ?? "v{version}";
        if (!isValidTagPattern(pattern)) {
          throw new UsageError("--tag-pattern must contain {version} exactly once");
        }
        const version = versionFromTag(pattern, tag);
        if (!version || !isPlainVersion(version)) {
          deps.io.err(`${tag} is not a release tag of the pattern ${pattern}.`);
          return 1;
        }
        output(deps, githubOutput, {
          version,
          prerelease: String(version.includes("-")),
          channel: channelOf(version),
        });
        return 0;
      }
      case "build": {
        const version = need("version");
        const created = await deps.exec(["git", "log", "-1", "--format=%cI"]);
        const serverUrl = deps.env.GITHUB_SERVER_URL;
        const repository = deps.env.GITHUB_REPOSITORY;
        const built = await buildImages(deps.exec, {
          images: (await readJsonArg(need("images"))) as Record<string, never>,
          platforms: list(str("platforms") ?? "linux/amd64,linux/arm64"),
          version,
          revision: deps.env.GITHUB_SHA ?? deps.env.CI_COMMIT_SHA ?? null,
          source:
            serverUrl && repository
              ? `${serverUrl}/${repository}`
              : (deps.env.CI_PROJECT_URL ?? null),
          created:
            created.exitCode === 0 && created.stdout.trim()
              ? created.stdout.trim()
              : deps.now().toISOString(),
          push: flags["no-push"] !== true,
          cacheFrom: list(str("cache-from")),
          cacheTo: list(str("cache-to")),
          workDir: deps.env.RUNNER_TEMP ?? (await fs.mkdtemp(`${tmpdir()}/cicd-updater-build-`)),
        });
        output(deps, githubOutput, {
          images: JSON.stringify(built),
          "smoke-images": JSON.stringify(
            Object.fromEntries(
              Object.entries(built).map(([key, image]) => [
                key,
                { repository: image.repository, digest: image.digests[0] },
              ]),
            ),
          ),
        });
        return 0;
      }
      case "index": {
        const images = builtImagesSchema.parse(await readJsonArg(need("images")));
        const version = need("version");
        if (!isPlainVersion(version)) {
          throw new UsageError("--version must be a plain version such as 1.4.0");
        }
        const published = await createIndexes(deps.exec, {
          images,
          tag: version,
          extraTags: list(str("extra-tags")),
          refuseExisting: flags["allow-existing"] !== true,
        });
        output(deps, githubOutput, { images: JSON.stringify(published) });
        return 0;
      }
      default:
        throw new UsageError(`unknown command ${command}`);
    }
  } catch (error) {
    if (error instanceof UsageError) {
      deps.io.err(error.message);
      deps.io.err(RELEASE_USAGE);
      return 2;
    }
    deps.io.err((error as Error).message);
    return 1;
  }
}

/** The images of the release to upgrade from: `previous` (newest earlier release) or a version. */
async function previousRelease(
  from: string,
  current: string | null,
  feedType: string | undefined,
  feedUrl: string | undefined,
  deps: ReleaseCliDeps,
): Promise<{ version: string; images: Record<string, SmokeImage> } | null> {
  const type = (feedType ?? (deps.env.GITHUB_REPOSITORY ? "github" : undefined)) as
    | RemoteFeedType
    | undefined;
  const url =
    feedUrl ??
    (deps.env.GITHUB_SERVER_URL && deps.env.GITHUB_REPOSITORY
      ? `${deps.env.GITHUB_SERVER_URL}/${deps.env.GITHUB_REPOSITORY}`
      : undefined);
  if (!type || !url) {
    throw new UsageError("--feed-type and --feed-url are required for --upgrade-from");
  }
  const reader = new FeedReader({
    source: { type, url },
    token: deps.env.RELEASE_TOKEN ?? deps.env.GITHUB_TOKEN ?? null,
  });
  const entries = await reader.list();
  const candidates = entries.filter(
    (entry) =>
      entry.releaseJson &&
      (from === "previous"
        ? !current || compareVersions(entry.version, current) < 0
        : entry.version === from),
  );
  const entry = candidates[0];
  if (!entry) {
    return null;
  }
  const document = await reader.document(entry);
  const parsed = document ? parseReleaseDocument(document.bytes) : null;
  if (!parsed?.ok) {
    throw new Error(`release.json of ${entry.version} cannot be read`);
  }
  return {
    version: entry.version,
    images: Object.fromEntries(
      Object.entries(parsed.document.images).map(([key, image]) => [
        key,
        { repository: image.repository, digest: image.digest },
      ]),
    ),
  };
}

export function defaultReleaseDeps(): ReleaseCliDeps {
  return {
    env: process.env,
    io: {
      out: (line) => process.stdout.write(`${line}\n`),
      err: (line) => process.stderr.write(`${line}\n`),
    },
    exec: defaultExec,
    fetch,
    now: () => new Date(),
  };
}

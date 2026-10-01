import { randomBytes } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import {
  type Logger,
  type Redactor,
  type Verifier,
  VerifyError,
  type VerifyFailure,
} from "@cicd-updater/engine";
import {
  type KeylessIdentity,
  keylessIdentity,
  type TrustMode,
  type UpdaterConfig,
} from "@cicd-updater/protocol";
import { type CliDocker, classifyPullFailure } from "./docker.js";
import type { CommandResult, CommandRunner } from "./runner.js";

/**
 * Signature verification with the bundled cosign (design 3.4, 4.6, 8.2).
 *
 *   keyless  the exact certificate identity of the release workflow at the
 *            release tag and its issuer (plus GitHub's workflow repository,
 *            ref and trigger extensions), never a regular expression;
 *   key      one of the configured public keys (rotation: any of them);
 *   none     nothing is verified; recorded as `not_checked`.
 *
 * cosign runs in a short-lived sibling container of the sidecar's own image
 * (resolved by image ID), without the Docker socket, read-only, without
 * capabilities, as 65534:65534, with only the verification volume (read-only)
 * and a per-verification registry credential file. `trust.verifier.isolate:
 * false` runs cosign as a subprocess instead (weaker; documented).
 *
 * The cosign flags are fixed here against the bundled cosign version; the e2e
 * covers them (docs/compatibility.md).
 */

export const COSIGN_FLAGS = {
  identity: "--certificate-identity",
  issuer: "--certificate-oidc-issuer",
  githubRepository: "--certificate-github-workflow-repository",
  githubRef: "--certificate-github-workflow-ref",
  githubTrigger: "--certificate-github-workflow-trigger",
  trustedRoot: "--trusted-root",
  key: "--key",
  bundle: "--bundle",
  ignoreTlog: "--insecure-ignore-tlog=true",
} as const;

const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9._/:-]{0,254}@sha256:[0-9a-f]{64}$/;

/** The registry host of an image reference (Docker Hub when there is none). */
export function registryOf(ref: string): string {
  const first = ref.split("/")[0] ?? "";
  return ref.includes("/") && (first.includes(".") || first.includes(":") || first === "localhost")
    ? first
    : "docker.io";
}

const DOCKER_HUB_KEYS = new Set(["docker.io", "index.docker.io", "registry-1.docker.io"]);

/**
 * The credentials of one registry in a Docker `auths` object. Keys may be written
 * as a bare host, with a scheme or with a path (`https://ghcr.io`,
 * `https://index.docker.io/v1/`); Docker Hub has several names.
 */
export function authEntryFor(
  auths: Readonly<Record<string, unknown>> | undefined,
  host: string,
): unknown {
  const wanted = host.toLowerCase();
  const normalize = (key: string): string =>
    key
      .toLowerCase()
      .replace(/^[a-z]+:\/\//, "")
      .split("/")[0] ?? "";
  for (const [key, entry] of Object.entries(auths ?? {})) {
    const name = normalize(key);
    if (name === wanted || (DOCKER_HUB_KEYS.has(wanted) && DOCKER_HUB_KEYS.has(name))) {
      return entry;
    }
  }
  return undefined;
}

/** Classify cosign output (design 5.3 fetch 2). */
export function classifyCosignFailure(text: string): VerifyFailure {
  const t = text.toLowerCase();
  if (/toomanyrequests|rate limit|too many requests/.test(t)) {
    return "registry_rate_limited";
  }
  if (/unauthorized|denied|forbidden|authentication required|\b401\b|\b403\b/.test(t)) {
    return "registry_unauthorized";
  }
  if (/no signatures found|signature not found|no matching attestations|bundle not found/.test(t)) {
    return "signature_missing";
  }
  if (
    /none of the expected identities matched|expected identity|certificate identity|invalid signature|signature mismatch|failed to verify signature|no matching signatures|error verifying bundle|issuer mismatch|key mismatch/.test(
      t,
    )
  ) {
    return "signature_invalid";
  }
  if (/manifest unknown|name unknown|not found/.test(t)) {
    return "image_not_found";
  }
  if (/tuf|sigstore|rekor|fulcio|trusted root|tlog/.test(t)) {
    return "verifier_failed";
  }
  if (
    /no such host|dial tcp|i\/o timeout|connection refused|tls:|x509|network is unreachable|context deadline exceeded/.test(
      t,
    )
  ) {
    return "registry_unreachable";
  }
  return "verifier_failed";
}

export interface CosignVerifierOptions {
  config: UpdaterConfig;
  runner: CommandRunner;
  docker: CliDocker;
  redactor: Redactor;
  logger: Logger;
  /** The sidecar's own image ID (the verifier container runs it). */
  selfImage: () => string | null;
  /** The named volume mounted at `trust.verifier.workDir` (resolved by self-inspection). */
  verifyVolume: () => string | null;
}

export class CosignVerifier implements Verifier {
  readonly mode: TrustMode;

  constructor(private readonly options: CosignVerifierOptions) {
    this.mode = options.config.trust.mode;
  }

  private get trust(): UpdaterConfig["trust"] {
    return this.options.config.trust;
  }

  /** Identity flags for keyless verification of the release `tag`. */
  identityArgs(tag: string, version: string): string[] {
    const keyless = this.trust.keyless;
    if (!keyless) {
      throw new VerifyError("verifier_failed", "keyless mode without an identity");
    }
    const identity: KeylessIdentity = keylessIdentity(keyless, tag, version);
    const args = [COSIGN_FLAGS.identity, identity.identity, COSIGN_FLAGS.issuer, identity.issuer];
    if (identity.github) {
      args.push(
        COSIGN_FLAGS.githubRepository,
        identity.github.repository,
        COSIGN_FLAGS.githubRef,
        identity.github.ref,
        COSIGN_FLAGS.githubTrigger,
        identity.github.trigger,
      );
    }
    return args;
  }

  /** Prepare a per-verification directory under the work dir; removed afterwards. */
  private async workspace(
    ref: string | null,
  ): Promise<{ dir: string; dockerConfig: string | null; cleanup: () => Promise<void> }> {
    const base = this.trust.verifier.workDir;
    const dir = path.join(base, `v-${Date.now()}-${randomBytes(4).toString("hex")}`);
    await fs.mkdir(dir, { recursive: true, mode: 0o755 });
    let dockerConfig: string | null = null;
    const authFile = this.options.config.docker.registryAuthFile;
    if (ref && authFile) {
      // Only the one entry this verification needs, readable by the verifier user only.
      const raw = JSON.parse(await fs.readFile(authFile, "utf8")) as {
        auths?: Record<string, unknown>;
      };
      const host = registryOf(ref);
      const entry = authEntryFor(raw.auths, host);
      if (entry) {
        dockerConfig = path.join(dir, "docker");
        await fs.mkdir(dockerConfig, { mode: 0o755 });
        const file = path.join(dockerConfig, "config.json");
        await fs.writeFile(file, JSON.stringify({ auths: { [host]: entry } }), { mode: 0o400 });
        await fs.chown(file, 65534, 65534).catch(() => undefined);
      }
    }
    return { dir, dockerConfig, cleanup: () => fs.rm(dir, { recursive: true, force: true }) };
  }

  /** Copy a file into the workspace (keys, trusted root, documents) and return its path. */
  private async place(dir: string, name: string, content: Uint8Array | string): Promise<string> {
    const file = path.join(dir, name);
    await fs.writeFile(file, content, { mode: 0o444 });
    return file;
  }

  /** Run cosign isolated (sibling container) or as a subprocess. */
  private async cosign(args: string[], dockerConfig: string | null): Promise<CommandResult> {
    const timeoutMs = this.trust.verifier.timeoutSeconds * 1000;
    if (!this.trust.verifier.isolate) {
      return await this.options.runner.run({
        argv: ["cosign", ...args],
        timeoutMs,
        env: dockerConfig ? { DOCKER_CONFIG: dockerConfig } : {},
        maxOutputBytes: 1024 * 1024,
      });
    }
    const image = this.options.selfImage();
    const volume = this.options.verifyVolume();
    if (!image || !volume) {
      throw new VerifyError(
        "verifier_failed",
        "The isolated verifier cannot start: own image or verification volume unknown.",
      );
    }
    const workDir = this.trust.verifier.workDir;
    const runArgs = [
      "--read-only",
      "--cap-drop",
      "ALL",
      "--security-opt",
      "no-new-privileges:true",
      "--user",
      "65534:65534",
      "--tmpfs",
      "/tmp:rw,size=64m",
      "--env",
      "HOME=/tmp",
      "--volume",
      `${volume}:${workDir}:ro`,
    ];
    if (dockerConfig) {
      runArgs.push("--env", `DOCKER_CONFIG=${dockerConfig}`);
    }
    runArgs.push("--entrypoint", "cosign", image, ...args);
    return await this.options.docker.run(runArgs, { timeoutMs, maxOutputBytes: 1024 * 1024 });
  }

  private async keyArgs(dir: string): Promise<string[][]> {
    const key = this.trust.key;
    if (!key) {
      throw new VerifyError("verifier_failed", "key mode without public keys");
    }
    const sets: string[][] = [];
    for (const [index, file] of key.publicKeyFiles.entries()) {
      const placed = await this.place(dir, `key-${index}.pub`, await fs.readFile(file));
      sets.push(
        key.transparencyLog
          ? [COSIGN_FLAGS.key, placed]
          : [COSIGN_FLAGS.key, placed, COSIGN_FLAGS.ignoreTlog],
      );
    }
    return sets;
  }

  private async rootArgs(dir: string): Promise<string[]> {
    const root = this.trust.keyless?.trustedRootFile;
    if (!root) {
      return [];
    }
    return [
      COSIGN_FLAGS.trustedRoot,
      await this.place(dir, "trusted_root.json", await fs.readFile(root)),
    ];
  }

  async verifyDocument(input: {
    document: Uint8Array;
    bundle: Uint8Array | null;
    tag: string;
    version: string;
  }) {
    if (this.mode === "none") {
      return "not_checked" as const;
    }
    if (!input.bundle) {
      throw new VerifyError(
        "signature_missing",
        "The release has no release.json.sigstore.json bundle.",
      );
    }
    const space = await this.workspace(null);
    try {
      const document = await this.place(space.dir, "release.json", input.document);
      const bundle = await this.place(space.dir, "release.json.sigstore.json", input.bundle);
      const attempts =
        this.mode === "keyless"
          ? [[...this.identityArgs(input.tag, input.version), ...(await this.rootArgs(space.dir))]]
          : await this.keyArgs(space.dir);
      return await this.firstSuccess(
        attempts.map((extra) => ["verify-blob", COSIGN_FLAGS.bundle, bundle, ...extra, document]),
        null,
      );
    } finally {
      await space.cleanup();
    }
  }

  async verifyImage(input: { ref: string; tag: string; version: string }) {
    if (this.mode === "none") {
      return "not_checked" as const;
    }
    if (!IMAGE_BY_DIGEST.test(input.ref)) {
      throw new VerifyError("verifier_failed", "Only images named by digest are verified.");
    }
    const space = await this.workspace(input.ref);
    try {
      const attempts =
        this.mode === "keyless"
          ? [[...this.identityArgs(input.tag, input.version), ...(await this.rootArgs(space.dir))]]
          : await this.keyArgs(space.dir);
      return await this.firstSuccess(
        attempts.map((extra) => ["verify", ...extra, input.ref]),
        space.dockerConfig,
      );
    } finally {
      await space.cleanup();
    }
  }

  /** Accept the first passing attempt (key rotation); report the most specific failure otherwise. */
  private async firstSuccess(
    attempts: string[][],
    dockerConfig: string | null,
  ): Promise<"verified"> {
    let failure: VerifyError | null = null;
    for (const args of attempts) {
      const result = await this.cosign(args, dockerConfig);
      if (result.exitCode === 0) {
        return "verified";
      }
      const code = result.timedOut ? "verifier_failed" : classifyCosignFailure(result.errorTail);
      const error = new VerifyError(code, this.options.redactor.oneLine(result.errorTail, 1000));
      // An infrastructure failure stops at once; a wrong key lets the next key try.
      if (!["signature_invalid", "signature_missing"].includes(code)) {
        throw error;
      }
      failure = error;
    }
    throw failure ?? new VerifyError("verifier_failed", "No verification was attempted.");
  }

  async imageExists(ref: string): Promise<{ exists: boolean | null; error: VerifyFailure | null }> {
    if (!IMAGE_BY_DIGEST.test(ref)) {
      return { exists: null, error: "verifier_failed" };
    }
    const result = await this.options.docker.docker(
      ["buildx", "imagetools", "inspect", "--raw", ref],
      {
        timeoutMs: 60_000,
        maxOutputBytes: 4 * 1024 * 1024,
      },
    );
    if (result.exitCode === 0) {
      return { exists: true, error: null };
    }
    const kind = classifyPullFailure(result.errorTail);
    if (kind === "image_not_found") {
      return { exists: false, error: "image_not_found" };
    }
    return { exists: null, error: kind === "pull_failed" ? "verifier_failed" : kind };
  }
}

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Redactor, VerifyError } from "@cicd-updater/engine";
import { baseConfig, memoryLogger } from "@cicd-updater/engine/testing";
import { type UpdaterConfigInput, validateConfig } from "@cicd-updater/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  authEntryFor,
  CliDocker,
  CosignVerifier,
  classifyCosignFailure,
  registryOf,
} from "../src/index.js";
import { rejection, ScriptedRunner } from "./helpers.js";

let dir: string;
const REF = `ghcr.io/acme/notes@sha256:${"a".repeat(64)}`;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-verify-"));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function verifier(
  runner: ScriptedRunner,
  change: (input: UpdaterConfigInput) => void = () => undefined,
  self = { image: "sha256:self", volume: "notes_updater-verify" },
) {
  const input = baseConfig("/opt/notes");
  input.trust = { ...input.trust, verifier: { workDir: path.join(dir, "verify") } };
  change(input);
  const result = validateConfig(input);
  if (!result.ok) throw new Error(JSON.stringify(result.problems));
  const redactor = new Redactor();
  const docker = new CliDocker({
    runner,
    redactor,
    compose: { projectName: "notes", files: [], envFile: null, profiles: [] },
    timeouts: { pullSeconds: 1800, upSeconds: 900, composeSeconds: 120, stopSeconds: 60 },
  });
  return new CosignVerifier({
    config: result.config,
    runner,
    docker,
    redactor,
    logger: memoryLogger(redactor),
    selfImage: () => self.image,
    verifyVolume: () => self.volume,
  });
}

describe("keyless", () => {
  it("verifies an image by digest for the exact identity in an isolated, locked-down container", async () => {
    const runner = new ScriptedRunner();
    expect(await verifier(runner).verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" })).toBe(
      "verified",
    );
    const argv = runner.argvs[0] as string[];
    const workDir = path.join(dir, "verify");
    expect(argv).toEqual([
      "docker",
      "run",
      "--rm",
      "--label",
      "io.github.restow-backup.cicd-updater.managed=true",
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
      `notes_updater-verify:${workDir}:ro`,
      "--entrypoint",
      "cosign",
      "sha256:self",
      "verify",
      "--certificate-identity",
      "https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.1.0",
      "--certificate-oidc-issuer",
      "https://token.actions.githubusercontent.com",
      "--certificate-github-workflow-repository",
      "acme/notes",
      "--certificate-github-workflow-ref",
      "refs/tags/v1.1.0",
      "--certificate-github-workflow-trigger",
      "push",
      REF,
    ]);
    expect(argv.join(" ")).not.toMatch(/regexp|docker\.sock/);
    // The per-verification directory is gone afterwards.
    expect(await fs.readdir(workDir)).toEqual([]);
  });

  it("verifies release.json against its bundle with the same identity and uses a trusted root when configured", async () => {
    const root = path.join(dir, "trusted_root.json");
    await fs.writeFile(root, "{}");
    const runner = new ScriptedRunner();
    const subject = verifier(runner, (input) => {
      input.trust = {
        mode: "keyless",
        keyless: {
          github: { repository: "acme/notes", workflow: ".github/workflows/release.yml" },
          trustedRootFile: root,
        },
        verifier: { workDir: path.join(dir, "verify") },
      };
    });
    expect(
      await subject.verifyDocument({
        document: Buffer.from("{}"),
        bundle: Buffer.from("{}"),
        tag: "v1.1.0",
        version: "1.1.0",
      }),
    ).toBe("verified");
    const argv = runner.argvs[0] as string[];
    const cosign = argv.slice(argv.indexOf("sha256:self") + 1);
    expect(cosign[0]).toBe("verify-blob");
    expect(cosign[1]).toBe("--bundle");
    expect(cosign[2]).toMatch(/release\.json\.sigstore\.json$/);
    expect(cosign).toContain("--trusted-root");
    expect(cosign.at(-1)).toMatch(/release\.json$/);
    await expect(
      rejection<VerifyError>(
        subject.verifyDocument({
          document: Buffer.from("{}"),
          bundle: null,
          tag: "v1.1.0",
          version: "1.1.0",
        }),
      ),
    ).resolves.toMatchObject({
      code: "signature_missing",
    });
  });

  it("builds GitLab and generic identities", async () => {
    const runner = new ScriptedRunner();
    await verifier(runner, (input) => {
      input.trust = {
        mode: "keyless",
        keyless: { gitlab: { project: "acme/notes" } },
        verifier: { workDir: path.join(dir, "verify"), isolate: false },
      };
    }).verifyImage({ ref: REF, tag: "v2.0.0", version: "2.0.0" });
    expect(runner.argvs[0]).toEqual([
      "cosign",
      "verify",
      "--certificate-identity",
      "https://gitlab.com/acme/notes//.gitlab-ci.yml@refs/tags/v2.0.0",
      "--certificate-oidc-issuer",
      "https://gitlab.com",
      REF,
    ]);
  });

  it("fails on a wrong signer and refuses references that are not by digest", async () => {
    const runner = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail:
        "Error: no matching signatures: none of the expected identities matched what was in the certificate",
    }));
    const error = await rejection<VerifyError>(
      verifier(runner).verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" }),
    );
    expect(error).toBeInstanceOf(VerifyError);
    expect(error.code).toBe("signature_invalid");
    const notDigest = await rejection<VerifyError>(
      verifier(new ScriptedRunner()).verifyImage({
        ref: "ghcr.io/acme/notes:1.1.0",
        tag: "v1.1.0",
        version: "1.1.0",
      }),
    );
    expect(notDigest.code).toBe("verifier_failed");
  });

  it("cannot start isolated without its own image or the verification volume", async () => {
    const runner = new ScriptedRunner();
    const error = await rejection<VerifyError>(
      verifier(runner, undefined, { image: "sha256:self", volume: null as never }).verifyImage({
        ref: REF,
        tag: "v1.1.0",
        version: "1.1.0",
      }),
    );
    expect(error.code).toBe("verifier_failed");
    expect(runner.specs).toEqual([]);
  });
});

describe("key mode", () => {
  it("accepts a signature by any configured key (rotation) and skips the transparency log unless asked", async () => {
    const keys = [path.join(dir, "old.pub"), path.join(dir, "new.pub")];
    for (const key of keys) {
      await fs.writeFile(key, "-----BEGIN PUBLIC KEY-----\nMFk=\n-----END PUBLIC KEY-----\n");
    }
    const runner = new ScriptedRunner().answer((spec) =>
      spec.argv.some((arg) => arg.endsWith("key-0.pub"))
        ? { exitCode: 1, errorTail: "error verifying bundle: invalid signature" }
        : undefined,
    );
    const subject = verifier(runner, (input) => {
      input.trust = {
        mode: "key",
        key: { publicKeyFiles: keys },
        verifier: { workDir: path.join(dir, "verify"), isolate: false },
      };
    });
    expect(await subject.verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" })).toBe(
      "verified",
    );
    expect(runner.argvs.map((argv) => argv.slice(0, 2).concat(argv.slice(3)))).toEqual([
      [
        "cosign",
        "verify",
        expect.stringMatching(/key-0\.pub$/),
        "--insecure-ignore-tlog=true",
        REF,
      ],
      [
        "cosign",
        "verify",
        expect.stringMatching(/key-1\.pub$/),
        "--insecure-ignore-tlog=true",
        REF,
      ],
    ]);
  });

  it("stops at an infrastructure failure instead of trying the next key", async () => {
    const key = path.join(dir, "k.pub");
    await fs.writeFile(key, "-----BEGIN PUBLIC KEY-----\n");
    const runner = new ScriptedRunner().answer(() => ({
      exitCode: 1,
      errorTail: "GET https://ghcr.io/v2/: UNAUTHORIZED: authentication required",
    }));
    const subject = verifier(runner, (input) => {
      input.trust = {
        mode: "key",
        key: { publicKeyFiles: [key, key], transparencyLog: true },
        verifier: { workDir: path.join(dir, "verify"), isolate: false },
      };
    });
    const error = await rejection<VerifyError>(
      subject.verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" }),
    );
    expect(error.code).toBe("registry_unauthorized");
    expect(runner.specs).toHaveLength(1);
    expect(runner.argvs[0]).not.toContain("--insecure-ignore-tlog=true");
  });
});

describe("none mode and registry credentials", () => {
  it("checks nothing in none mode", async () => {
    const runner = new ScriptedRunner();
    const subject = verifier(runner, (input) => {
      input.trust = { mode: "none", none: { acknowledgeUnsigned: true } };
    });
    expect(await subject.verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" })).toBe(
      "not_checked",
    );
    expect(
      await subject.verifyDocument({
        document: Buffer.from("{}"),
        bundle: null,
        tag: "v1.1.0",
        version: "1.1.0",
      }),
    ).toBe("not_checked");
    expect(runner.specs).toEqual([]);
  });

  it("hands the verifier only the one registry entry it needs, in a file, never in argv", async () => {
    const auth = path.join(dir, "config.json");
    await fs.writeFile(
      auth,
      JSON.stringify({
        auths: {
          "ghcr.io": { auth: "Z2hjci11c2VyOnNlY3JldA==" },
          "registry.example.com": { auth: "b3RoZXI6c2VjcmV0" },
        },
      }),
    );
    let seen: { config: string; mode: number } | null = null;
    const runner = new ScriptedRunner();
    const original = runner.run.bind(runner);
    runner.run = async (spec) => {
      const env = spec.argv.find((arg) => arg.startsWith("DOCKER_CONFIG="));
      if (env) {
        const file = path.join(env.slice("DOCKER_CONFIG=".length), "config.json");
        seen = {
          config: await fs.readFile(file, "utf8"),
          mode: (await fs.stat(file)).mode & 0o777,
        };
      }
      return original(spec);
    };
    await verifier(runner, (input) => {
      input.docker = { registryAuthFile: auth };
    }).verifyImage({ ref: REF, tag: "v1.1.0", version: "1.1.0" });
    expect(seen).toEqual({
      config: JSON.stringify({ auths: { "ghcr.io": { auth: "Z2hjci11c2VyOnNlY3JldA==" } } }),
      mode: 0o400,
    });
    expect(runner.everything()).not.toContain("Z2hjci11c2VyOnNlY3JldA==");
  });

  it("reads the registry host of a reference", () => {
    expect(registryOf("ghcr.io/acme/notes@sha256:a")).toBe("ghcr.io");
    expect(registryOf("registry.example.com:5000/a/b@sha256:a")).toBe("registry.example.com:5000");
    expect(authEntryFor({ "https://ghcr.io": { auth: "x" } }, "ghcr.io")).toEqual({ auth: "x" });
    expect(authEntryFor({ "https://index.docker.io/v1/": { auth: "h" } }, "docker.io")).toEqual({
      auth: "h",
    });
    expect(authEntryFor({ "ghcr.io.evil.example": { auth: "e" } }, "ghcr.io")).toBeUndefined();
    expect(authEntryFor(undefined, "ghcr.io")).toBeUndefined();
    expect(registryOf("library/postgres@sha256:a")).toBe("docker.io");
    expect(registryOf("localhost/a@sha256:a")).toBe("localhost");
  });
});

describe("cosign output classification", () => {
  it.each([
    ["Error: no signatures found", "signature_missing"],
    ["Error: no matching signatures: none of the expected identities matched", "signature_invalid"],
    [
      "error verifying bundle: invalid signature when validating ASN.1 encoded signature",
      "signature_invalid",
    ],
    [
      "GET https://ghcr.io/v2/x/manifests/sha256:a: DENIED: requested access to the resource is denied",
      "registry_unauthorized",
    ],
    ["TOOMANYREQUESTS: rate limit exceeded", "registry_rate_limited"],
    [
      "GET https://ghcr.io/v2/x/manifests/sha256:a: MANIFEST_UNKNOWN: manifest unknown",
      "image_not_found",
    ],
    ["updating local metadata and targets: error updating to TUF remote mirror", "verifier_failed"],
    ["dial tcp: lookup registry.example.com: no such host", "registry_unreachable"],
    ["something unexpected", "verifier_failed"],
  ])("%s -> %s", (text, code) => {
    expect(classifyCosignFailure(text)).toBe(code);
  });
});

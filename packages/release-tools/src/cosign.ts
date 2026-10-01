import type { TrustMode } from "@cicd-updater/protocol";
import { type Exec, expectOk } from "./exec.js";

/**
 * Release-side signing (design 2.2, 8.2) with the same pinned cosign minor
 * version the sidecar verifies with:
 *
 *   keyless  `cosign sign` of each index digest and `cosign sign-blob --bundle`
 *            of release.json with the CI's OIDC identity (transparency log)
 *   key      the same with `--key` (a file or a KMS URI); the transparency log
 *            upload is off unless asked for
 *   none     nothing is signed; release.json records `signing.mode: none`
 *
 * The private key password, when there is one, reaches cosign as
 * COSIGN_PASSWORD from the CI secret; it never appears in argv.
 */

export interface SigningOptions {
  mode: TrustMode;
  /** `key` mode: a key file path or a KMS URI cosign supports. */
  key?: string | null;
  /** `key` mode: also upload to the transparency log. */
  transparencyLog?: boolean;
}

const IMAGE_BY_DIGEST = /^[a-z0-9][a-z0-9._/:-]{0,254}@sha256:[0-9a-f]{64}$/;

function keyArgs(options: SigningOptions): string[] {
  if (options.mode !== "key") {
    return [];
  }
  if (!options.key) {
    throw new Error("Signing mode key needs a key (input cosign-key).");
  }
  return ["--key", options.key, ...(options.transparencyLog ? [] : ["--tlog-upload=false"])];
}

/** The cosign argv that signs an image index by digest; null in mode none. */
export function signImageArgs(ref: string, options: SigningOptions): string[] | null {
  if (!IMAGE_BY_DIGEST.test(ref)) {
    throw new Error(`Only images by digest are signed: ${ref}`);
  }
  if (options.mode === "none") {
    return null;
  }
  return ["cosign", "sign", "--yes", ...keyArgs(options), ref];
}

/** The cosign argv that signs a file into a Sigstore bundle; null in mode none. */
export function signBlobArgs(
  file: string,
  bundle: string,
  options: SigningOptions,
): string[] | null {
  if (options.mode === "none") {
    return null;
  }
  return ["cosign", "sign-blob", "--yes", ...keyArgs(options), "--bundle", bundle, file];
}

export interface KeylessExpectation {
  identity: string;
  issuer: string;
  github?: { repository: string; ref: string; trigger: string } | null;
}

/** The cosign argv that verifies a file against its bundle (the release's own check before publishing). */
export function verifyBlobArgs(
  file: string,
  bundle: string,
  expectation:
    | { mode: "keyless"; keyless: KeylessExpectation }
    | { mode: "key"; publicKey: string; transparencyLog?: boolean },
): string[] {
  const args = ["cosign", "verify-blob", "--bundle", bundle];
  if (expectation.mode === "keyless") {
    args.push(
      "--certificate-identity",
      expectation.keyless.identity,
      "--certificate-oidc-issuer",
      expectation.keyless.issuer,
    );
    if (expectation.keyless.github) {
      args.push(
        "--certificate-github-workflow-repository",
        expectation.keyless.github.repository,
        "--certificate-github-workflow-ref",
        expectation.keyless.github.ref,
        "--certificate-github-workflow-trigger",
        expectation.keyless.github.trigger,
      );
    }
  } else {
    args.push("--key", expectation.publicKey);
    if (!expectation.transparencyLog) {
      args.push("--insecure-ignore-tlog=true");
    }
  }
  args.push(file);
  return args;
}

/** The cosign argv that attaches an SPDX SBOM to an image as a signed attestation; null in mode none. */
export function attestSbomArgs(
  ref: string,
  predicateFile: string,
  options: SigningOptions,
): string[] | null {
  if (!IMAGE_BY_DIGEST.test(ref)) {
    throw new Error(`Only images by digest are attested: ${ref}`);
  }
  if (options.mode === "none") {
    return null;
  }
  return [
    "cosign",
    "attest",
    "--yes",
    ...keyArgs(options),
    "--type",
    "spdxjson",
    "--predicate",
    predicateFile,
    ref,
  ];
}

/** Run a signing argv (no-op for null), with the key password from the environment only. */
export async function runSigning(
  exec: Exec,
  argv: string[] | null,
  password: string | null,
): Promise<void> {
  if (!argv) {
    return;
  }
  const env: Record<string, string> = password ? { COSIGN_PASSWORD: password } : {};
  expectOk(
    await exec(argv as [string, ...string[]], { env, timeoutMs: 10 * 60_000 }),
    argv.slice(0, 2).join(" "),
  );
}

/** `cosign version --json` -> "3.1.3". */
export function parseCosignVersion(output: string): string | null {
  try {
    const parsed = JSON.parse(output) as { gitVersion?: unknown };
    return typeof parsed.gitVersion === "string" ? parsed.gitVersion.replace(/^v/, "") : null;
  } catch {
    const match = /GitVersion:\s*v?([0-9][0-9A-Za-z.+-]*)/.exec(output);
    return match?.[1] ?? null;
  }
}

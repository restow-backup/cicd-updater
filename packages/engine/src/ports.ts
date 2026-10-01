import type {
  BackupType,
  Capabilities,
  CheckSpec,
  FailureCode,
  Platform,
  StepId,
  TrustMode,
} from "@cicd-updater/protocol";

/**
 * The seams of the engine (design 5). The state machine is driven only
 * through these interfaces, so every scenario (a failing pull, a crashing
 * app, a rollback that fails, an interrupted run) can be scripted with fakes
 * and no Docker. The sidecar package implements them over the `docker` CLI,
 * cosign, the feed and the file system.
 */

// ---------------------------------------------------------------------------
// Time and logging
// ---------------------------------------------------------------------------

export interface TimerHandle {
  cancel(): void;
}

export interface Clock {
  now(): Date;
  /** Wait `ms`; resolves early (without throwing) when `signal` aborts. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Run `fn` once after `ms`. The timer never keeps the process alive on its own. */
  setTimer(fn: () => void, ms: number): TimerHandle;
}

export const systemClock: Clock = {
  now: () => new Date(),
  sleep: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        signal?.removeEventListener("abort", done);
        resolve();
      }
      signal?.addEventListener("abort", done, { once: true });
    }),
  setTimer: (fn, ms) => {
    // setTimeout cannot wait longer than 2^31-1 ms; re-arm in steps.
    let timer: ReturnType<typeof setTimeout> | null = null;
    const due = Date.now() + ms;
    const arm = (): void => {
      const remaining = due - Date.now();
      timer = setTimeout(
        remaining > 2_000_000_000 ? arm : fn,
        Math.max(0, Math.min(remaining, 2_000_000_000)),
      );
      timer.unref?.();
    };
    arm();
    return { cancel: () => (timer ? clearTimeout(timer) : undefined) };
  },
};

/** Where the sidecar's own log lines go. Every line passes through the redactor first. */
export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

// ---------------------------------------------------------------------------
// Docker and Compose
// ---------------------------------------------------------------------------

export interface ServiceState {
  service: string;
  /** `running`, `restarting`, `exited`, `created`, `paused`, `dead`, `removing`. */
  state: string;
  /** Docker health: `healthy`, `unhealthy`, `starting`, or null without a healthcheck. */
  health: string | null;
  exitCode: number | null;
  /** The image reference the container was created from. */
  image: string | null;
}

export interface ImageInfo {
  /** The image ID (`sha256:...`). */
  id: string;
  /** `name@sha256:...` entries the image is known by. */
  repoDigests: string[];
  labels: Record<string, string>;
}

export type PullFailureKind =
  | "registry_unauthorized"
  | "image_not_found"
  | "registry_rate_limited"
  | "registry_unreachable"
  | "pull_failed";

/** A pull failed; `kind` is the classified reason (design 5.3 fetch 3). */
export class PullError extends Error {
  constructor(
    readonly kind: PullFailureKind,
    readonly detail: string,
  ) {
    super(`The image pull failed (${kind}).`);
    this.name = "PullError";
  }
}

/** A Docker or Compose operation failed. `detail` is redacted. */
export class OpsError extends Error {
  constructor(
    message: string,
    readonly detail: string = "",
  ) {
    super(message);
    this.name = "OpsError";
  }
}

export interface RunOnceResult {
  exitCode: number;
  /** Redacted tail of the output. */
  outputTail: string;
  timedOut: boolean;
}

export interface BuildSpec {
  contextDir: string;
  dockerfile: string;
  target: string | null;
  tag: string;
  buildArgs: Readonly<Record<string, string>>;
}

/** The Docker and Compose operations the engine performs itself. */
export interface DockerOps {
  /** Image of each service as `docker compose config` resolves it, with `env` in the process environment. */
  composeImages(env: Readonly<Record<string, string>>): Promise<Record<string, string | null>>;
  /** The host platform (`docker info` architecture). */
  hostPlatform(): Promise<Platform | null>;
  /** Pull by digest. Throws {@link PullError}. */
  pull(ref: string): Promise<void>;
  /** The local image for `ref`; null when there is none. */
  inspectImage(ref: string): Promise<ImageInfo | null>;
  /** `docker compose stop -t <timeout> <services>`. */
  stop(services: readonly string[], timeoutSeconds: number): Promise<void>;
  /** `docker compose up -d --no-deps --no-build --pull never <services>`. */
  up(services: readonly string[]): Promise<void>;
  /** `docker compose run --rm --no-deps -T --name <name> <service> <argv>` with `env` in the process environment. */
  runOnce(spec: {
    service: string;
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    name: string;
    timeoutSeconds: number;
  }): Promise<RunOnceResult>;
  /** Remove a container by name (force); no error when it does not exist. */
  removeContainer(name: string): Promise<void>;
  /** States of the project's containers. */
  serviceStates(): Promise<ServiceState[]>;
  /** Last lines of a service's log, redacted; empty when unavailable. */
  logsTail(service: string, lines: number): Promise<string>;
  /** A label of the image the service's running container uses; null when unknown. */
  runningImageLabel(service: string, label: string): Promise<string | null>;
  /**
   * Remove images of the managed repositories no container uses, keeping
   * `keep` (references) and the newest `keepCount` others per repository.
   * Never forced, never a global prune. Returns the removed references.
   */
  pruneImages(input: {
    repositories: readonly string[];
    keep: readonly string[];
    keepCount: number;
  }): Promise<string[]>;
  /** `docker build` (source mode). */
  build(spec: BuildSpec): Promise<void>;
  /** Remove helper containers carrying the managed label and leftover migrate containers. */
  removeLeftovers(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

/** The migration probe could not produce a value (state unknown). */
export class ProbeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeError";
  }
}

export interface MigrationProbe {
  readonly configured: boolean;
  /** The current probe value; throws {@link ProbeError}. */
  read(signal?: AbortSignal): Promise<string>;
}

export interface AppCheckResult {
  healthy: boolean;
  /** The version the app reports; null when it reported none or no version is configured. */
  version: string | null;
  /** Short redacted reason when not healthy. */
  detail: string | null;
}

export interface CheckResult {
  ok: boolean;
  /** Short redacted detail (status, exit code, excerpt). */
  detail: string;
}

export interface Hooks {
  probe: MigrationProbe;
  /** Whether `hooks.health` checks the app (type http or command). */
  readonly appCheckConfigured: boolean;
  /** Whether the app check is configured to report a version. */
  readonly appReportsVersion: boolean;
  /** One app check; null when no app check is configured. */
  appCheck(): Promise<AppCheckResult | null>;
  /** One smoke or per-service check. */
  check(spec: CheckSpec): Promise<CheckResult>;
}

export type BackupFailureKind =
  | "insufficient_space"
  | "failed"
  | "timeout"
  | "verify_failed"
  | "aborted";

export class BackupError extends Error {
  constructor(
    readonly kind: BackupFailureKind,
    readonly detail: string,
  ) {
    super(`The backup failed (${kind}): ${detail}`);
    this.name = "BackupError";
  }
}

export interface BackupRecord {
  file: string;
  bytes: number;
  sha256: string;
  type: BackupType;
  encrypted: boolean;
}

export interface BackupRunner {
  readonly type: BackupType;
  /** Whether an abort stops it mid-way (PostgreSQL); the others finish first. */
  readonly interruptible: boolean;
  /**
   * Create, verify (and encrypt) a backup; a failed or aborted backup leaves no
   * file behind. Throws {@link BackupError}.
   */
  create(input: {
    runId: string;
    fromVersion: string | null;
    toVersion: string;
    at: Date;
    signal: AbortSignal;
    onStage: (stage: "creating" | "verifying" | "encrypting") => Promise<void>;
  }): Promise<BackupRecord>;
}

// ---------------------------------------------------------------------------
// Trust
// ---------------------------------------------------------------------------

export type VerifyFailure =
  | "signature_missing"
  | "signature_invalid"
  | "verifier_failed"
  | "registry_unauthorized"
  | "registry_unreachable"
  | "registry_rate_limited"
  | "image_not_found";

export class VerifyError extends Error {
  constructor(
    readonly code: VerifyFailure,
    readonly detail: string,
  ) {
    super(`Verification failed (${code}): ${detail}`);
    this.name = "VerifyError";
  }
}

export interface Verifier {
  readonly mode: TrustMode;
  /** Verify release.json and its bundle for the release `tag`/`version`. Throws {@link VerifyError}. */
  verifyDocument(input: {
    document: Uint8Array;
    bundle: Uint8Array | null;
    tag: string;
    version: string;
  }): Promise<"verified" | "not_checked">;
  /** Verify the signature of `repository@digest` for the release. Throws {@link VerifyError}. */
  verifyImage(input: {
    ref: string;
    tag: string;
    version: string;
  }): Promise<"verified" | "not_checked">;
  /** Whether `repository@digest` exists in the registry (dry run, no pull); null when unknown. */
  imageExists(ref: string): Promise<{ exists: boolean | null; error: VerifyFailure | null }>;
}

// ---------------------------------------------------------------------------
// Releases and source mode
// ---------------------------------------------------------------------------

export interface CatalogEntry {
  version: string;
  tag: string;
  prerelease: boolean;
  publishedAt: string | null;
  notesUrl: string | null;
  hasDocument: boolean;
}

export type CatalogErrorCode = "release_not_found" | "feed_unavailable";

export class CatalogError extends Error {
  constructor(
    readonly code: CatalogErrorCode,
    /** For feed_unavailable: the feed error code (design 7.4). */
    readonly feedError: string | null,
    message: string,
  ) {
    super(message);
    this.name = "CatalogError";
  }
}

export interface FetchedRelease {
  entry: CatalogEntry;
  document: Uint8Array | null;
  bundle: Uint8Array | null;
}

/** The configured feed plus the store of verified documents. */
export interface ReleaseCatalog {
  /** `host/owner/repo` of the feed repository; null for static and file feeds. */
  readonly project: string | null;
  /** Releases of the feed, newest first. Throws {@link CatalogError}. */
  list(refresh: boolean): Promise<CatalogEntry[]>;
  /** One release with its document and bundle. Throws {@link CatalogError}. */
  fetch(version: string): Promise<FetchedRelease>;
  /** Keep the verified bytes for a run. */
  store(version: string, document: Uint8Array, bundle: Uint8Array | null): Promise<void>;
  /** The stored bytes; null when there are none. */
  load(version: string): Promise<{ document: Uint8Array; bundle: Uint8Array | null } | null>;
  /** Remove stored documents except the newest `keep` versions. */
  prune(keep: number): Promise<void>;
}

export type SourceFailureKind =
  | "source_not_allowed"
  | "token_unavailable"
  | "download_failed"
  | "build_failed";

export class SourceError extends Error {
  constructor(
    readonly kind: SourceFailureKind,
    readonly detail: string,
  ) {
    super(`Source mode failed (${kind}): ${detail}`);
    this.name = "SourceError";
  }
}

export interface SourceBuilder {
  /** Whether source mode is enabled and the feed repository matches the allowlist. */
  allowed(): boolean;
  /** Download, extract and build the image keys; returns key -> local reference. Throws {@link SourceError}. */
  build(input: {
    runId: string;
    version: string;
    tag: string;
    imageKeys: readonly string[];
    signal: AbortSignal;
    onStage: (stage: "downloading" | "building", index: number, total: number) => Promise<void>;
  }): Promise<Record<string, string>>;
  /** Remove every source tree (leftovers of interrupted runs included). */
  purge(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

export interface PreflightPort {
  /** Cached for 30 s unless `refresh`. */
  get(refresh?: boolean): Promise<Capabilities>;
  /** Compute now; `deep` includes the Compose probe. */
  check(options: { deep: boolean }): Promise<Capabilities>;
  invalidate(): void;
}

/** A step failed; `code` is the machine-readable reason, `detail` is redacted before it is stored. */
export class StepFailure extends Error {
  constructor(
    readonly code: FailureCode,
    readonly step: StepId | null,
    readonly detail: string = "",
  ) {
    super(`${code}: ${detail}`);
    this.name = "StepFailure";
  }
}

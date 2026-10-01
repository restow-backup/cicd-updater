import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  type Blocker,
  type Capabilities,
  type CheckSpec,
  canonicalJson,
  compareVersions,
  type ParsedScheduleRequest,
  type Platform,
  type UpdaterConfig,
  type UpdaterConfigInput,
  validateConfig,
  type Warning,
  writableKeys,
} from "@cicd-updater/protocol";
import { BackupStore } from "./backups.js";
import { UpdateEngine } from "./engine.js";
import { assignedKey, assignedValue, EnvFile, parseEnvLines } from "./env-file.js";
import {
  type AppCheckResult,
  BackupError,
  type BackupFailureKind,
  type BackupRecord,
  type BackupRunner,
  type BuildSpec,
  type CatalogEntry,
  CatalogError,
  type CheckResult,
  type Clock,
  type DockerOps,
  type FetchedRelease,
  type Hooks,
  type ImageInfo,
  type Logger,
  type MigrationProbe,
  type PreflightPort,
  ProbeError,
  PullError,
  type PullFailureKind,
  type ReleaseCatalog,
  type RunOnceResult,
  type ServiceState,
  type SourceBuilder,
  SourceError,
  type SourceFailureKind,
  type TimerHandle,
  type Verifier,
  VerifyError,
  type VerifyFailure,
} from "./ports.js";
import { Redactor } from "./redact.js";
import { ReleaseService } from "./release-check.js";
import { RunningVersionResolver } from "./running-version.js";
import { StatusStore } from "./store.js";

/**
 * Fakes and a harness for driving the engine in tests: a clock that only moves
 * when told, a Docker world that behaves like a Compose project (images follow
 * the env file, an app container can migrate, crash, never become ready or
 * report another version), hooks, a backup runner, a verifier, a release
 * catalog and a source builder. Nothing here touches Docker, the network or the
 * real clock.
 *
 * Derived from Restow's updater test harness (Apache-2.0).
 */

// ---------------------------------------------------------------------------
// Clock and logger
// ---------------------------------------------------------------------------

export class FakeClock implements Clock {
  private ms: number;
  private timers: { id: number; due: number; fn: () => void }[] = [];
  private nextId = 1;

  constructor(start = Date.parse("2026-11-02T10:00:00.000Z")) {
    this.ms = start;
  }

  now(): Date {
    return new Date(this.ms);
  }

  /** Time passes at once. */
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    if (!signal?.aborted) {
      this.advance(ms);
    }
    await Promise.resolve();
  }

  setTimer(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.push({ id, due: this.ms + ms, fn });
    return {
      cancel: () => {
        this.timers = this.timers.filter((timer) => timer.id !== id);
      },
    };
  }

  /** Move time forward and fire the timers that became due, in order. */
  advance(ms: number): void {
    const target = this.ms + ms;
    for (;;) {
      const due = this.timers
        .filter((timer) => timer.due <= target)
        .sort((a, b) => a.due - b.due)[0];
      if (!due) {
        break;
      }
      this.timers = this.timers.filter((timer) => timer.id !== due.id);
      this.ms = Math.max(this.ms, due.due);
      due.fn();
    }
    this.ms = target;
  }

  get pendingTimers(): number {
    return this.timers.length;
  }
}

export function memoryLogger(redactor: Redactor): Logger & { lines: string[] } {
  const lines: string[] = [];
  const add = (level: string) => (message: string) => {
    lines.push(`${level} ${redactor.oneLine(message, 4000)}`);
  };
  return { lines, debug: add("DEBUG"), info: add("INFO"), warn: add("WARN"), error: add("ERROR") };
}

// ---------------------------------------------------------------------------
// Docker world
// ---------------------------------------------------------------------------

export interface AppBehavior {
  /** `ready` answers healthy after `afterPolls` polls; `never` never does; `crash` restarts in a loop. */
  kind: "ready" | "never" | "crash";
  afterPolls?: number;
  /** Schema changes the app applies when it starts with this image. */
  migrates?: number;
  /** The version it reports (default: the tag of the image reference). */
  reportsVersion?: string;
}

interface FakeContainer {
  image: string;
  state: string;
  exitCode: number | null;
  health: string | null;
  polls: number;
}

/** A deterministic digest for a seed. */
export function digestOf(seed: string): string {
  return `sha256:${createHash("sha256").update(seed).digest("hex")}`;
}

/** The tag of an image reference (`repo:tag@digest` -> `tag`). */
export function tagOf(ref: string): string | null {
  const withoutDigest = ref.split("@")[0] ?? ref;
  const slash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > slash ? withoutDigest.slice(colon + 1) : null;
}

export class FakeDockerOps implements DockerOps {
  /** Every operation in order, as one line each (arguments included). */
  readonly calls: string[] = [];
  readonly containers = new Map<string, FakeContainer>();
  /** Local images by reference. */
  readonly localImages = new Map<string, ImageInfo>();
  /** Registry behaviour per pull reference: missing = pulls fine. */
  readonly registry = new Map<string, PullFailureKind>();
  /** What a pull stores instead of the correct image (digest mismatch, other version label). */
  readonly pulledInfo = new Map<string, ImageInfo>();
  readonly appBehavior = new Map<string, AppBehavior>();
  /** Migration commands by image: exit code, schema changes, timeout. */
  readonly migrateBehavior = new Map<
    string,
    { exitCode?: number; migrates?: number; timesOut?: boolean }
  >();
  readonly builds: BuildSpec[] = [];
  readonly prunes: {
    repositories: readonly string[];
    keep: readonly string[];
    keepCount: number;
  }[] = [];
  /** The database schema state the probe reads (a counter). */
  schema = 12;
  platform: Platform | null = "linux/amd64";
  /** Compose takes the image from the variables (false: the Compose file hard-codes them). */
  honoursVariables = true;
  /** The sidecar's own service image: pinned, or following a writable key. */
  updaterImage: "pinned" | "follows" = "pinned";
  /** Values Compose uses when a key is absent (`${APP_IMAGE:-default}`). */
  readonly defaults: Record<string, string> = {};
  /** Labels of images that run (for the label source of the running version). */
  readonly imageLabels = new Map<string, Record<string, string>>();
  private readonly failures = new Map<string, ((call: number) => Error | null)[]>();
  private readonly counters = new Map<string, number>();

  constructor(
    private readonly envPath: string,
    private readonly config: UpdaterConfig,
  ) {
    this.containers.set("db", {
      image: "postgres:17-alpine",
      state: "running",
      exitCode: null,
      health: null,
      polls: 0,
    });
    this.containers.set("updater", {
      image: "ghcr.io/restow-backup/cicd-updater:1.0.0",
      state: "running",
      exitCode: null,
      health: null,
      polls: 0,
    });
  }

  /** Make the n-th call (0-based) of an operation fail; without `call`, every call fails. */
  failOn(operation: string, error: Error, call?: number): void {
    const list = this.failures.get(operation) ?? [];
    list.push((index) => (call === undefined || call === index ? error : null));
    this.failures.set(operation, list);
  }

  clearFailures(operation?: string): void {
    if (operation) {
      this.failures.delete(operation);
    } else {
      this.failures.clear();
    }
  }

  callsTo(prefix: string): string[] {
    return this.calls.filter((call) => call === prefix || call.startsWith(`${prefix} `));
  }

  private hit(operation: string, detail = ""): void {
    this.calls.push(detail ? `${operation} ${detail}` : operation);
    const index = this.counters.get(operation) ?? 0;
    this.counters.set(operation, index + 1);
    for (const rule of this.failures.get(operation) ?? []) {
      const error = rule(index);
      if (error) {
        throw error;
      }
    }
  }

  /** The installation runs these references for its managed services. */
  installAt(images: Record<string, string>, version: string): void {
    for (const service of this.config.services) {
      const image = images[service.name] ?? images[service.image];
      if (!image) {
        continue;
      }
      this.containers.set(service.name, {
        image,
        state: "running",
        exitCode: null,
        health: null,
        polls: 0,
      });
      this.appBehavior.set(image, { kind: "ready", reportsVersion: version });
      this.localImages.set(image, { id: digestOf(`local:${image}`), repoDigests: [], labels: {} });
    }
  }

  private async envValue(
    key: string,
    processEnv: Readonly<Record<string, string>>,
  ): Promise<string | null> {
    if (processEnv[key] !== undefined) {
      return processEnv[key] as string;
    }
    const text = await fs.readFile(this.envPath, "utf8");
    const lines = parseEnvLines(text);
    for (let index = lines.length - 1; index >= 0; index--) {
      const line = (lines[index] as { text: string }).text;
      if (assignedKey(line) === key) {
        const value = assignedValue(line);
        return value === "" ? (this.defaults[key] ?? null) : value;
      }
    }
    return this.defaults[key] ?? null;
  }

  private async imageFor(
    service: string,
    processEnv: Readonly<Record<string, string>> = {},
  ): Promise<string | null> {
    if (service === "updater") {
      if (this.updaterImage === "follows") {
        const key = this.config.services[0]?.imageVar ?? "APP_IMAGE";
        return await this.envValue(key, processEnv);
      }
      return "ghcr.io/restow-backup/cicd-updater:1.0.0";
    }
    const managed = this.config.services.find((candidate) => candidate.name === service);
    if (!managed) {
      return this.containers.get(service)?.image ?? null;
    }
    if (!this.honoursVariables) {
      return `hardcoded/${service}:1`;
    }
    return await this.envValue(managed.imageVar, processEnv);
  }

  async composeImages(
    env: Readonly<Record<string, string>>,
  ): Promise<Record<string, string | null>> {
    this.hit("composeImages", Object.keys(env).length > 0 ? "probe" : "");
    const result: Record<string, string | null> = {};
    for (const service of [...this.config.services.map((s) => s.name), "db", "updater"]) {
      result[service] = await this.imageFor(service, env);
    }
    return result;
  }

  async hostPlatform(): Promise<Platform | null> {
    return this.platform;
  }

  async pull(ref: string): Promise<void> {
    this.hit("pull", ref);
    const failure = this.registry.get(ref);
    if (failure) {
      throw new PullError(failure, `registry says ${failure} for ${ref}`);
    }
    const digest = ref.slice(ref.indexOf("@") + 1);
    this.localImages.set(
      ref,
      this.pulledInfo.get(ref) ?? {
        id: digest,
        repoDigests: [ref],
        labels: {},
      },
    );
  }

  async inspectImage(ref: string): Promise<ImageInfo | null> {
    this.hit("inspectImage", ref);
    // A written reference `repo:tag@digest` resolves like `repo@digest`.
    const byDigest = ref.includes("@")
      ? `${(ref.split("@")[0] ?? "").replace(/:[^/:]+$/, "")}@${ref.split("@")[1]}`
      : ref;
    return this.localImages.get(ref) ?? this.localImages.get(byDigest) ?? null;
  }

  async stop(services: readonly string[], timeoutSeconds: number): Promise<void> {
    this.hit("stop", `${services.join(",")} -t ${timeoutSeconds}`);
    for (const name of services) {
      const container = this.containers.get(name);
      if (container) {
        container.state = "exited";
        container.exitCode = 0;
      }
    }
  }

  async up(services: readonly string[]): Promise<void> {
    this.hit("up", services.join(","));
    for (const name of services) {
      const image = (await this.imageFor(name)) ?? `${name}:none`;
      const existing = this.containers.get(name);
      const recreate = !existing || existing.image !== image || existing.state !== "running";
      if (!recreate) {
        continue;
      }
      const container: FakeContainer = {
        image,
        state: "running",
        exitCode: null,
        health: null,
        polls: 0,
      };
      const behavior = this.appBehavior.get(image);
      this.schema += behavior?.migrates ?? 0;
      if (behavior?.kind === "crash") {
        container.state = "restarting";
        container.exitCode = 1;
      }
      this.containers.set(name, container);
    }
  }

  async runOnce(spec: {
    service: string;
    argv: readonly string[];
    env: Readonly<Record<string, string>>;
    name: string;
    timeoutSeconds: number;
  }): Promise<RunOnceResult> {
    this.hit("runOnce", `${spec.name} ${spec.service} ${spec.argv.join(" ")}`);
    const image = (await this.imageFor(spec.service, spec.env)) ?? "";
    const behavior = this.migrateBehavior.get(image) ?? {};
    this.schema += behavior.migrates ?? 0;
    if (behavior.timesOut) {
      return { exitCode: 124, outputTail: "migration still running", timedOut: true };
    }
    const exitCode = behavior.exitCode ?? 0;
    return {
      exitCode,
      outputTail: exitCode === 0 ? "migrated" : "error: relation already exists",
      timedOut: false,
    };
  }

  async removeContainer(name: string): Promise<void> {
    this.hit("removeContainer", name);
  }

  async serviceStates(): Promise<ServiceState[]> {
    this.hit("serviceStates");
    return [...this.containers.entries()].map(([service, container]) => ({
      service,
      state: container.state,
      health: container.health,
      exitCode: container.exitCode,
      image: container.image,
    }));
  }

  async logsTail(service: string, lines: number): Promise<string> {
    this.hit("logsTail", `${service} ${lines}`);
    return "Error: migration 0042 failed: relation already exists";
  }

  async runningImageLabel(service: string, label: string): Promise<string | null> {
    const image = this.containers.get(service)?.image;
    return image ? (this.imageLabels.get(image)?.[label] ?? null) : null;
  }

  async pruneImages(input: {
    repositories: readonly string[];
    keep: readonly string[];
    keepCount: number;
  }): Promise<string[]> {
    this.hit("pruneImages");
    this.prunes.push(input);
    return [];
  }

  async build(spec: BuildSpec): Promise<void> {
    this.hit("build", `${spec.tag}`);
    this.builds.push(spec);
    this.localImages.set(spec.tag, { id: digestOf(spec.tag), repoDigests: [], labels: {} });
  }

  async removeLeftovers(): Promise<void> {
    this.hit("removeLeftovers");
  }

  /** What the app (the first service of the app group) answers to its health check now. */
  appAnswer(service: string): AppCheckResult {
    const found = this.containers.get(service);
    if (found?.state !== "running") {
      return { healthy: false, version: null, detail: `${service} is not running` };
    }
    const container = found as FakeContainer;
    const behavior = this.appBehavior.get(container.image) ?? { kind: "ready" as const };
    container.polls += 1;
    if (behavior.kind !== "ready" || container.polls <= (behavior.afterPolls ?? 0)) {
      return { healthy: false, version: null, detail: `${service} is starting` };
    }
    return {
      healthy: true,
      version: behavior.reportsVersion ?? tagOf(container.image),
      detail: null,
    };
  }
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export class FakeHooks implements Hooks {
  readonly probe: MigrationProbe & { failures: number[]; reads: number };
  /** Scripted results per check (by url or service), consumed in order; missing = ok. */
  readonly checkResults = new Map<string, CheckResult[]>();
  readonly checks: CheckSpec[] = [];

  constructor(
    private readonly ops: FakeDockerOps,
    private readonly config: UpdaterConfig,
  ) {
    const world = ops;
    this.probe = {
      configured: config.hooks.migrationProbe.type !== "none",
      failures: [],
      reads: 0,
      async read(): Promise<string> {
        const index = this.reads++;
        if (this.failures.includes(index)) {
          throw new ProbeError("psql: could not connect to server");
        }
        return `${world.schema}#fingerprint`;
      },
    };
  }

  get appCheckConfigured(): boolean {
    return this.config.hooks.health.type !== "none";
  }

  get appReportsVersion(): boolean {
    const health = this.config.hooks.health;
    return (
      (health.type === "http" && health.http?.versionJsonPath !== null) ||
      (health.type === "command" && health.command?.versionFromStdout === true)
    );
  }

  private appService(): string {
    const health = this.config.hooks.health;
    const groups = [...new Set(this.config.services.map((service) => service.startOrder))].sort(
      (a, b) => a - b,
    );
    const group = health.afterGroup ?? groups[0];
    return this.config.services.find((service) => service.startOrder === group)?.name ?? "api";
  }

  async appCheck(): Promise<AppCheckResult | null> {
    if (!this.appCheckConfigured) {
      return null;
    }
    const answer = this.ops.appAnswer(this.appService());
    return this.appReportsVersion ? answer : { ...answer, version: null };
  }

  async check(spec: CheckSpec): Promise<CheckResult> {
    this.checks.push(spec);
    const key = spec.type === "http" ? spec.url : spec.service;
    const queue = this.checkResults.get(key);
    if (queue && queue.length > 0) {
      return queue.length > 1 ? (queue.shift() as CheckResult) : (queue[0] as CheckResult);
    }
    return { ok: true, detail: "ok" };
  }
}

// ---------------------------------------------------------------------------
// Backup runner, verifier, catalog, source builder, preflight
// ---------------------------------------------------------------------------

export class FakeBackupRunner implements BackupRunner {
  readonly runs: { runId: string; toVersion: string }[] = [];
  failWith: { kind: BackupFailureKind; detail: string } | null = null;
  /** Wait for an abort (an interruptible backup that is still dumping). */
  hangUntilAborted = false;
  content = Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(2048, 7)]);

  constructor(
    readonly type: UpdaterConfig["hooks"]["backup"]["type"],
    private readonly store: BackupStore,
    readonly interruptible = type === "postgres",
  ) {}

  async create(input: Parameters<BackupRunner["create"]>[0]): Promise<BackupRecord> {
    this.runs.push({ runId: input.runId, toVersion: input.toVersion });
    if (this.type === "none") {
      throw new Error("no backup configured");
    }
    await this.store.ensureDirectory();
    const name = this.store.fileName(input.at, input.fromVersion, input.toVersion, this.type);
    const partial = this.store.partialPathOf(name);
    await fs.writeFile(partial, this.content, { mode: 0o600 });
    if (this.hangUntilAborted) {
      await new Promise<void>((resolve) => {
        if (input.signal.aborted) {
          resolve();
          return;
        }
        input.signal.addEventListener("abort", () => resolve(), { once: true });
      });
    }
    if (this.interruptible && input.signal.aborted) {
      await fs.rm(partial, { force: true });
      throw new BackupError("aborted", "terminated pg_dump (application name of this run)");
    }
    if (this.failWith) {
      await fs.rm(partial, { force: true });
      throw new BackupError(this.failWith.kind, this.failWith.detail);
    }
    await input.onStage("verifying");
    await fs.rename(partial, this.store.pathOf(name));
    const sha256 = createHash("sha256").update(this.content).digest("hex");
    await this.store.writeMetadata(name, {
      type: this.type,
      bytes: this.content.length,
      sha256,
      createdAt: input.at.toISOString(),
      runId: input.runId,
      fromVersion: input.fromVersion,
      toVersion: input.toVersion,
      verified: true,
      encrypted: false,
    });
    return { file: name, bytes: this.content.length, sha256, type: this.type, encrypted: false };
  }
}

export class FakeVerifier implements Verifier {
  readonly documentChecks: { tag: string; version: string; bundle: boolean }[] = [];
  readonly imageChecks: { ref: string; tag: string; version: string }[] = [];
  /** Outcome of the document verification (null: verified). */
  documentFailure: VerifyFailure | null = null;
  /** Outcome per image reference (missing: verified). */
  readonly imageFailures = new Map<string, VerifyFailure>();
  readonly missingImages = new Set<string>();

  constructor(readonly mode: "keyless" | "key" | "none") {}

  async verifyDocument(input: {
    document: Uint8Array;
    bundle: Uint8Array | null;
    tag: string;
    version: string;
  }) {
    this.documentChecks.push({
      tag: input.tag,
      version: input.version,
      bundle: input.bundle !== null,
    });
    if (this.mode === "none") {
      return "not_checked" as const;
    }
    if (!input.bundle) {
      throw new VerifyError("signature_missing", "release.json has no Sigstore bundle");
    }
    if (this.documentFailure) {
      throw new VerifyError(
        this.documentFailure,
        "the bundle does not verify for the expected identity",
      );
    }
    return "verified" as const;
  }

  async verifyImage(input: { ref: string; tag: string; version: string }) {
    this.imageChecks.push(input);
    if (this.mode === "none") {
      return "not_checked" as const;
    }
    const failure = this.imageFailures.get(input.ref);
    if (failure) {
      throw new VerifyError(failure, `cosign: ${failure} for ${input.ref}`);
    }
    return "verified" as const;
  }

  async imageExists(ref: string) {
    return this.missingImages.has(ref)
      ? { exists: false, error: "image_not_found" as const }
      : { exists: true, error: null };
  }
}

export class FakeCatalog implements ReleaseCatalog {
  readonly releases = new Map<string, FetchedRelease>();
  readonly stored = new Map<string, { document: Uint8Array; bundle: Uint8Array | null }>();
  listError: CatalogError | null = null;
  fetches: string[] = [];
  prunes = 0;

  constructor(readonly project: string | null = "github.com/acme/notes") {}

  add(
    version: string,
    document: Uint8Array | null,
    options: { bundle?: Uint8Array | null; prerelease?: boolean; tag?: string } = {},
  ): void {
    const tag = options.tag ?? `v${version}`;
    this.releases.set(version, {
      entry: {
        version,
        tag,
        prerelease: options.prerelease ?? version.includes("-"),
        publishedAt: "2026-11-01T12:00:00.000Z",
        notesUrl: `https://github.com/acme/notes/releases/tag/${tag}`,
        hasDocument: document !== null,
      },
      document,
      bundle:
        options.bundle === undefined
          ? document
            ? Buffer.from('{"bundle":true}')
            : null
          : options.bundle,
    });
  }

  async list(): Promise<CatalogEntry[]> {
    if (this.listError) {
      throw this.listError;
    }
    return [...this.releases.values()]
      .map((release) => release.entry)
      .sort((a, b) => compareVersions(b.version, a.version));
  }

  async fetch(version: string): Promise<FetchedRelease> {
    this.fetches.push(version);
    if (this.listError) {
      throw this.listError;
    }
    const release = this.releases.get(version);
    if (!release) {
      throw new CatalogError("release_not_found", null, `Version ${version} is not in the feed.`);
    }
    return structuredClone(release);
  }

  async store(version: string, document: Uint8Array, bundle: Uint8Array | null): Promise<void> {
    this.stored.set(version, {
      document: Buffer.from(document),
      bundle: bundle ? Buffer.from(bundle) : null,
    });
  }

  async load(version: string) {
    const stored = this.stored.get(version);
    return stored
      ? {
          document: Buffer.from(stored.document),
          bundle: stored.bundle ? Buffer.from(stored.bundle) : null,
        }
      : null;
  }

  async prune(): Promise<void> {
    this.prunes += 1;
  }
}

export class FakeSourceBuilder implements SourceBuilder {
  allowedValue = false;
  failWith: { kind: SourceFailureKind; detail: string } | null = null;
  purges = 0;
  readonly builds: { version: string; tag: string; keys: readonly string[] }[] = [];

  constructor(private readonly project: string) {}

  allowed(): boolean {
    return this.allowedValue;
  }

  async build(input: Parameters<SourceBuilder["build"]>[0]): Promise<Record<string, string>> {
    this.builds.push({ version: input.version, tag: input.tag, keys: input.imageKeys });
    await input.onStage("downloading", 0, input.imageKeys.length);
    if (this.failWith) {
      throw new SourceError(this.failWith.kind, this.failWith.detail);
    }
    const out: Record<string, string> = {};
    for (const [index, key] of input.imageKeys.entries()) {
      await input.onStage("building", index + 1, input.imageKeys.length);
      out[key] = `cicd-updater.local/${this.project}/${key}:${input.version}`;
    }
    return out;
  }

  async purge(): Promise<void> {
    this.purges += 1;
  }
}

export class FakePreflight implements PreflightPort {
  blockers: Blocker[] = [];
  /** Blockers only the deep check (at the start of a run) finds. */
  deepBlockers: Blocker[] = [];
  warnings: Warning[] = [];
  invalidations = 0;

  constructor(private readonly clock: Clock) {}

  private build(deep: boolean): Capabilities {
    const blockers = deep ? [...this.blockers, ...this.deepBlockers] : [...this.blockers];
    return {
      ready: blockers.length === 0,
      blockers,
      warnings: [...this.warnings],
      docker: {
        serverVersion: "27.5.1",
        apiVersion: "1.47",
        architecture: "linux/amd64",
        imageStore: "classic",
      },
      compose: { projectName: "notes", projectDir: "/opt/notes", files: [], envFile: ".env" },
      backups: [],
      checkedAt: this.clock.now().toISOString(),
    };
  }

  async get(refresh = false): Promise<Capabilities> {
    return this.build(refresh);
  }

  async check(options: { deep: boolean }): Promise<Capabilities> {
    return this.build(options.deep);
  }

  invalidate(): void {
    this.invalidations += 1;
  }
}

// ---------------------------------------------------------------------------
// Release documents
// ---------------------------------------------------------------------------

export const IMAGE_REPOSITORIES: Record<string, string> = {
  app: "ghcr.io/acme/notes",
  web: "ghcr.io/acme/notes-web",
};

/** The digest the fake release of `version` publishes for an image key. */
export function releaseDigest(key: string, version: string): string {
  return digestOf(`${key}:${version}`);
}

/** The reference the sidecar writes for an image key of `version`. */
export function writtenRef(key: string, version: string): string {
  return `${IMAGE_REPOSITORIES[key]}:${version}@${releaseDigest(key, version)}`;
}

export function pullRef(key: string, version: string): string {
  return `${IMAGE_REPOSITORIES[key]}@${releaseDigest(key, version)}`;
}

export function releaseDocument(
  version: string,
  change: (doc: Record<string, any>) => void = () => undefined,
  keys: readonly string[] = ["app", "web"],
): Buffer {
  const images: Record<string, unknown> = {};
  for (const key of keys) {
    images[key] = {
      repository: IMAGE_REPOSITORIES[key] ?? `ghcr.io/acme/${key}`,
      tag: version,
      digest: releaseDigest(key, version),
      platforms: ["linux/amd64", "linux/arm64"],
    };
  }
  const doc: Record<string, any> = {
    schemaVersion: 1,
    project: "github.com/acme/notes",
    version,
    tag: `v${version}`,
    channel: version.includes("-") ? "beta" : "stable",
    commit: "4f1c0b6e2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b",
    createdAt: "2026-11-01T12:00:00Z",
    notesUrl: `https://github.com/acme/notes/releases/tag/v${version}`,
    images,
    upgrade: {
      minimumFromVersion: null,
      manualSteps: { required: false, summary: null, url: null },
    },
    requires: { updater: ">=1.0.0" },
    signing: { mode: "keyless", tool: "cosign", toolVersion: "3.1.3" },
  };
  change(doc);
  return Buffer.from(JSON.stringify(doc, null, 2));
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

export const DEFAULT_ENV = [
  "# Notes configuration",
  "POSTGRES_PASSWORD=super-secret-db-password",
  "NOTES_DOMAIN=notes.example.com",
  "",
  "APP_IMAGE=ghcr.io/acme/notes:1.0.0",
  "# keep this comment",
  'WEB_IMAGE="ghcr.io/acme/notes-web:1.0.0" # pinned by hand',
  "SESSION_SECRET=abcdefghijklmnopqrstuvwxyz",
  "",
].join("\n");

export const OLD_APP = "ghcr.io/acme/notes:1.0.0";
export const OLD_WEB = "ghcr.io/acme/notes-web:1.0.0";

/** The default configuration of the harness (a Node app with Postgres, an edge last). */
export function baseConfig(projectDir: string): UpdaterConfigInput {
  return {
    version: 1,
    compose: { projectDir, projectName: "notes" },
    release: { feed: { type: "github", url: "https://github.com/acme/notes" } },
    trust: {
      mode: "keyless",
      keyless: { github: { repository: "acme/notes", workflow: ".github/workflows/release.yml" } },
    },
    services: [
      { name: "api", image: "app", imageVar: "APP_IMAGE", startOrder: 1, stopBeforeUpdate: false },
      { name: "worker", image: "app", imageVar: "APP_IMAGE", startOrder: 2 },
      {
        name: "web",
        image: "web",
        imageVar: "WEB_IMAGE",
        startOrder: 3,
        stopBeforeUpdate: false,
        stopOnAttention: false,
      },
    ],
    hooks: {
      backup: { type: "postgres", service: "db" },
      migrationProbe: { type: "postgres", service: "db", preset: "node-pg-migrate" },
      health: {
        type: "http",
        http: { url: "http://api:3000/healthz", versionJsonPath: "$.version" },
      },
    },
  };
}

export interface HarnessOptions {
  env?: string;
  /** Change the configuration input before it is validated. */
  configure?: (config: UpdaterConfigInput) => void;
  /** Reuse the directories and world of another harness (restart). */
  reuse?: Harness;
  updaterVersion?: string;
}

export interface Harness {
  dir: string;
  projectDir: string;
  stateDir: string;
  config: UpdaterConfig;
  clock: FakeClock;
  ops: FakeDockerOps;
  hooks: FakeHooks;
  backup: FakeBackupRunner;
  backups: BackupStore;
  verifier: FakeVerifier;
  catalog: FakeCatalog;
  source: FakeSourceBuilder;
  preflight: FakePreflight;
  store: StatusStore;
  envFile: EnvFile;
  running: RunningVersionResolver;
  releases: ReleaseService;
  engine: UpdateEngine;
  redactor: Redactor;
  logger: ReturnType<typeof memoryLogger>;
  readEnv(): Promise<string>;
  /** Publish a release in the fake feed and registry. */
  publish(version: string, change?: (doc: Record<string, any>) => void): Buffer;
  /** Make the app behave like this when it runs the image of `version`. */
  appAt(version: string, behavior: AppBehavior): void;
  /** Recreate everything but the world on the same state directory (a sidecar restart). */
  restart(): Promise<Harness>;
  cleanup(): Promise<void>;
}

export async function createHarness(options: HarnessOptions = {}): Promise<Harness> {
  const reuse = options.reuse;
  const dir = reuse?.dir ?? (await fs.mkdtemp(path.join(os.tmpdir(), "cicd-updater-engine-")));
  const projectDir = path.join(dir, "project");
  const stateDir = path.join(dir, "state");
  await fs.mkdir(projectDir, { recursive: true });
  await fs.mkdir(stateDir, { recursive: true });
  const envPath = path.join(projectDir, ".env");
  if (!reuse) {
    await fs.writeFile(envPath, options.env ?? DEFAULT_ENV, { mode: 0o600 });
  }
  const input = baseConfig(projectDir);
  options.configure?.(input);
  const validated = validateConfig(input);
  if (!validated.ok) {
    throw new Error(`invalid test configuration: ${JSON.stringify(validated.problems)}`);
  }
  const config = validated.config;
  const configHash = createHash("sha256").update(canonicalJson(config)).digest("hex");

  const redactor = new Redactor(config.logging.redactPatterns);
  const logger = memoryLogger(redactor);
  const clock = reuse?.clock ?? new FakeClock();
  const ops = reuse?.ops ?? new FakeDockerOps(envPath, config);
  if (!reuse) {
    ops.installAt({ app: OLD_APP, web: OLD_WEB }, "1.0.0");
  }
  const hooks = new FakeHooks(ops, config);
  const backups = new BackupStore(path.join(stateDir, "backups"), "notes");
  const backup = reuse?.backup ?? new FakeBackupRunner(config.hooks.backup.type, backups);
  const verifier = reuse?.verifier ?? new FakeVerifier(config.trust.mode);
  const catalog = reuse?.catalog ?? new FakeCatalog();
  const source = reuse?.source ?? new FakeSourceBuilder("notes");
  const preflight = reuse?.preflight ?? new FakePreflight(clock);
  const store = await StatusStore.open(stateDir, logger, () => clock.now(), config.state);
  const envFile = new EnvFile(envPath, writableKeys(config));
  const running = new RunningVersionResolver({ config, hooks, ops, store, envFile, clock });
  const updaterVersion = options.updaterVersion ?? "1.0.0";
  const releases = new ReleaseService({
    config,
    catalog,
    verifier,
    ops,
    envFile,
    running,
    updaterVersion,
    clock,
    redactor,
  });
  const engine = new UpdateEngine({
    config,
    configHash,
    updaterVersion,
    project: { name: "notes", selfService: "updater" },
    store,
    ops,
    hooks,
    backup,
    backups,
    verifier,
    catalog,
    releases,
    source,
    envFile,
    preflight,
    running,
    clock,
    redactor,
    logger,
  });

  const harness: Harness = {
    dir,
    projectDir,
    stateDir,
    config,
    clock,
    ops,
    hooks,
    backup,
    backups,
    verifier,
    catalog,
    source,
    preflight,
    store,
    envFile,
    running,
    releases,
    engine,
    redactor,
    logger,
    readEnv: () => fs.readFile(envPath, "utf8"),
    publish(version, change) {
      const document = releaseDocument(version, change);
      catalog.add(version, document);
      ops.appBehavior.set(writtenRef("app", version), { kind: "ready", reportsVersion: version });
      return document;
    },
    appAt(version, behavior) {
      ops.appBehavior.set(writtenRef("app", version), behavior);
    },
    restart: async () => {
      // The old process is gone: its timers and its next steps must not run any more.
      await engine.shutdown();
      return await createHarness({ ...options, reuse: harness });
    },
    cleanup: async () => {
      await engine.shutdown();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
  return harness;
}

/** A schedule request as the server passes it to the engine. */
export function scheduleRequest(
  version: string,
  overrides: Partial<ParsedScheduleRequest> = {},
): ParsedScheduleRequest {
  return {
    version,
    mode: "image",
    leadSeconds: 0,
    requestedBy: { id: "user-1", label: "admin@example.com" },
    ...overrides,
  };
}

/** Wait until the engine has no running run (and no scheduled run that is due). */
export async function settle(engine: UpdateEngine): Promise<void> {
  for (let attempt = 0; attempt < 20_000; attempt++) {
    await engine.settled();
    const phase = engine.view().phase;
    if (phase !== "running") {
      return;
    }
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("The engine did not settle.");
}

/** Wait until the fake world has seen a call that starts with `prefix`. */
export async function waitForCall(ops: FakeDockerOps, prefix: string, count = 1): Promise<void> {
  for (let attempt = 0; attempt < 1000; attempt++) {
    if (ops.calls.filter((call) => call.startsWith(prefix)).length >= count) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`No call ${prefix} was made.`);
}

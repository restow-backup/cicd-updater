import { randomBytes } from "node:crypto";
import {
  type Actor,
  type BackupRef,
  blockerFailureCode,
  type EventsView,
  emptyRunContext,
  type FailureCode,
  initialSteps,
  type JournalAction,
  type JournalEvent,
  type Message,
  type MessageCode,
  type Outcome,
  type ParsedScheduleRequest,
  type Phase,
  progressOf,
  type Recovery,
  type ReleaseDocument,
  type Run,
  type RunContext,
  type RunSummary,
  type Step,
  type StepId,
  sameVersion,
  startGroups,
  stepOrder,
  type UpdaterConfig,
  writableKeys,
} from "@cicd-updater/protocol";
import type { BackupStore } from "./backups.js";
import { type CapturedEnv, type EnvFile, sameCapture } from "./env-file.js";
import { EngineError, ShutdownSignal } from "./errors.js";
import { LOG_TEXT, type Params } from "./log-text.js";
import {
  BackupError,
  type BackupRunner,
  type Clock,
  type DockerOps,
  type Hooks,
  type Logger,
  OpsError,
  type PreflightPort,
  PullError,
  type ReleaseCatalog,
  type SourceBuilder,
  SourceError,
  StepFailure,
  type TimerHandle,
  type Verifier,
  VerifyError,
} from "./ports.js";
import { renderRecoveryCommands } from "./recovery.js";
import { clip, type Redactor, sensitiveEnvValues } from "./redact.js";
import {
  buildImagePlan,
  buildSourcePlan,
  type Plan,
  type ReleaseService,
  sha256Hex,
} from "./release-check.js";
import type { RunningVersionResolver } from "./running-version.js";
import type { StatusStore } from "./store.js";

/**
 * The update state machine (design 5). Rules kept everywhere:
 *
 *   - The state is written to status.json before the side effect that follows it.
 *   - A failure is never guessed: the previous version is started again only
 *     when it is certain that the data was not changed by the new version (5.6).
 *   - After a restart the sidecar never starts or stops application services on
 *     its own (5.8).
 *   - Housekeeping never turns a successful update into a failed one.
 *   - Every message is a code with parameters; the English log line comes from
 *     one table (LOG_TEXT) and passes the redactor.
 *
 * Derived from Restow's updater engine (Apache-2.0), generalized to a
 * configuration instead of fixed service names.
 */

const LOG_LINES = 200;
const LOG_LINE_CHARS = 400;
const DETAIL_CHARS = 2000;
const HALF_DETAIL = 950;
const RELEASES_KEPT = 5;

export interface EngineDeps {
  config: UpdaterConfig;
  configHash: string;
  updaterVersion: string;
  /** The Compose project and the sidecar's own service (for recovery commands and the Compose probe). */
  project: { name: string; selfService: string | null };
  store: StatusStore;
  ops: DockerOps;
  hooks: Hooks;
  backup: BackupRunner;
  backups: BackupStore;
  verifier: Verifier;
  catalog: ReleaseCatalog;
  releases: ReleaseService;
  source: SourceBuilder;
  envFile: EnvFile;
  preflight: PreflightPort;
  running: RunningVersionResolver;
  clock: Clock;
  redactor: Redactor;
  logger: Logger;
}

export interface EngineView {
  phase: Phase;
  run: Run | null;
  history: RunSummary[];
  events: JournalEvent[];
}

interface Msg {
  code: MessageCode;
  /** What clients receive (also anonymous visitors without versions): versions, codes, counts. */
  params?: Params;
  /** Facts for the operator's log line only (images, files, services). */
  details?: Params;
}

interface Exec {
  target: string;
  tag: string;
  document: ReleaseDocument | null;
  plan: Plan;
  abort: AbortController;
  /** Services `compose up` was run for with a new image. */
  started: Set<string>;
}

/** Fallback failure code for an unexpected error, per step. */
const FALLBACK_CODE: Record<StepId, FailureCode> = {
  prepare: "prepare.compose_invalid",
  fetch: "fetch.pull_failed",
  backup: "backup.failed",
  stop: "stop.failed",
  migrate: "migrate.failed",
  start: "start.failed",
  health: "health.unhealthy",
  smoke: "smoke.failed",
  finish: "smoke.failed",
};

function describeError(error: unknown): string {
  if (error instanceof OpsError || error instanceof PullError || error instanceof BackupError) {
    return error.detail ? `${error.message} ${error.detail}` : error.message;
  }
  if (error instanceof VerifyError || error instanceof SourceError) {
    return `${error.message}`;
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

export class UpdateEngine {
  private timer: TimerHandle | null = null;
  private execution: Promise<void> | null = null;
  private exec: Exec | null = null;
  private shuttingDown = false;
  private readonly shutdownController = new AbortController();

  constructor(private readonly deps: EngineDeps) {}

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /** Load-time recovery (design 5.8). Call once, before the server accepts requests. */
  async init(): Promise<void> {
    const { store, clock, logger, config } = this.deps;
    await this.deps.source
      .purge()
      .catch((error: Error) => logger.warn(`Could not remove leftover sources: ${error.message}`));
    await this.deps.backups
      .purgePartials()
      .catch((error: Error) => logger.warn(`Could not remove partial backups: ${error.message}`));
    await this.deps.ops
      .removeLeftovers()
      .catch((error: Error) =>
        logger.warn(`Could not remove leftover helper containers: ${error.message}`),
      );
    await this.pruneBackups();

    const state = store.state;
    const run = state.run;
    if (state.phase === "scheduled" && run) {
      const late = clock.now().getTime() - Date.parse(run.startsAt);
      if (late < 0) {
        this.armTimer(Date.parse(run.startsAt));
      } else if (late <= config.schedule.lateStartToleranceSeconds * 1000) {
        logger.info(
          `Starting the scheduled update ${run.id} now (it was due ${Math.round(late / 1000)} s ago).`,
        );
        await this.begin();
      } else {
        logger.warn(
          `The scheduled update ${run.id} is ${Math.round(late / 60_000)} minutes overdue; it is not started.`,
        );
        await this.finalizeFailure(
          new StepFailure(
            "missed_start",
            null,
            "The sidecar was not running at the scheduled start.",
          ),
          "unchanged",
          null,
          false,
        );
      }
    } else if (state.phase === "running" && run) {
      logger.warn(`The update ${run.id} was running when the sidecar stopped.`);
      await this.resumeInterrupted();
    }
  }

  view(): EngineView {
    const { phase, run, history, events } = this.deps.store.snapshot();
    return { phase, run, history, events };
  }

  /** Resolves when the current run (if any) has ended. */
  settled(): Promise<void> {
    return this.execution ?? Promise.resolve();
  }

  /** Schedule a run (POST /v1/runs). Nothing unverifiable is ever announced. */
  async schedule(request: ParsedScheduleRequest, via: "api" | "cli"): Promise<void> {
    const { config, clock, store } = this.deps;
    const now = clock.now();
    const startsAtMs = this.validateStart(request.leadSeconds, request.startsAt, now);
    if (request.mode === "source" && !this.deps.source.allowed()) {
      throw new EngineError(
        "source_not_allowed",
        "Source mode is off, or the configured feed repository is not in source.allowlist.",
      );
    }
    this.assertFree();
    const capabilities = await this.deps.preflight.get(true);
    if (!capabilities.ready) {
      throw new EngineError("blocked", "The updater cannot start an update now.", {
        blockers: capabilities.blockers,
      });
    }
    const { result, prepared } = await this.deps.releases.verification(
      request.version,
      request.mode,
      { useCache: false },
    );
    if (!prepared) {
      throw new Error("verification returned no release");
    }
    const expected = request.expect?.releaseSha256;
    if (expected !== undefined && expected !== prepared.sha256) {
      throw new EngineError(
        "release_mismatch",
        "The release document differs from the one that was shown.",
      );
    }
    const unverifiable = result.images.filter(
      (image) => image.signature === "failed" || image.exists === false,
    );
    if (unverifiable.length > 0) {
      throw new EngineError("release_unverifiable", "An image of the release does not verify.", {
        checks: result,
      });
    }
    if (result.refusals.length > 0) {
      throw new EngineError("release_refused", "The release cannot be installed now.", {
        reasons: result.refusals as never,
      });
    }
    if (prepared.documentBytes) {
      await this.deps.catalog.store(request.version, prepared.documentBytes, prepared.bundle);
    }
    const running = await this.deps.running.detect();

    // From here on nothing awaits until the state is changed: two requests cannot both pass.
    this.assertFree();
    const actor: Actor = {
      id: request.requestedBy.id ?? null,
      label: request.requestedBy.label,
      via,
    };
    if (store.state.phase === "succeeded" || store.state.phase === "failed") {
      const previous = store.state.run;
      if (previous) {
        this.journal("update.acknowledged", previous, actor, { implicit: true });
      }
    }
    const nowMs = clock.now().getTime();
    const runId = `r-${nowMs}-${randomBytes(2).toString("hex")}`;
    const order = stepOrder(config.hooks.backup.quiesce);
    const run: Run = {
      id: runId,
      mode: request.mode,
      fromVersion: running.version,
      targetVersion: request.version,
      targetTag: prepared.tag,
      notesUrl: prepared.document?.notesUrl ?? prepared.entry.notesUrl ?? null,
      release: {
        sha256: prepared.sha256,
        channel: prepared.document?.channel ?? (request.version.includes("-") ? "beta" : "stable"),
        document: prepared.documentStatus,
      },
      trustMode: this.deps.verifier.mode,
      verification: {
        signatures: request.mode === "source" ? "not_applicable" : null,
        digests: request.mode === "source" ? "not_applicable" : null,
      },
      requestedBy: actor,
      scheduledAt: new Date(nowMs).toISOString(),
      startsAt: new Date(Math.max(startsAtMs, nowMs)).toISOString(),
      leadSeconds: request.startsAt !== undefined ? null : (request.leadSeconds ?? 0),
      startedAt: null,
      finishedAt: null,
      cancelled: false,
      cancelledAt: null,
      abortRequestedAt: null,
      outcome: null,
      step: null,
      steps: initialSteps(order, this.skippedSteps()),
      progress: 0,
      message: null,
      failure: null,
      recovery: null,
      images: {},
      configHash: this.deps.configHash,
      log: [],
    };
    run.progress = progressOf(run.steps);
    store.state.run = run;
    store.state.runContext = emptyRunContext();
    store.state.phase = "scheduled";
    this.setMessage({
      code: "run.scheduled",
      params: { version: run.targetVersion, startsAt: run.startsAt },
    });
    this.journal("update.scheduled", run, actor, {
      mode: run.mode,
      fromVersion: run.fromVersion,
      startsAt: run.startsAt,
      trustMode: run.trustMode,
      releaseSha256: run.release.sha256,
    });
    await store.save();
    this.deps.preflight.invalidate();

    if (Date.parse(run.startsAt) <= clock.now().getTime()) {
      await this.begin();
    } else {
      this.armTimer(Date.parse(run.startsAt));
    }
  }

  /** Move a scheduled run (PATCH /v1/runs/{id}). */
  async reschedule(
    runId: string,
    when: { leadSeconds?: number | undefined; startsAt?: string | undefined },
    actor: Actor,
  ): Promise<void> {
    const { store, clock } = this.deps;
    const run = this.requireRun(runId);
    if (store.state.phase !== "scheduled") {
      throw new EngineError("not_scheduled", "Only a scheduled run can be moved.");
    }
    const now = clock.now();
    const startsAtMs = this.validateStart(when.leadSeconds, when.startsAt, now);
    run.startsAt = new Date(Math.max(startsAtMs, now.getTime())).toISOString();
    run.leadSeconds = when.startsAt !== undefined ? null : (when.leadSeconds ?? 0);
    this.setMessage({
      code: "run.rescheduled",
      params: { version: run.targetVersion, startsAt: run.startsAt },
    });
    this.journal("update.rescheduled", run, actor, { startsAt: run.startsAt });
    await store.save();
    if (Date.parse(run.startsAt) <= clock.now().getTime()) {
      await this.begin();
    } else {
      this.armTimer(Date.parse(run.startsAt));
    }
  }

  /**
   * Cancel a scheduled run, or abort a running one before the point of no
   * return (design 5.7). Returns "cancelled" or "abort_requested".
   */
  async cancel(runId: string, actor: Actor): Promise<"cancelled" | "abort_requested"> {
    const { store, clock } = this.deps;
    const state = store.state;
    const run = this.requireRun(runId);
    if (state.phase === "scheduled") {
      this.clearTimer();
      run.cancelled = true;
      run.cancelledAt = clock.now().toISOString();
      run.finishedAt = run.cancelledAt;
      run.outcome = null;
      this.log(run, "The scheduled update was cancelled.");
      this.journal("update.cancelled", run, actor, {});
      store.recordHistory(run);
      state.run = null;
      state.runContext = null;
      state.phase = "idle";
      await store.save();
      this.deps.preflight.invalidate();
      return "cancelled";
    }
    if (state.phase === "running") {
      if (this.context().ponrReached) {
        throw new EngineError(
          "point_of_no_return",
          "The update passed the point of no return and cannot be aborted.",
        );
      }
      if (run.abortRequestedAt === null) {
        run.abortRequestedAt = clock.now().toISOString();
        this.setMessage({ code: "run.aborting" });
        this.journal("update.abort_requested", run, actor, { step: run.step });
        await store.save();
      }
      this.exec?.abort.abort();
      return "abort_requested";
    }
    throw new EngineError("not_scheduled", "The run is neither scheduled nor running.");
  }

  /** Clear a finished run (it stays in the history). */
  async acknowledge(runId: string, actor: Actor): Promise<void> {
    const { store } = this.deps;
    const state = store.state;
    const run = this.requireRun(runId);
    if (state.phase === "scheduled" || state.phase === "running") {
      throw new EngineError("not_finished", "The run has not finished.");
    }
    this.journal("update.acknowledged", run, actor, {});
    state.run = null;
    state.runContext = null;
    state.phase = "idle";
    await store.save();
    this.deps.preflight.invalidate();
  }

  /** Journal events after a cursor (design 6.4). */
  eventsAfter(after: string | null, limit: number): EventsView {
    const events = this.deps.store.state.events;
    const oldest = events[0];
    let start = 0;
    let gap = false;
    if (after !== null) {
      start = events.findIndex((event) => event.id > after);
      if (start === -1) {
        start = events.length;
      }
      if (oldest && after < oldest.id) {
        const afterCounter = Number(after.split("-")[1]);
        const oldestCounter = Number(oldest.id.split("-")[1]);
        gap = (afterCounter + 1) % 1_000_000 !== oldestCounter;
      }
    }
    const slice = structuredClone(events.slice(start, start + limit));
    return { events: slice, next: slice.at(-1)?.id ?? null, gap };
  }

  /** Daily housekeeping: backup retention. */
  async housekeeping(): Promise<void> {
    if (this.deps.store.state.phase !== "running") {
      await this.pruneBackups();
    }
  }

  /** Stop timers and refuse to begin further steps; a waiting step stops at its next check. */
  async shutdown(): Promise<void> {
    this.shuttingDown = true;
    this.shutdownController.abort();
    this.clearTimer();
    await this.deps.store.flush();
  }

  // ---------------------------------------------------------------------------
  // Scheduling helpers
  // ---------------------------------------------------------------------------

  private validateStart(
    leadSeconds: number | undefined,
    startsAt: string | undefined,
    now: Date,
  ): number {
    const max = this.deps.config.schedule.maxLeadSeconds;
    if (leadSeconds !== undefined && startsAt !== undefined) {
      throw new EngineError("invalid_request", "leadSeconds and startsAt are exclusive.", {
        errors: [{ path: "startsAt", message: "leadSeconds and startsAt are exclusive" }],
      });
    }
    if (startsAt !== undefined) {
      const at = Date.parse(startsAt);
      if (Number.isNaN(at) || at < now.getTime() - 60_000 || at > now.getTime() + max * 1000) {
        throw new EngineError(
          "invalid_request",
          `startsAt must lie between now and now + ${max} seconds.`,
          {
            errors: [{ path: "startsAt", message: `must lie between now and now + ${max} s` }],
          },
        );
      }
      return at;
    }
    const lead = leadSeconds ?? 0;
    if (lead < 0 || lead > max) {
      throw new EngineError("invalid_request", `leadSeconds must lie between 0 and ${max}.`, {
        errors: [{ path: "leadSeconds", message: `must lie between 0 and ${max}` }],
      });
    }
    return now.getTime() + lead * 1000;
  }

  private assertFree(): void {
    const phase = this.deps.store.state.phase;
    if (phase === "scheduled" || phase === "running") {
      throw new EngineError("busy", "An update is already scheduled or running.");
    }
  }

  private requireRun(runId: string): Run {
    const run = this.deps.store.state.run;
    if (!run || run.id !== runId) {
      throw new EngineError("not_found", "There is no current run with this id.");
    }
    return run;
  }

  private skippedSteps(): Set<StepId> {
    const { hooks } = this.deps.config;
    const skipped = new Set<StepId>();
    if (hooks.backup.type === "none" && this.deps.config.rollback.policy !== "probe") {
      skipped.add("backup");
    }
    if (!this.deps.config.services.some((service) => service.stopBeforeUpdate)) {
      skipped.add("stop");
    }
    if (hooks.migrate === null) {
      skipped.add("migrate");
    }
    if (hooks.smoke.checks.length === 0) {
      skipped.add("smoke");
    }
    return skipped;
  }

  private armTimer(startsAtMs: number): void {
    this.clearTimer();
    const delay = Math.max(0, startsAtMs - this.deps.clock.now().getTime());
    this.timer = this.deps.clock.setTimer(() => {
      this.timer = null;
      this.begin().catch((error: Error) => {
        this.deps.logger.error(`The update could not be started: ${error.message}`);
      });
    }, delay);
  }

  private clearTimer(): void {
    this.timer?.cancel();
    this.timer = null;
  }

  /** scheduled -> running, then execute in the background. */
  private async begin(): Promise<void> {
    const { store, clock } = this.deps;
    const state = store.state;
    const run = state.run;
    if (state.phase !== "scheduled" || !run || this.shuttingDown) {
      return;
    }
    this.clearTimer();
    run.startedAt = clock.now().toISOString();
    run.configHash = this.deps.configHash;
    state.phase = "running";
    this.setMessage({ code: "run.starting", params: { version: run.targetVersion } });
    this.journal("update.started", run, run.requestedBy, {
      mode: run.mode,
      fromVersion: run.fromVersion,
      trustMode: run.trustMode,
      configHash: run.configHash,
    });
    await store.save();
    this.deps.preflight.invalidate();
    const exec: Exec = {
      target: run.targetVersion,
      tag: run.targetTag,
      document: null,
      plan: {},
      abort: new AbortController(),
      started: new Set(),
    };
    this.exec = exec;
    this.execution = this.execute(exec).finally(() => {
      this.execution = null;
      this.exec = null;
      this.deps.running.invalidate();
    });
  }

  // ---------------------------------------------------------------------------
  // The run
  // ---------------------------------------------------------------------------

  private async execute(exec: Exec): Promise<void> {
    try {
      for (const step of [...this.run().steps]) {
        if (step.id === "stop") {
          await this.reachPonr();
        }
        if (this.stepOf(step.id).status === "skipped") {
          continue;
        }
        await this.runStep(step.id, exec);
      }
      await this.succeed(exec);
    } catch (error) {
      if (error instanceof ShutdownSignal) {
        return;
      }
      try {
        await this.handleFailure(this.asFailure(error), exec);
      } catch (inner) {
        if (inner instanceof ShutdownSignal) {
          return;
        }
        this.deps.logger.error(
          `The failure of the update could not be recorded: ${(inner as Error).message}`,
        );
      }
    }
  }

  private async runStep(id: StepId, exec: Exec): Promise<void> {
    switch (id) {
      case "prepare":
        return await this.stepPrepare(exec);
      case "fetch":
        return await this.stepFetch(exec);
      case "backup":
        return await this.stepBackup(exec);
      case "stop":
        return await this.stepStop();
      case "migrate":
        return await this.stepMigrate(exec);
      case "start":
        return await this.stepStart(exec);
      case "health":
        return await this.stepHealth(exec);
      case "smoke":
        return await this.stepSmoke();
      case "finish":
        return await this.stepFinish(exec);
    }
  }

  /** The point of no return: the start of the stop step (skipped or not). */
  private async reachPonr(): Promise<void> {
    this.checkpoint();
    const context = this.context();
    if (!context.ponrReached) {
      context.ponrReached = true;
      await this.deps.store.save();
    }
  }

  private asFailure(error: unknown): StepFailure {
    if (error instanceof StepFailure) {
      return error;
    }
    const step = this.run().step ?? "prepare";
    return new StepFailure(FALLBACK_CODE[step], step, this.detail(error));
  }

  // -- prepare ----------------------------------------------------------------

  private async stepPrepare(exec: Exec): Promise<void> {
    const { config, envFile, redactor, catalog, verifier, releases, ops } = this.deps;
    await this.beginStep("prepare", { code: "step.prepare.checking" });
    const run = this.run();

    // 1. Deep preflight.
    const capabilities = await this.deps.preflight.check({ deep: true });
    const blocker = capabilities.blockers[0];
    if (blocker) {
      throw new StepFailure(blockerFailureCode(blocker.code), "prepare", blocker.detail ?? "");
    }

    // 2. The env file: credential-looking values are registered for redaction.
    let envText: string;
    try {
      envText = await envFile.read();
    } catch (error) {
      throw new StepFailure("prepare.env_unwritable", "prepare", this.detail(error));
    }
    for (const value of sensitiveEnvValues(envText, config.env.redactKeyPattern)) {
      redactor.add(value);
    }

    // 3. The stored release document: verified again, same bytes as scheduled.
    let document: ReleaseDocument | null = null;
    const stored = await catalog.load(run.targetVersion);
    if (run.mode === "image" || stored) {
      if (!stored) {
        throw new StepFailure(
          "prepare.release_mismatch",
          "prepare",
          "The stored release document is missing.",
        );
      }
      if (sha256Hex(stored.document) !== run.release.sha256) {
        throw new StepFailure(
          "prepare.release_mismatch",
          "prepare",
          "The stored release document differs from the one that was scheduled.",
        );
      }
      if (run.mode === "image") {
        try {
          await verifier.verifyDocument({
            document: stored.document,
            bundle: stored.bundle,
            tag: run.targetTag,
            version: run.targetVersion,
          });
        } catch (error) {
          throw new StepFailure("prepare.release_signature_invalid", "prepare", this.detail(error));
        }
      }
      try {
        document = releases.validateDocument(stored.document, run.targetVersion, run.targetTag);
      } catch (error) {
        throw new StepFailure("prepare.release_mismatch", "prepare", this.detail(error));
      }
    }
    exec.document = document;

    // 4. Running version and refusals.
    const running = await this.deps.running.detect(true);
    run.fromVersion = running.version ?? run.fromVersion;
    const refusals = await releases.refusals(run.targetVersion, document, run.mode, running);
    const first = refusals.reasons.find((reason) => reason !== "no_release_document");
    if (first) {
      throw new StepFailure(
        `prepare.${first}` as FailureCode,
        "prepare",
        refusals.details[first] ?? "",
      );
    }

    // 5. The image plan.
    if (run.mode === "image") {
      const { plan, missing } = buildImagePlan(config, document as ReleaseDocument);
      if (missing.length > 0) {
        throw new StepFailure(
          "prepare.image_missing",
          "prepare",
          `No image for ${missing.join(", ")}.`,
        );
      }
      exec.plan = plan;
    } else {
      exec.plan = buildSourcePlan(config, this.deps.project.name, run.targetVersion);
    }

    // 6. Compose probe: every managed service follows its key; the sidecar follows none.
    await this.note({ code: "step.prepare.verifying_compose" });
    const keys = writableKeys(config);
    const probeEnv: Record<string, string> = {};
    for (const key of keys) {
      probeEnv[key] = `cicd-updater-probe.invalid/${key.toLowerCase().replace(/_/g, "-")}:probe`;
    }
    let probed: Record<string, string | null>;
    let current: Record<string, string | null>;
    try {
      probed = await ops.composeImages(probeEnv);
      current = await ops.composeImages({});
    } catch (error) {
      throw new StepFailure("prepare.compose_invalid", "prepare", this.detail(error));
    }
    const unsupported = config.services
      .filter((service) => probed[service.name] !== probeEnv[service.imageVar])
      .map((service) => service.name);
    if (unsupported.length > 0) {
      throw new StepFailure(
        "prepare.compose_unsupported",
        "prepare",
        `These services do not take their image from their variable: ${unsupported.join(", ")}.`,
      );
    }
    const self = this.deps.project.selfService;
    if (self && Object.values(probeEnv).includes(probed[self] ?? "")) {
      throw new StepFailure(
        "prepare.updater_image_unpinned",
        "prepare",
        `The service ${self} takes its image from a key the sidecar rewrites.`,
      );
    }

    // 7. Capture the previous state before anything changes.
    const context = this.context();
    context.previousImages = Object.fromEntries(
      config.services.map((service) => [service.name, current[service.name] ?? null]),
    );
    context.previousEnv = await envFile.capture(keys);
    context.plan = Object.fromEntries(
      Object.entries(exec.plan).map(([service, entry]) => [
        service,
        { imageKey: entry.imageKey, ref: entry.ref, optionalKept: entry.optionalKept },
      ]),
    );
    run.images = Object.fromEntries(
      Object.entries(exec.plan)
        .filter(([, entry]) => !entry.optionalKept)
        .map(([service, entry]) => [service, entry.ref]),
    );
    await this.endStep("prepare", {
      running: running.version ?? "unknown",
      runningSource: running.source ?? "none",
    });
  }

  // -- fetch ------------------------------------------------------------------

  private async stepFetch(exec: Exec): Promise<void> {
    await this.beginStep("fetch", null);
    const detail =
      this.run().mode === "source" ? await this.fetchSource(exec) : await this.fetchImages(exec);
    await this.endStep("fetch", detail);
  }

  private async fetchImages(exec: Exec): Promise<Step["detail"]> {
    const { ops, verifier } = this.deps;
    const run = this.run();
    const refs = [
      ...new Set(
        Object.values(exec.plan)
          .filter((entry) => !entry.optionalKept && entry.pullRef)
          .map((entry) => entry.pullRef as string),
      ),
    ];
    const total = refs.length;

    if (verifier.mode === "none") {
      run.verification.signatures = "not_checked";
      await this.note({ code: "step.fetch.signature_not_checked" });
    } else {
      for (const [index, ref] of refs.entries()) {
        this.checkpoint();
        await this.note({
          code: "step.fetch.verifying_signature",
          params: { index: index + 1, total },
          details: { ref },
        });
        try {
          await verifier.verifyImage({ ref, tag: exec.tag, version: exec.target });
        } catch (error) {
          run.verification.signatures = "failed";
          if (error instanceof VerifyError) {
            throw new StepFailure(
              `fetch.${error.code}` as FailureCode,
              "fetch",
              this.detail(`${ref}: ${error.detail}`),
            );
          }
          throw new StepFailure("fetch.verifier_failed", "fetch", this.detail(error));
        }
      }
      run.verification.signatures = "verified";
    }

    for (const [index, ref] of refs.entries()) {
      this.checkpoint();
      await this.note({
        code: "step.fetch.pulling",
        params: { index: index + 1, total },
        details: { ref },
      });
      try {
        await ops.pull(ref);
      } catch (error) {
        if (error instanceof PullError) {
          throw new StepFailure(`fetch.${error.kind}` as FailureCode, "fetch", this.detail(error));
        }
        throw new StepFailure("fetch.pull_failed", "fetch", this.detail(error));
      }
    }

    this.checkpoint();
    await this.note({ code: "step.fetch.verifying_digests" });
    for (const ref of refs) {
      const digest = ref.slice(ref.indexOf("@") + 1);
      let info: Awaited<ReturnType<DockerOps["inspectImage"]>>;
      try {
        info = await ops.inspectImage(ref);
      } catch (error) {
        run.verification.digests = "failed";
        throw new StepFailure("fetch.digest_mismatch", "fetch", this.detail(error));
      }
      const known =
        info !== null &&
        (info.id === digest ||
          info.repoDigests.some((entry) => entry === ref || entry.endsWith(`@${digest}`)));
      if (!info || !known) {
        run.verification.digests = "failed";
        throw new StepFailure(
          "fetch.digest_mismatch",
          "fetch",
          `The local image is not known by ${ref} (found ${info ? [info.id, ...info.repoDigests].join(", ") : "nothing"}).`,
        );
      }
      const label = info.labels["org.opencontainers.image.version"];
      if (label !== undefined && label !== "" && !sameVersion(label, exec.target)) {
        throw new StepFailure(
          "fetch.version_label_mismatch",
          "fetch",
          `${ref} carries version ${label}, expected ${exec.target}.`,
        );
      }
    }
    run.verification.digests = "verified";
    return {
      images: total,
      signatures: run.verification.signatures ?? "not_checked",
      digests: "verified",
    };
  }

  private async fetchSource(exec: Exec): Promise<Step["detail"]> {
    const run = this.run();
    const keys = [...new Set(Object.values(exec.plan).map((entry) => entry.imageKey))];
    let built: Record<string, string>;
    try {
      built = await this.deps.source.build({
        runId: run.id,
        version: exec.target,
        tag: exec.tag,
        imageKeys: keys,
        signal: exec.abort.signal,
        onStage: async (stage, index, total) => {
          this.checkpoint();
          if (stage === "downloading") {
            await this.note({ code: "step.fetch.downloading", params: { version: exec.target } });
          } else {
            await this.note({
              code: "step.fetch.building",
              params: { index, total },
              details: { ref: keys[index - 1] ?? "" },
            });
          }
        },
      });
    } catch (error) {
      if (
        error instanceof ShutdownSignal ||
        (error instanceof StepFailure && error.code === "aborted")
      ) {
        throw error;
      }
      this.checkpoint();
      if (error instanceof SourceError) {
        throw new StepFailure(
          `fetch.${error.kind}` as FailureCode,
          "fetch",
          this.detail(error.detail),
        );
      }
      throw new StepFailure("fetch.download_failed", "fetch", this.detail(error));
    }
    for (const [service, entry] of Object.entries(exec.plan)) {
      const ref = built[entry.imageKey];
      if (!ref) {
        throw new StepFailure(
          "fetch.build_failed",
          "fetch",
          `No image was built for ${entry.imageKey}.`,
        );
      }
      exec.plan[service] = { ...entry, ref };
    }
    run.images = Object.fromEntries(
      Object.entries(exec.plan).map(([service, entry]) => [service, entry.ref]),
    );
    return { built: keys.length };
  }

  // -- backup -----------------------------------------------------------------

  private async stepBackup(exec: Exec): Promise<void> {
    const { config, hooks, backup, clock } = this.deps;
    await this.beginStep("backup", null);
    const run = this.run();
    const context = this.context();
    if (config.rollback.policy === "probe") {
      await this.note({ code: "step.backup.baseline" });
      try {
        context.baseline = await hooks.probe.read(exec.abort.signal);
      } catch (error) {
        this.checkpoint();
        throw new StepFailure("backup.baseline_unavailable", "backup", this.detail(error));
      }
      await this.deps.store.save();
    }
    if (backup.type === "none") {
      await this.endStep("backup", { backup: "none" });
      return;
    }
    this.checkpoint();
    await this.note({ code: "step.backup.creating" });
    let record: Awaited<ReturnType<BackupRunner["create"]>>;
    try {
      record = await backup.create({
        runId: run.id,
        fromVersion: run.fromVersion,
        toVersion: exec.target,
        at: clock.now(),
        signal: exec.abort.signal,
        onStage: async (stage) => {
          this.assertNotShuttingDown();
          if (stage === "verifying") {
            await this.note({ code: "step.backup.verifying" });
          } else if (stage === "encrypting") {
            await this.note({ code: "step.backup.encrypting" });
          }
        },
      });
    } catch (error) {
      this.assertNotShuttingDown();
      if (error instanceof BackupError) {
        if (error.kind === "aborted") {
          throw new StepFailure("aborted", "backup", "The backup was aborted.");
        }
        throw new StepFailure(
          `backup.${error.kind}` as FailureCode,
          "backup",
          this.detail(error.detail),
        );
      }
      throw new StepFailure("backup.failed", "backup", this.detail(error));
    }
    context.backupFile = record.file;
    await this.deps.store.save();
    this.log(run, LOG_TEXT["step.backup.verifying"]({ file: record.file }));
    await this.pruneBackups();
    await this.endStep("backup", {
      file: record.file,
      bytes: record.bytes,
      encrypted: record.encrypted,
    });
    // A non-interruptible backup finishes first; the abort takes effect now.
    this.checkpoint();
  }

  // -- stop -------------------------------------------------------------------

  private async stepStop(): Promise<void> {
    const { config, ops } = this.deps;
    await this.beginStep("stop", null);
    const groups = startGroups(config).reverse();
    for (const { services } of groups) {
      const names = services
        .filter((service) => service.stopBeforeUpdate)
        .map((service) => service.name);
      if (names.length === 0) {
        continue;
      }
      await this.note({ code: "step.stop.stopping", details: { services: names.join(", ") } });
      try {
        await ops.stop(names, config.timeouts.stopSeconds);
      } catch (error) {
        throw new StepFailure("stop.failed", "stop", this.detail(error));
      }
    }
    await this.endStep("stop");
  }

  // -- migrate ----------------------------------------------------------------

  private assignments(exec: Exec): Record<string, string> {
    const { config } = this.deps;
    const assignments: Record<string, string> = {};
    for (const service of config.services) {
      const entry = exec.plan[service.name];
      if (entry && !entry.optionalKept) {
        assignments[service.imageVar] = entry.ref;
      }
    }
    if (config.env.versionVar) {
      assignments[config.env.versionVar] = exec.target;
    }
    return assignments;
  }

  private async stepMigrate(exec: Exec): Promise<void> {
    const { config, ops } = this.deps;
    const migrate = config.hooks.migrate;
    await this.beginStep("migrate", null);
    if (!migrate) {
      await this.endStep("migrate");
      return;
    }
    const context = this.context();
    context.applyAttempted = true;
    await this.deps.store.save();
    await this.note({ code: "step.migrate.running", details: { service: migrate.service } });
    const name = `cicd-updater-migrate-${this.run().id}`;
    let result: Awaited<ReturnType<DockerOps["runOnce"]>>;
    try {
      result = await ops.runOnce({
        service: migrate.service,
        argv: migrate.argv,
        env: this.assignments(exec),
        name,
        timeoutSeconds: migrate.timeoutSeconds,
      });
    } catch (error) {
      await ops.removeContainer(name).catch(() => undefined);
      throw new StepFailure("migrate.failed", "migrate", this.detail(error));
    }
    if (result.timedOut) {
      await ops.removeContainer(name).catch(() => undefined);
      throw new StepFailure("migrate.timeout", "migrate", this.detail(result.outputTail));
    }
    if (result.exitCode !== 0) {
      throw new StepFailure(
        "migrate.failed",
        "migrate",
        this.detail(`exit code ${result.exitCode}: ${result.outputTail}`),
      );
    }
    await this.endStep("migrate", { exitCode: 0 });
  }

  // -- start ------------------------------------------------------------------

  private async stepStart(exec: Exec): Promise<void> {
    const { config, envFile } = this.deps;
    await this.beginStep("start", null);
    const context = this.context();
    const keys = writableKeys(config);
    let currentEnv: CapturedEnv;
    try {
      currentEnv = await envFile.capture(keys);
    } catch (error) {
      throw new StepFailure("start.env_write_failed", "start", this.detail(error));
    }
    const changed = sameCapture(currentEnv, context.previousEnv ?? {});
    if (changed.length > 0) {
      throw new StepFailure(
        "start.env_changed",
        "start",
        `The env file lines of ${changed.join(", ")} changed during the run.`,
      );
    }
    const assignments = this.assignments(exec);
    await this.note({
      code: "step.start.writing_env",
      details: { keys: Object.keys(assignments).join(", ") },
    });
    try {
      await envFile.apply(assignments);
    } catch (error) {
      throw new StepFailure("start.env_write_failed", "start", this.detail(error));
    }
    if (!context.applyAttempted) {
      context.applyAttempted = true;
      await this.deps.store.save();
    }
    const [lowest] = startGroups(config);
    if (lowest) {
      await this.startGroup(
        lowest.group,
        lowest.services.map((service) => service.name),
        "start",
        exec,
      );
    }
    await this.endStep("start");
  }

  private async startGroup(
    group: number,
    services: string[],
    step: StepId,
    exec: Exec,
  ): Promise<void> {
    await this.note({
      code: "step.start.starting",
      params: { group },
      details: { services: services.join(", ") },
    });
    for (const service of services) {
      exec.started.add(service);
    }
    try {
      await this.deps.ops.up(services);
    } catch (error) {
      throw new StepFailure("start.failed", step, this.detail(error));
    }
  }

  // -- health -----------------------------------------------------------------

  private async stepHealth(exec: Exec): Promise<void> {
    const { config, hooks } = this.deps;
    await this.beginStep("health", null);
    const groups = startGroups(config);
    const appGroup = config.hooks.health.afterGroup ?? groups[0]?.group ?? 1;
    for (const [index, { group, services }] of groups.entries()) {
      const names = services.map((service) => service.name);
      if (index > 0) {
        await this.startGroup(group, names, "health", exec);
      }
      await this.note({
        code: "step.health.waiting",
        params: { group },
        details: { services: names.join(", ") },
      });
      await this.waitForServices(names, "health", config.hooks.health.timeoutSeconds);
      if (group === appGroup && hooks.appCheckConfigured) {
        await this.note({ code: "step.health.checking_app", params: { version: exec.target } });
        await this.waitForApp(exec.target, "health", names);
      }
    }
    await this.note({ code: "step.health.verifying_services" });
    const all = config.services.map((service) => service.name);
    if (hooks.appCheckConfigured) {
      await this.waitForApp(exec.target, "health", all);
    }
    await this.waitForServices(
      all,
      "health",
      config.hooks.health.servicesGraceSeconds,
      "health.unhealthy",
    );
    for (const service of config.services) {
      if (!service.health) {
        continue;
      }
      const result = await hooks
        .check(service.health)
        .catch((error: unknown) => ({ ok: false, detail: this.detail(error) }));
      if (!result.ok) {
        throw new StepFailure(
          "health.unhealthy",
          "health",
          this.detail(`${service.name}: ${result.detail}`),
        );
      }
    }
    await this.endStep("health");
  }

  /** Every service `running` (and Docker-healthy as configured); crash loops fail fast. */
  private async waitForServices(
    services: readonly string[],
    step: StepId,
    timeoutSeconds: number,
    timeoutCode: FailureCode = "health.timeout",
  ): Promise<void> {
    const { ops, clock, config } = this.deps;
    const settings = config.hooks.health;
    const deadline = clock.now().getTime() + timeoutSeconds * 1000;
    const crashes = new Map<string, number>();
    let last = "";
    for (;;) {
      this.assertNotShuttingDown();
      const states = await ops.serviceStates().catch(() => null);
      if (states) {
        const pending: string[] = [];
        for (const service of services) {
          const state = states.find((entry) => entry.service === service);
          if (state && ["restarting", "exited", "dead"].includes(state.state)) {
            const count = (crashes.get(service) ?? 0) + 1;
            crashes.set(service, count);
            if (count >= settings.crashLimit) {
              const log = await ops.logsTail(service, 40).catch(() => "");
              throw new StepFailure(
                "health.crashed",
                step,
                this.detail(
                  `${service} is ${state.state}${state.exitCode !== null ? ` (exit code ${state.exitCode})` : ""}.${log ? ` Last log: ${log}` : ""}`,
                ),
              );
            }
          }
          const running = state?.state === "running";
          const healthy =
            settings.waitForDockerHealth === "never" ||
            (settings.waitForDockerHealth === "auto" && (state?.health ?? null) === null) ||
            state?.health === "healthy";
          if (
            settings.waitForDockerHealth === "always" &&
            running &&
            (state?.health ?? null) === null
          ) {
            throw new StepFailure(
              "health.unhealthy",
              step,
              `${service} has no Docker healthcheck (waitForDockerHealth: always).`,
            );
          }
          if (!running || !healthy) {
            pending.push(
              `${service} (${state?.state ?? "missing"}${state?.health ? `, ${state.health}` : ""})`,
            );
          }
        }
        if (pending.length === 0) {
          return;
        }
        last = pending.join(", ");
      }
      if (clock.now().getTime() >= deadline) {
        const code: FailureCode = last.includes("unhealthy") ? "health.unhealthy" : timeoutCode;
        throw new StepFailure(
          code,
          step,
          this.detail(
            `Not ready within ${timeoutSeconds} s: ${last || "service states unreadable"}.`,
          ),
        );
      }
      await clock.sleep(settings.intervalSeconds * 1000, this.shutdownController.signal);
    }
  }

  /** Poll the app check until it is healthy and reports `expected` (any version when null). */
  private async waitForApp(
    expected: string | null,
    step: StepId,
    watch: readonly string[],
  ): Promise<void> {
    const { hooks, clock, config, ops } = this.deps;
    const settings = config.hooks.health;
    const deadline = clock.now().getTime() + settings.timeoutSeconds * 1000;
    let mismatches = 0;
    const crashes = new Map<string, number>();
    let last: string | null = null;
    for (;;) {
      this.assertNotShuttingDown();
      const result = await hooks.appCheck().catch((error: unknown) => ({
        healthy: false,
        version: null,
        detail: this.detail(error),
      }));
      if (!result) {
        return;
      }
      if (result.healthy) {
        if (
          !hooks.appReportsVersion ||
          expected === null ||
          (result.version !== null && sameVersion(result.version, expected))
        ) {
          return;
        }
        mismatches += 1;
        last = `The app is healthy but reports version ${result.version ?? "none"}, expected ${expected}.`;
        if (mismatches >= settings.versionMismatchLimit) {
          throw new StepFailure(
            "health.version_mismatch",
            step,
            await this.withLog(last, watch[0]),
          );
        }
      } else {
        mismatches = 0;
        last = result.detail;
      }
      const states = await ops.serviceStates().catch(() => null);
      for (const service of watch) {
        const state = states?.find((entry) => entry.service === service);
        if (state && ["restarting", "exited", "dead"].includes(state.state)) {
          const count = (crashes.get(service) ?? 0) + 1;
          crashes.set(service, count);
          if (count >= settings.crashLimit) {
            throw new StepFailure(
              "health.crashed",
              step,
              await this.withLog(
                `${service} is ${state.state}${state.exitCode !== null ? ` (exit code ${state.exitCode})` : ""}.`,
                service,
              ),
            );
          }
        }
      }
      if (clock.now().getTime() >= deadline) {
        throw new StepFailure(
          "health.timeout",
          step,
          await this.withLog(
            `The app did not become healthy within ${settings.timeoutSeconds} s${last ? ` (${last})` : ""}.`,
            watch[0],
          ),
        );
      }
      await clock.sleep(settings.intervalSeconds * 1000, this.shutdownController.signal);
    }
  }

  private async withLog(reason: string, service: string | undefined): Promise<string> {
    if (!service) {
      return this.detail(reason);
    }
    const log = await this.deps.ops.logsTail(service, 40).catch(() => "");
    return this.detail(log ? `${reason} Last log of ${service}: ${log}` : reason);
  }

  // -- smoke ------------------------------------------------------------------

  private async stepSmoke(): Promise<void> {
    const { config, hooks, clock } = this.deps;
    const smoke = config.hooks.smoke;
    await this.beginStep("smoke", null);
    const deadline = clock.now().getTime() + smoke.timeoutSeconds * 1000;
    for (const [index, check] of smoke.checks.entries()) {
      await this.note({
        code: "step.smoke.checking",
        params: { index: index + 1, total: smoke.checks.length },
        details: {
          check: check.type === "http" ? check.url : `${check.service}: ${check.argv[0] ?? ""}`,
        },
      });
      let last = "";
      let passed = false;
      for (let attempt = 1; attempt <= smoke.retries; attempt++) {
        this.assertNotShuttingDown();
        const result = await hooks
          .check(check)
          .catch((error: unknown) => ({ ok: false, detail: this.detail(error) }));
        if (result.ok) {
          passed = true;
          break;
        }
        last = result.detail;
        if (attempt < smoke.retries && clock.now().getTime() < deadline) {
          await clock.sleep(smoke.intervalSeconds * 1000, this.shutdownController.signal);
        }
        if (clock.now().getTime() >= deadline) {
          break;
        }
      }
      if (!passed) {
        throw new StepFailure("smoke.failed", "smoke", this.detail(`check ${index + 1}: ${last}`));
      }
    }
    await this.endStep("smoke");
  }

  // -- finish -----------------------------------------------------------------

  private async stepFinish(exec: Exec): Promise<void> {
    const { ops, config, catalog, source, logger } = this.deps;
    await this.beginStep("finish", { code: "step.finish.cleaning" });
    const context = this.context();
    await this.pruneBackups();
    const keep = [
      ...Object.values(exec.plan).map((entry) => entry.ref),
      ...Object.values(context.previousImages ?? {}).filter((ref): ref is string => ref !== null),
    ].filter((ref) => ref !== "");
    const repositories = [...new Set(keep.map(repositoryOf))];
    await ops
      .pruneImages({ repositories, keep, keepCount: config.cleanup.keepPreviousImages })
      .catch((error: Error) => logger.warn(`Could not prune old images: ${error.message}`));
    await catalog
      .prune(RELEASES_KEPT)
      .catch((error: Error) => logger.warn(`Could not prune release documents: ${error.message}`));
    await source
      .purge()
      .catch((error: Error) => logger.warn(`Could not remove source trees: ${error.message}`));
    await this.endStep("finish");
  }

  private async succeed(exec: Exec): Promise<void> {
    const { store, clock } = this.deps;
    const run = this.run();
    run.outcome = "succeeded";
    run.finishedAt = clock.now().toISOString();
    run.progress = 100;
    store.state.phase = "succeeded";
    this.setMessage({ code: "run.succeeded", params: { version: exec.target } });
    this.journal("update.succeeded", run, run.requestedBy, this.finishDetails(run));
    store.recordHistory(run);
    await store.save();
    this.deps.preflight.invalidate();
  }

  // ---------------------------------------------------------------------------
  // Failure handling (design 5.6)
  // ---------------------------------------------------------------------------

  private async handleFailure(failure: StepFailure, exec: Exec): Promise<void> {
    const { store, config, logger, redactor } = this.deps;
    const run = this.run();
    const context = this.context();
    logger.warn(
      `The update ${run.id} failed in step ${failure.step ?? "-"}: ${failure.code} ${redactor.oneLine(failure.detail, 300)}`,
    );
    if (failure.step) {
      const step = this.stepOf(failure.step);
      if (step.status === "running" || step.status === "pending") {
        step.status = "failed";
        step.finishedAt = this.deps.clock.now().toISOString();
      }
    }
    this.log(
      run,
      `Step ${failure.step ?? "-"} failed: ${failure.code}. ${redactor.oneLine(failure.detail, 300)}`,
    );
    await store.save();

    if (!context.ponrReached) {
      // Nothing was stopped or replaced: discard partial artefacts.
      await this.deps.source.purge().catch(() => undefined);
      await this.finalizeFailure(failure, "unchanged", null, false);
      return;
    }
    if (!context.applyAttempted) {
      // The stop step (or a quiesced backup) failed: nothing new ran, the env file is untouched.
      await this.rollBack(failure, false);
      return;
    }
    if (config.rollback.policy === "never") {
      await this.attention(failure, null);
      return;
    }
    if (config.rollback.policy === "always") {
      await this.rollBack(failure, null);
      return;
    }
    // probe: freeze the new version first, so the probe value cannot change while it is read.
    await this.note({ code: "rollback.freezing" });
    const frozen = [...exec.started];
    try {
      if (frozen.length > 0) {
        await this.deps.ops.stop(frozen, config.timeouts.stopSeconds);
      }
      await this.deps.ops.removeContainer(`cicd-updater-migrate-${run.id}`);
    } catch (error) {
      logger.warn(`The new version could not be frozen: ${this.detail(error)}`);
      await this.attention(failure, null);
      return;
    }
    await this.note({ code: "rollback.probing" });
    let after: string | null = null;
    try {
      after = await this.deps.hooks.probe.read();
    } catch (error) {
      logger.warn(`The migration probe failed after the update: ${this.detail(error)}`);
      after = null;
    }
    if (context.baseline === null || after === null) {
      await this.attention(failure, null);
    } else if (after === context.baseline) {
      await this.rollBack(failure, false);
    } else {
      this.log(run, "The migration probe value changed: the new version changed the schema.");
      await this.attention(failure, true);
    }
  }

  private async rollBack(failure: StepFailure, schemaChanged: boolean | null): Promise<void> {
    const { ops, envFile, config, hooks } = this.deps;
    const context = this.context();
    const run = this.run();
    try {
      if (context.previousEnv) {
        await this.note({ code: "rollback.restoring_env" });
        await envFile.restore(context.previousEnv);
      }
      await this.note({
        code: "rollback.restarting",
        params: { version: run.fromVersion ?? "unknown" },
      });
      for (const { services } of startGroups(config)) {
        await ops.up(services.map((service) => service.name));
      }
      await this.note({ code: "rollback.waiting" });
      const all = config.services.map((service) => service.name);
      await this.waitForServices(all, failure.step ?? "health", config.hooks.health.timeoutSeconds);
      if (hooks.appCheckConfigured) {
        await this.waitForApp(run.fromVersion, failure.step ?? "health", all);
      }
    } catch (error) {
      if (error instanceof ShutdownSignal) {
        throw error;
      }
      await this.note({ code: "rollback.failed" });
      const combined = `${clip(failure.detail, HALF_DETAIL)} Rollback failed: ${clip(this.detail(error instanceof StepFailure ? error.detail : error), HALF_DETAIL)}`;
      await this.attention(new StepFailure(failure.code, failure.step, combined), schemaChanged);
      return;
    }
    await this.note({ code: "rollback.done" });
    await this.finalizeFailure(failure, "rolled_back", null, schemaChanged);
  }

  private async attention(failure: StepFailure, schemaChanged: boolean | null): Promise<void> {
    const { ops, config } = this.deps;
    const names = config.services
      .filter((service) => service.stopOnAttention)
      .map((service) => service.name);
    let detail = failure.detail;
    if (names.length > 0) {
      await this.note({ code: "attention.stopping", details: { services: names.join(", ") } });
      try {
        await ops.stop(names, config.timeouts.stopSeconds);
      } catch (error) {
        detail = `${clip(detail, HALF_DETAIL)} The services could not be stopped completely: ${clip(this.detail(error), HALF_DETAIL)}`;
      }
    }
    const recovery = await this.recoveryInfo();
    if (recovery.backup) {
      await this.note({ code: "attention.backup_kept", details: { file: recovery.backup.file } });
    }
    await this.finalizeFailure(
      new StepFailure(failure.code, failure.step, detail),
      "needs_attention",
      recovery,
      schemaChanged,
    );
  }

  private async recoveryInfo(): Promise<Recovery> {
    const { config, backups, project } = this.deps;
    const context = this.context();
    const run = this.run();
    let backup: BackupRef | null = null;
    if (context.backupFile && (await backups.exists(context.backupFile))) {
      const metadata = await backups.metadata(context.backupFile);
      const listed = (await backups.list()).find((entry) => entry.file === context.backupFile);
      backup = {
        file: context.backupFile,
        bytes: listed?.bytes ?? metadata?.bytes ?? 0,
        sha256: metadata?.sha256 ?? "0".repeat(64),
        type: metadata?.type ?? config.hooks.backup.type,
        encrypted: metadata?.encrypted ?? context.backupFile.endsWith(".age"),
      };
    }
    const previousEnv: Recovery["previousEnv"] = {};
    for (const [key, captured] of Object.entries(context.previousEnv ?? {})) {
      previousEnv[key] = { present: captured.present, line: captured.line };
    }
    return {
      backup,
      fromVersion: run.fromVersion,
      previousImages: context.previousImages ?? {},
      previousEnv,
      commands: renderRecoveryCommands({
        projectName: project.name,
        profiles: config.compose.profiles,
        selfService: project.selfService ?? "updater",
        stopServices: config.services
          .filter((service) => service.stopOnAttention)
          .map((service) => service.name),
        runId: run.id,
        backup,
        databaseService: config.hooks.backup.service ?? null,
        volumes: config.hooks.backup.volumes,
      }),
    };
  }

  private async finalizeFailure(
    failure: StepFailure,
    outcome: Exclude<Outcome, "succeeded">,
    recovery: Recovery | null,
    schemaChanged: boolean | null,
    message?: Msg,
  ): Promise<void> {
    const { store, clock, redactor } = this.deps;
    const run = this.run();
    for (const step of run.steps) {
      if (step.status === "pending") {
        step.status = "skipped";
      } else if (step.status === "running") {
        step.status = "failed";
        step.finishedAt = clock.now().toISOString();
      }
    }
    run.failure = {
      code: failure.code,
      step: failure.step,
      detail: redactor.oneLine(failure.detail, DETAIL_CHARS),
      schemaChanged,
    };
    run.outcome = outcome;
    run.recovery = recovery;
    run.finishedAt = clock.now().toISOString();
    store.state.phase = "failed";
    const code: MessageCode =
      outcome === "unchanged"
        ? "run.unchanged"
        : outcome === "rolled_back"
          ? "run.rolled_back"
          : "run.needs_attention";
    this.setMessage(message ?? { code, params: { code: failure.code } });
    this.journal("update.failed", run, run.requestedBy, this.finishDetails(run));
    store.recordHistory(run);
    await store.save();
    this.deps.preflight.invalidate();
    if (outcome === "needs_attention") {
      await this.pruneBackups();
    }
  }

  private finishDetails(run: Run): Record<string, unknown> {
    const context = this.deps.store.state.runContext;
    return {
      mode: run.mode,
      outcome: run.outcome,
      failureCode: run.failure?.code ?? null,
      schemaChanged: run.failure?.schemaChanged ?? null,
      fromVersion: run.fromVersion,
      targetVersion: run.targetVersion,
      trustMode: run.trustMode,
      verification: run.verification,
      backupFile: context?.backupFile ?? run.recovery?.backup?.file ?? null,
      steps: run.steps.map((step) => ({
        id: step.id,
        status: step.status,
        durationMs:
          step.startedAt && step.finishedAt
            ? Math.max(0, Date.parse(step.finishedAt) - Date.parse(step.startedAt))
            : null,
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // Resume after a restart (design 5.8)
  // ---------------------------------------------------------------------------

  private async resumeInterrupted(): Promise<void> {
    const run = this.run();
    const context = this.context();
    if (run.step === "finish") {
      // Health and smoke had passed; only housekeeping was left.
      this.log(
        run,
        "The sidecar restarted during the finish step; health and smoke checks had passed.",
      );
      const finish = this.stepOf("finish");
      finish.status = "done";
      finish.finishedAt = this.deps.clock.now().toISOString();
      await this.succeed({
        target: run.targetVersion,
        tag: run.targetTag,
        document: null,
        plan: {},
        abort: new AbortController(),
        started: new Set(),
      });
      const last = this.deps.store.state.events.at(-1);
      if (last) {
        last.details = { ...last.details, resumed: true };
        await this.deps.store.save();
      }
      return;
    }
    const step: StepId | null = run.step;
    const failure = new StepFailure(
      "interrupted",
      step,
      "The sidecar restarted while the update was running.",
    );
    if (!context.ponrReached) {
      await this.finalizeFailure(failure, "unchanged", null, false, { code: "run.interrupted" });
      return;
    }
    // Nothing is known about what happened after the sidecar went away; no
    // service is started or stopped on its own.
    const recovery = await this.recoveryInfo();
    await this.finalizeFailure(failure, "needs_attention", recovery, null, {
      code: "run.interrupted",
    });
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async pruneBackups(): Promise<void> {
    const { backups, config, clock, logger } = this.deps;
    const protectedFiles = this.protectedBackups();
    try {
      await backups.prune({
        keep: config.hooks.backup.retention.keep,
        maxAgeDays: config.hooks.backup.retention.maxAgeDays,
        protectedFiles,
        now: clock.now(),
      });
    } catch (error) {
      logger.warn(`Could not prune old backups: ${(error as Error).message}`);
    }
  }

  /** The newest needs_attention run's backup is protected from retention. */
  protectedBackups(): Set<string> {
    const attention = this.deps.store.state.history.find(
      (run) => run.outcome === "needs_attention",
    );
    return new Set(attention?.recovery?.backup ? [attention.recovery.backup.file] : []);
  }

  private run(): Run {
    const run = this.deps.store.state.run;
    if (!run) {
      throw new Error("There is no current run.");
    }
    return run;
  }

  private context(): RunContext {
    const state = this.deps.store.state;
    if (!state.runContext) {
      state.runContext = emptyRunContext();
    }
    return state.runContext;
  }

  private stepOf(id: StepId): Step {
    const step = this.run().steps.find((candidate) => candidate.id === id);
    if (!step) {
      throw new Error(`Unknown step ${id}.`);
    }
    return step;
  }

  private detail(error: unknown): string {
    return this.deps.redactor.oneLine(
      typeof error === "string" ? error : describeError(error),
      DETAIL_CHARS,
    );
  }

  private assertNotShuttingDown(): void {
    if (this.shuttingDown) {
      throw new ShutdownSignal();
    }
  }

  /** A check point: shutdown, and an abort before the point of no return. */
  private checkpoint(): void {
    this.assertNotShuttingDown();
    const run = this.deps.store.state.run;
    if (run?.abortRequestedAt && !this.context().ponrReached) {
      throw new StepFailure(
        "aborted",
        run.step,
        "The update was aborted before the point of no return.",
      );
    }
  }

  private bumpProgress(run: Run): void {
    run.progress = Math.max(run.progress, progressOf(run.steps));
  }

  private setMessage(message: Msg): void {
    const run = this.run();
    const safe: Params = {};
    for (const [key, value] of Object.entries(message.params ?? {})) {
      safe[key] = typeof value === "string" ? this.deps.redactor.oneLine(value, 300) : value;
    }
    const update: Message = { code: message.code, params: safe };
    run.message = update;
    this.log(run, LOG_TEXT[message.code]({ ...(message.details ?? {}), ...safe }));
  }

  private log(run: Run, line: string): void {
    const text = clip(this.deps.redactor.oneLine(line, LOG_LINE_CHARS), LOG_LINE_CHARS);
    run.log = [...run.log, `${this.deps.clock.now().toISOString()} ${text}`].slice(-LOG_LINES);
    this.deps.logger.info(`[${run.id}] ${text}`);
  }

  private async note(message: Msg): Promise<void> {
    this.assertNotShuttingDown();
    this.setMessage(message);
    await this.deps.store.save();
  }

  private async beginStep(id: StepId, message: Msg | null): Promise<void> {
    this.checkpoint();
    const run = this.run();
    const step = this.stepOf(id);
    step.status = "running";
    step.startedAt = this.deps.clock.now().toISOString();
    step.finishedAt = null;
    run.step = id;
    if (message) {
      this.setMessage(message);
    }
    this.bumpProgress(run);
    await this.deps.store.save();
  }

  private async endStep(id: StepId, detail: Step["detail"] = {}): Promise<void> {
    const run = this.run();
    const step = this.stepOf(id);
    step.status = "done";
    step.finishedAt = this.deps.clock.now().toISOString();
    step.detail = { ...step.detail, ...detail };
    this.bumpProgress(run);
    await this.deps.store.save();
  }

  private journal(
    action: JournalAction,
    run: Run,
    actor: Actor,
    details: Record<string, unknown>,
  ): void {
    const now = this.deps.clock.now();
    this.deps.store.addEvent(
      { at: now.toISOString(), action, runId: run.id, actor, target: run.targetVersion, details },
      now.getTime(),
    );
  }
}

/** `repo:tag@digest` / `repo@digest` / `repo:tag` -> `repo`. */
export function repositoryOf(ref: string): string {
  const withoutDigest = ref.split("@")[0] ?? ref;
  const lastSlash = withoutDigest.lastIndexOf("/");
  const colon = withoutDigest.lastIndexOf(":");
  return colon > lastSlash ? withoutDigest.slice(0, colon) : withoutDigest;
}

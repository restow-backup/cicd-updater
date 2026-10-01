import { z } from "zod";
import {
  CHANNELS,
  JOURNAL_ACTIONS,
  OUTCOMES,
  PHASES,
  STEP_IDS,
  STEP_STATUSES,
  TRUST_MODES,
  UPDATE_MODES,
} from "./codes.js";

/**
 * Runs, journal events and the sidecar's state file `status.json` (design 5.9,
 * 5.13). The state file is internal (not covered by the stability promise);
 * the `Run`, `RunSummary` and `JournalEvent` shapes are part of the HTTP API.
 */

export const isoTime = z.iso.datetime({ offset: true });
export const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

export const messageSchema = z
  .object({
    code: z.string().max(100),
    params: z.record(z.string(), z.union([z.string(), z.number()])),
  })
  .meta({ id: "Message" });
export type Message = z.infer<typeof messageSchema>;

export const stepSchema = z
  .object({
    id: z.enum(STEP_IDS),
    status: z.enum(STEP_STATUSES),
    startedAt: isoTime.nullable(),
    finishedAt: isoTime.nullable(),
    detail: z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()])),
  })
  .meta({ id: "Step" });
export type Step = z.infer<typeof stepSchema>;

export const failureSchema = z
  .object({
    code: z.string().max(100),
    step: z.enum(STEP_IDS).nullable(),
    /** Redacted, at most 2000 characters. */
    detail: z.string().max(2000),
    /** true: the schema changed; false: certainly not; null: unknown. */
    schemaChanged: z.boolean().nullable(),
  })
  .meta({ id: "Failure" });
export type Failure = z.infer<typeof failureSchema>;

export const capturedLineSchema = z.object({
  present: z.boolean(),
  line: z.string().nullable(),
});

export const backupRefSchema = z.object({
  file: z.string(),
  bytes: z.number().int().nonnegative(),
  sha256: sha256Hex,
  type: z.string(),
  encrypted: z.boolean(),
});
export type BackupRef = z.infer<typeof backupRefSchema>;

export const recoverySchema = z
  .object({
    backup: backupRefSchema.nullable(),
    fromVersion: z.string().nullable(),
    previousImages: z.record(z.string(), z.string().nullable()),
    previousEnv: z.record(z.string(), capturedLineSchema),
    /** Rendered restore commands, for display. */
    commands: z.array(z.string()),
  })
  .meta({ id: "Recovery" });
export type Recovery = z.infer<typeof recoverySchema>;

export const ACTOR_VIA = ["api", "cli", "system"] as const;

export const actorSchema = z.object({
  id: z.string().max(200).nullable(),
  label: z.string().max(200),
  via: z.enum(ACTOR_VIA),
});
export type Actor = z.infer<typeof actorSchema>;

export const SIGNATURE_VERIFICATION = [
  "verified",
  "failed",
  "not_checked",
  "not_applicable",
] as const;
export const DIGEST_VERIFICATION = ["verified", "failed", "not_applicable"] as const;

export const runSchema = z
  .object({
    /** `r-<epoch ms>-<4 hex>`. */
    id: z.string().regex(/^r-\d{1,15}-[0-9a-f]{4}$/),
    mode: z.enum(UPDATE_MODES),
    fromVersion: z.string().nullable(),
    targetVersion: z.string(),
    targetTag: z.string(),
    notesUrl: z.string().nullable(),
    release: z.object({
      /** SHA-256 of the stored release.json bytes (null: source mode without a document). */
      sha256: sha256Hex.nullable(),
      channel: z.enum(CHANNELS),
      document: z.enum(["verified", "not_checked"]),
    }),
    trustMode: z.enum(TRUST_MODES),
    verification: z.object({
      signatures: z.enum(SIGNATURE_VERIFICATION).nullable(),
      digests: z.enum(DIGEST_VERIFICATION).nullable(),
    }),
    requestedBy: actorSchema,
    scheduledAt: isoTime,
    startsAt: isoTime,
    leadSeconds: z.number().int().nonnegative().nullable(),
    startedAt: isoTime.nullable(),
    finishedAt: isoTime.nullable(),
    cancelled: z.boolean(),
    cancelledAt: isoTime.nullable(),
    abortRequestedAt: isoTime.nullable(),
    outcome: z.enum(OUTCOMES).nullable(),
    step: z.enum(STEP_IDS).nullable(),
    steps: z.array(stepSchema),
    progress: z.number().int().min(0).max(100),
    message: messageSchema.nullable(),
    failure: failureSchema.nullable(),
    recovery: recoverySchema.nullable(),
    /** service -> image reference written. */
    images: z.record(z.string(), z.string()),
    configHash: sha256Hex,
    /** At most 200 redacted lines `<ISO time> <text>`. */
    log: z.array(z.string()),
  })
  .meta({ id: "Run" });
export type Run = z.infer<typeof runSchema>;

export const runSummarySchema = runSchema.omit({ log: true }).meta({ id: "RunSummary" });
export type RunSummary = z.infer<typeof runSummarySchema>;

export const journalEventSchema = z
  .object({
    /** `<epoch ms, 15 digits>-<counter, 6 digits>`: sortable, unique across restarts. */
    id: z.string().regex(/^\d{15}-\d{6}$/),
    at: isoTime,
    action: z.enum(JOURNAL_ACTIONS),
    runId: z.string(),
    actor: actorSchema,
    /** The target version. */
    target: z.string(),
    details: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "JournalEvent" });
export type JournalEvent = z.infer<typeof journalEventSchema>;

export const runContextSchema = z.object({
  previousEnv: z
    .record(
      z.string(),
      z.object({ present: z.boolean(), line: z.string().nullable(), value: z.string().nullable() }),
    )
    .nullable(),
  previousImages: z.record(z.string(), z.string().nullable()).nullable(),
  /** Migration probe value before the update. */
  baseline: z.string().nullable(),
  /** Set immediately before the first command that could start a new image. */
  applyAttempted: z.boolean(),
  /** Set when the run reached the point of no return (the start of the stop step). */
  ponrReached: z.boolean(),
  /** Set once the backup was created and verified. */
  backupFile: z.string().nullable(),
  plan: z
    .record(
      z.string(),
      z.object({ imageKey: z.string(), ref: z.string(), optionalKept: z.boolean() }),
    )
    .nullable(),
});
export type RunContext = z.infer<typeof runContextSchema>;

export const STATUS_SCHEMA_VERSION = 1;

export const statusFileSchema = z
  .object({
    schemaVersion: z.literal(STATUS_SCHEMA_VERSION),
    instanceId: z.string().min(1),
    phase: z.enum(PHASES),
    run: runSchema.nullable(),
    runContext: runContextSchema.nullable(),
    history: z.array(runSummarySchema),
    events: z.array(journalEventSchema),
    eventCounter: z.number().int().nonnegative(),
  })
  .superRefine((state, ctx) => {
    if (state.phase !== "idle" && state.run === null) {
      ctx.addIssue({ code: "custom", path: ["run"], message: "this phase requires a run" });
    }
  })
  .meta({ title: "cicd-updater status.json (internal)" });
export type StatusFile = z.infer<typeof statusFileSchema>;

export function emptyRunContext(): RunContext {
  return {
    previousEnv: null,
    previousImages: null,
    baseline: null,
    applyAttempted: false,
    ponrReached: false,
    backupFile: null,
    plan: null,
  };
}

/** A run without its log, as history keeps it. */
export function summaryOf(run: Run): RunSummary {
  const { log: _log, ...summary } = run;
  return summary;
}

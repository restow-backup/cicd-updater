import { z } from "zod";
import {
  API_VERSION,
  BLOCKER_CODES,
  CHANNELS,
  OUTCOMES,
  PHASES,
  PLATFORMS,
  STEP_IDS,
  STEP_STATUSES,
  TRUST_MODES,
  UPDATE_MODES,
  WARNING_CODES,
} from "./codes.js";
import { PLAIN_VERSION_PATTERN } from "./semver.js";
import {
  isoTime,
  journalEventSchema,
  messageSchema,
  runSchema,
  runSummarySchema,
  sha256Hex,
} from "./status.js";

/**
 * Request and response shapes of the sidecar's HTTP API `/v1` (design 6). The
 * OpenAPI document `openapi/updater-api.v1.yaml` is generated from these.
 *
 * Clients MUST tolerate unknown fields and render unknown codes generically
 * (design 6.6), so response schemas here are not strict.
 */

/** Who asked, as the app names its user; the journal records it. */
export const requestedBySchema = z
  .strictObject({
    id: z.string().max(200).nullable().optional(),
    label: z.string().min(1).max(200),
  })
  .meta({ id: "RequestedBy" });

export const scheduleRequestSchema = z
  .strictObject({
    version: z.string().max(64).regex(PLAIN_VERSION_PATTERN),
    mode: z.enum(UPDATE_MODES).default("image"),
    leadSeconds: z.number().int().min(0).optional(),
    startsAt: isoTime.optional(),
    requestedBy: requestedBySchema,
    expect: z.strictObject({ releaseSha256: sha256Hex.optional() }).optional(),
  })
  .refine((request) => request.leadSeconds === undefined || request.startsAt === undefined, {
    message: "leadSeconds and startsAt are exclusive",
    path: ["startsAt"],
  })
  .meta({ id: "ScheduleRequest" });
export type ScheduleRequest = z.input<typeof scheduleRequestSchema>;
export type ParsedScheduleRequest = z.output<typeof scheduleRequestSchema>;

export const rescheduleRequestSchema = z
  .strictObject({
    leadSeconds: z.number().int().min(0).optional(),
    startsAt: isoTime.optional(),
    requestedBy: requestedBySchema.optional(),
  })
  .refine((request) => (request.leadSeconds === undefined) !== (request.startsAt === undefined), {
    message: "exactly one of leadSeconds and startsAt",
  })
  .meta({ id: "RescheduleRequest" });
export type RescheduleRequest = z.infer<typeof rescheduleRequestSchema>;

/** The optional body of cancel and acknowledge. */
export const runActionRequestSchema = z
  .strictObject({ requestedBy: requestedBySchema.optional() })
  .meta({ id: "RunActionRequest" });
export type RunActionRequest = z.infer<typeof runActionRequestSchema>;

export const blockerSchema = z
  .object({
    code: z
      .string()
      .meta({ description: `One of: ${BLOCKER_CODES.join(", ")} (more may be added in 1.x).` }),
    detail: z.string().max(500).nullable(),
  })
  .meta({ id: "Blocker" });
export type Blocker = { code: (typeof BLOCKER_CODES)[number]; detail: string | null };

export const warningSchema = z
  .object({
    code: z
      .string()
      .meta({ description: `One of: ${WARNING_CODES.join(", ")} (more may be added in 1.x).` }),
    detail: z.string().max(500).nullable(),
  })
  .meta({ id: "Warning" });
export type Warning = { code: (typeof WARNING_CODES)[number]; detail: string | null };

export const backupInfoSchema = z
  .object({
    file: z.string(),
    bytes: z.number().int().nonnegative(),
    sha256: sha256Hex.nullable(),
    type: z.string(),
    createdAt: isoTime,
    runId: z.string().nullable(),
    fromVersion: z.string().nullable(),
    toVersion: z.string().nullable(),
    verified: z.boolean(),
    encrypted: z.boolean(),
    /** Referenced by the newest needs_attention run: never deleted by retention. */
    protected: z.boolean(),
  })
  .meta({ id: "BackupInfo" });
export type BackupInfo = z.infer<typeof backupInfoSchema>;

export const capabilitiesSchema = z
  .object({
    ready: z.boolean(),
    blockers: z.array(blockerSchema),
    warnings: z.array(warningSchema),
    docker: z.object({
      serverVersion: z.string().nullable(),
      apiVersion: z.string().nullable(),
      architecture: z.enum(PLATFORMS).nullable(),
      imageStore: z.enum(["classic", "containerd"]).nullable(),
    }),
    compose: z.object({
      projectName: z.string(),
      projectDir: z.string(),
      files: z.array(z.string()),
      envFile: z.string(),
    }),
    backups: z.array(backupInfoSchema),
    checkedAt: isoTime,
  })
  .meta({ id: "Capabilities" });
/** Capabilities as the sidecar produces them (known codes); clients parse codes as plain strings. */
export type Capabilities = Omit<z.infer<typeof capabilitiesSchema>, "blockers" | "warnings"> & {
  blockers: Blocker[];
  warnings: Warning[];
};

export const stateViewSchema = z
  .object({
    api: z.object({
      /** `1.<minor>`; an SDK 1.x accepts every 1.x sidecar. */
      version: z
        .string()
        .regex(/^1\.\d+$/)
        .meta({ examples: [API_VERSION] }),
      features: z.array(z.string()),
    }),
    updater: z.object({
      version: z.string(),
      configHash: sha256Hex,
      latestAvailable: z.string().nullable(),
    }),
    phase: z.enum(PHASES),
    run: runSchema.nullable(),
    history: z.array(runSummarySchema),
    running: z.object({
      version: z.string().nullable(),
      source: z.enum(["health", "label", "state", "env"]).nullable(),
    }),
    trust: z.object({
      mode: z.enum(TRUST_MODES),
      identity: z.string().nullable(),
      keys: z.number().int().nullable(),
    }),
    sourceMode: z.object({ enabled: z.boolean(), allowlist: z.array(z.string()) }),
    capabilities: capabilitiesSchema,
    serverTime: isoTime,
  })
  .meta({ id: "StateView" });
export type StateView = z.infer<typeof stateViewSchema>;

export const verificationResultSchema = z
  .object({
    version: z.string(),
    release: z.object({
      sha256: sha256Hex.nullable(),
      document: z.enum(["verified", "not_checked"]),
      channel: z.enum(CHANNELS),
      notesUrl: z.string().nullable(),
      manualSteps: z.object({
        required: z.boolean(),
        summary: z.string().nullable(),
        url: z.string().nullable(),
      }),
      minimumFromVersion: z.string().nullable(),
    }),
    refusals: z.array(z.string()),
    images: z.array(
      z.object({
        key: z.string(),
        ref: z.string(),
        signature: z.enum(["verified", "failed", "not_checked"]),
        exists: z.boolean().nullable(),
        error: z.string().nullable(),
      }),
    ),
    checkedAt: isoTime,
  })
  .meta({ id: "VerificationResult" });
export type VerificationResult = z.infer<typeof verificationResultSchema>;

export const releasesViewSchema = z
  .object({
    channel: z.enum(CHANNELS),
    running: z.string().nullable(),
    releases: z.array(
      z.object({
        version: z.string(),
        tag: z.string(),
        channel: z.enum(CHANNELS),
        publishedAt: z.string().nullable(),
        notesUrl: z.string().nullable(),
        releaseSha256: sha256Hex.nullable(),
        minimumFromVersion: z.string().nullable(),
        manualStepsRequired: z.boolean(),
        refusals: z.array(z.string()),
        verified: z.literal(false),
      }),
    ),
    nextInstallable: z.string().nullable(),
    checkedAt: isoTime,
  })
  .meta({ id: "ReleasesView" });
export type ReleasesView = z.infer<typeof releasesViewSchema>;

export const eventsViewSchema = z
  .object({
    events: z.array(journalEventSchema),
    /** Id of the last returned event (the next cursor), null when none was returned. */
    next: z.string().nullable(),
    /** `after` is older than the oldest retained event: events were lost. */
    gap: z.boolean(),
  })
  .meta({ id: "EventsView" });
export type EventsView = z.infer<typeof eventsViewSchema>;

export const runsViewSchema = z
  .object({ runs: z.array(runSummarySchema) })
  .meta({ id: "RunsView" });
export type RunsView = z.infer<typeof runsViewSchema>;

export const backupsViewSchema = z
  .object({ backups: z.array(backupInfoSchema) })
  .meta({ id: "BackupsView" });
export type BackupsView = z.infer<typeof backupsViewSchema>;

export const configViewSchema = z
  .object({
    configHash: sha256Hex,
    /** The effective configuration with secret-bearing values redacted. */
    config: z.record(z.string(), z.unknown()),
  })
  .meta({ id: "ConfigView" });
export type ConfigView = z.infer<typeof configViewSchema>;

export const healthViewSchema = z.object({ status: z.literal("ok") }).meta({ id: "Health" });

export const publicStatusSchema = z
  .object({
    phase: z.enum(PHASES),
    runId: z.string().nullable(),
    outcome: z.enum(OUTCOMES).nullable(),
    startsAt: isoTime.nullable(),
    startedAt: isoTime.nullable(),
    finishedAt: isoTime.nullable(),
    step: z.enum(STEP_IDS).nullable(),
    steps: z.array(z.object({ id: z.enum(STEP_IDS), status: z.enum(STEP_STATUSES) })),
    progress: z.number().int().min(0).max(100),
    message: messageSchema.nullable(),
    failureCode: z.string().nullable(),
    /** Only with publicStatus.showVersions. */
    targetVersion: z.string().optional(),
    /** Only with publicStatus.showVersions. */
    fromVersion: z.string().nullable().optional(),
    serverTime: isoTime,
  })
  .meta({ id: "PublicStatus" });
export type PublicStatus = z.infer<typeof publicStatusSchema>;

export const problemSchema = z
  .looseObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int(),
    detail: z.string().optional(),
    code: z.string(),
    blockers: z.array(blockerSchema).optional(),
    errors: z
      .array(z.object({ path: z.string(), message: z.string() }))
      .max(10)
      .optional(),
    reasons: z.array(z.string()).optional(),
    checks: verificationResultSchema.optional(),
    feedError: z.string().optional(),
  })
  .meta({ id: "Problem" });
export type Problem = z.infer<typeof problemSchema>;

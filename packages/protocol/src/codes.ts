/**
 * Every code that crosses a boundary of cicd-updater: steps, phases, outcomes,
 * failure, blocker, warning, message, problem and refusal codes. Clients render
 * them (the `messages` catalogs translate them); the sidecar never sends prose.
 *
 * Stability (docs/versioning.md): codes are never removed or renamed in 1.x.
 * Adding a code is a minor change, and clients MUST render unknown codes
 * generically.
 */

/** The steps of a run, in default execution order. */
export const STEP_IDS = [
  "prepare",
  "fetch",
  "backup",
  "stop",
  "migrate",
  "start",
  "health",
  "smoke",
  "finish",
] as const;
export type StepId = (typeof STEP_IDS)[number];

/** Execution order when `hooks.backup.quiesce` is true: the stop step precedes the backup. */
export const QUIESCED_STEP_ORDER: readonly StepId[] = [
  "prepare",
  "fetch",
  "stop",
  "backup",
  "migrate",
  "start",
  "health",
  "smoke",
  "finish",
];

/** Share of the whole run each step accounts for, in percent (sums to 100). */
export const STEP_WEIGHTS: Readonly<Record<StepId, number>> = {
  prepare: 5,
  fetch: 30,
  backup: 15,
  stop: 5,
  migrate: 10,
  start: 10,
  health: 15,
  smoke: 5,
  finish: 5,
};

export const STEP_STATUSES = ["pending", "running", "done", "failed", "skipped"] as const;
export type StepStatus = (typeof STEP_STATUSES)[number];

export const PHASES = ["idle", "scheduled", "running", "succeeded", "failed"] as const;
export type Phase = (typeof PHASES)[number];

export const OUTCOMES = ["succeeded", "unchanged", "rolled_back", "needs_attention"] as const;
export type Outcome = (typeof OUTCOMES)[number];

export const UPDATE_MODES = ["image", "source"] as const;
export type UpdateMode = (typeof UPDATE_MODES)[number];

export const TRUST_MODES = ["keyless", "key", "none"] as const;
export type TrustMode = (typeof TRUST_MODES)[number];

export const CHANNELS = ["stable", "beta"] as const;
export type Channel = (typeof CHANNELS)[number];

export const PLATFORMS = ["linux/amd64", "linux/arm64"] as const;
export type Platform = (typeof PLATFORMS)[number];

/** Failure codes `<step>.<reason>` (design 5.4). */
export const FAILURE_CODES = [
  "prepare.docker_unreachable",
  "prepare.docker_too_old",
  "prepare.compose_missing",
  "prepare.compose_invalid",
  "prepare.compose_unsupported",
  "prepare.project_mismatch",
  "prepare.env_unwritable",
  "prepare.state_unwritable",
  "prepare.disk_space",
  "prepare.updater_image_unpinned",
  "prepare.multiple_updaters",
  "prepare.api_exposed",
  "prepare.verifier_unavailable",
  "prepare.release_signature_invalid",
  "prepare.release_mismatch",
  "prepare.running_version_unknown",
  "prepare.not_newer",
  "prepare.below_minimum_version",
  "prepare.manual_steps_required",
  "prepare.updater_too_old",
  "prepare.env_missing",
  "prepare.image_missing",
  "prepare.platform_unsupported",
  "fetch.signature_missing",
  "fetch.signature_invalid",
  "fetch.verifier_failed",
  "fetch.registry_unauthorized",
  "fetch.registry_unreachable",
  "fetch.registry_rate_limited",
  "fetch.image_not_found",
  "fetch.pull_failed",
  "fetch.digest_mismatch",
  "fetch.version_label_mismatch",
  "fetch.source_not_allowed",
  "fetch.token_unavailable",
  "fetch.download_failed",
  "fetch.build_failed",
  "backup.baseline_unavailable",
  "backup.insufficient_space",
  "backup.failed",
  "backup.timeout",
  "backup.verify_failed",
  "stop.failed",
  "migrate.failed",
  "migrate.timeout",
  "start.env_changed",
  "start.env_write_failed",
  "start.failed",
  "health.timeout",
  "health.crashed",
  "health.version_mismatch",
  "health.unhealthy",
  "smoke.failed",
  "aborted",
  "interrupted",
  "missed_start",
] as const;
export type FailureCode = (typeof FAILURE_CODES)[number];

/** Why an update cannot start now (`capabilities.blockers`, design 5.11). */
export const BLOCKER_CODES = [
  "docker_unreachable",
  "docker_too_old",
  "compose_missing",
  "compose_invalid",
  "compose_unsupported",
  "project_mismatch",
  "env_unwritable",
  "state_unwritable",
  "disk_space",
  "updater_image_unpinned",
  "multiple_updaters",
  "api_exposed",
  "verifier_unavailable",
] as const;
export type BlockerCode = (typeof BLOCKER_CODES)[number];

/** The failure code a blocker becomes when the run's deep preflight finds it. */
export function blockerFailureCode(code: BlockerCode): FailureCode {
  return `prepare.${code}` as FailureCode;
}

/** Facts that do not block, but that a UI shows (`capabilities.warnings`). */
export const WARNING_CODES = [
  "trust_mode_none",
  "updater_image_not_digest_pinned",
  "self_label_missing",
  "health_without_app_check",
  "backup_none_with_probe",
  "source_mode_enabled",
] as const;
export type WarningCode = (typeof WARNING_CODES)[number];

/** Codes of `run.message` (design 5.13); a code not listed never reaches a client. */
export const MESSAGE_CODES = [
  "run.scheduled",
  "run.rescheduled",
  "run.starting",
  "run.succeeded",
  "run.unchanged",
  "run.rolled_back",
  "run.needs_attention",
  "run.interrupted",
  "run.aborting",
  "step.prepare.checking",
  "step.prepare.verifying_compose",
  "step.fetch.verifying_signature",
  "step.fetch.signature_not_checked",
  "step.fetch.pulling",
  "step.fetch.verifying_digests",
  "step.fetch.downloading",
  "step.fetch.building",
  "step.backup.baseline",
  "step.backup.creating",
  "step.backup.verifying",
  "step.backup.encrypting",
  "step.stop.stopping",
  "step.migrate.running",
  "step.start.writing_env",
  "step.start.starting",
  "step.health.waiting",
  "step.health.checking_app",
  "step.health.verifying_services",
  "step.smoke.checking",
  "step.finish.cleaning",
  "rollback.freezing",
  "rollback.probing",
  "rollback.restoring_env",
  "rollback.restarting",
  "rollback.waiting",
  "rollback.done",
  "rollback.failed",
  "attention.stopping",
  "attention.backup_kept",
] as const;
export type MessageCode = (typeof MESSAGE_CODES)[number];

/** Problem codes of the HTTP API (`urn:cicd-updater:problem:<code>`) with their status. */
export const PROBLEM_STATUS = {
  unauthorized: 401,
  not_found: 404,
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_request: 422,
  release_not_found: 404,
  release_unverifiable: 422,
  release_refused: 409,
  release_mismatch: 409,
  source_not_allowed: 409,
  busy: 409,
  blocked: 409,
  not_scheduled: 409,
  point_of_no_return: 409,
  not_finished: 409,
  feed_unavailable: 502,
  internal: 500,
} as const;
export type ProblemCode = keyof typeof PROBLEM_STATUS;
export const PROBLEM_CODES = Object.keys(PROBLEM_STATUS) as ProblemCode[];

/** The URI of a problem type. */
export function problemType(code: string): string {
  return `urn:cicd-updater:problem:${code}`;
}

/** Why a release cannot be installed (`release_refused.reasons`, verification `refusals`). */
export const REFUSAL_CODES = [
  "not_newer",
  "below_minimum_version",
  "manual_steps_required",
  "updater_too_old",
  "env_missing",
  "platform_unsupported",
  "image_missing",
  "running_version_unknown",
  "no_release_document",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

/** Journal actions (audit events the app ingests with a cursor, design 6.4). */
export const JOURNAL_ACTIONS = [
  "update.scheduled",
  "update.rescheduled",
  "update.cancelled",
  "update.abort_requested",
  "update.started",
  "update.succeeded",
  "update.failed",
  "update.acknowledged",
] as const;
export type JournalAction = (typeof JOURNAL_ACTIONS)[number];

/** Feed error codes (`FeedError.code`, design 7.4). */
export const FEED_ERROR_CODES = [
  "rate_limited",
  "unauthorized",
  "forbidden",
  "not_found",
  "server_error",
  "network",
  "timeout",
  "invalid_response",
  "no_release",
  "redirect",
] as const;
export type FeedErrorCode = (typeof FEED_ERROR_CODES)[number];

/** Codes of a release document that cannot be used (validation and verification). */
export const RELEASE_DOCUMENT_ERRORS = [
  "release.not_json",
  "release.too_large",
  "release.bom",
  "release.unsupported_schema",
  "release.schema",
  "release.channel_mismatch",
  "release.tag_mismatch",
  "release.image_tag_mismatch",
  "release.minimum_not_lower",
  "release.mismatch",
] as const;
export type ReleaseDocumentError = (typeof RELEASE_DOCUMENT_ERRORS)[number];

/** Optional capabilities a sidecar announces in `StateView.api.features` (design 6.6). */
export const API_FEATURES = [
  "abort",
  "reschedule",
  "verification",
  "source_mode",
  "encryption",
  "events",
  "backups",
  "public_status",
  "maintenance_page",
] as const;
export type ApiFeature = (typeof API_FEATURES)[number];

/** The API version this build speaks (path prefix `/v1`). */
export const API_VERSION = "1.0";

/** Labels the project sets on containers (fixed for 1.x). */
export const LABEL_PREFIX = "io.github.restow-backup.cicd-updater";
export const ROLE_LABEL = `${LABEL_PREFIX}.role`;
export const MANAGED_LABEL = `${LABEL_PREFIX}.managed`;
export const SIDECAR_ROLE = "sidecar";

/** Default lead times an admin can announce an update with, in seconds. */
export const DEFAULT_LEAD_TIMES: readonly number[] = [0, 60, 300, 900, 1800, 3600];

/** Whether a string is a known failure code. */
export function isFailureCode(value: string): value is FailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

/** The step a failure code belongs to (null for `aborted`, `interrupted`, `missed_start`). */
export function stepOfFailure(code: FailureCode): StepId | null {
  const dot = code.indexOf(".");
  if (dot === -1) {
    return null;
  }
  return code.slice(0, dot) as StepId;
}

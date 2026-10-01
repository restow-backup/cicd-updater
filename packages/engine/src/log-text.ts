import type { MessageCode } from "@cicd-updater/protocol";

export type Params = Record<string, string | number>;

/**
 * The English operator log line for every message code. Message parameters
 * (what clients and the public status see) are versions, codes and counts
 * only; `details` (images, files) appear only here, in `run.log`.
 */
export const LOG_TEXT: Record<MessageCode, (p: Params) => string> = {
  "run.scheduled": (p) => `Update to ${p.version} scheduled for ${p.startsAt}.`,
  "run.rescheduled": (p) => `Update to ${p.version} moved to ${p.startsAt}.`,
  "run.starting": (p) => `Starting the update to ${p.version}.`,
  "run.succeeded": (p) => `Update to ${p.version} finished; the new version answers.`,
  "run.unchanged": (p) =>
    `The update failed (${p.code}) before the point of no return; nothing changed.`,
  "run.rolled_back": (p) => `The update failed (${p.code}); the previous version runs again.`,
  "run.needs_attention": (p) =>
    `The update failed (${p.code}) and needs attention: managed services were stopped, the backup was kept.`,
  "run.interrupted": () => "The sidecar restarted while the update was running.",
  "run.aborting": () => "Abort requested; the update stops at its next check point.",
  "step.prepare.checking": () =>
    "Checking Docker, the Compose project, the release document and the running version.",
  "step.prepare.verifying_compose": () =>
    "Checking that every managed service takes its image from its variable.",
  "step.fetch.verifying_signature": (p) =>
    `Verifying the signature of ${p.ref ?? "image"} (${p.index}/${p.total})${p.identity ? ` for ${p.identity}` : ""}.`,
  "step.fetch.signature_not_checked": () =>
    "Signature not checked (trust mode none); the digests are still checked.",
  "step.fetch.pulling": (p) => `Pulling ${p.ref ?? "image"} (${p.index}/${p.total}).`,
  "step.fetch.verifying_digests": () =>
    "Verifying that the pulled images carry the verified digests.",
  "step.fetch.downloading": (p) => `Downloading the source archive of ${p.version}.`,
  "step.fetch.building": (p) => `Building ${p.ref ?? "image"} (${p.index}/${p.total}).`,
  "step.backup.baseline": () => "Reading the migration probe value before the update.",
  "step.backup.creating": (p) => `Creating the backup${p.file ? ` ${p.file}` : ""}.`,
  "step.backup.verifying": (p) => `Verifying the backup${p.file ? ` ${p.file}` : ""}.`,
  "step.backup.encrypting": () => "Encrypting the backup with age.",
  "step.stop.stopping": (p) => `Stopping ${p.services ?? "services"}.`,
  "step.migrate.running": (p) =>
    `Running the migration command in a one-off container of ${p.service ?? "the service"}.`,
  "step.start.writing_env": (p) =>
    `Writing ${p.keys ?? "the new image references"} to the env file.`,
  "step.start.starting": (p) => `Starting group ${p.group}${p.services ? ` (${p.services})` : ""}.`,
  "step.health.waiting": (p) =>
    `Waiting for group ${p.group}${p.services ? ` (${p.services})` : ""} to run.`,
  "step.health.checking_app": (p) => `Waiting for the app to report version ${p.version}.`,
  "step.health.verifying_services": () =>
    "Verifying that every managed service runs and passes its checks.",
  "step.smoke.checking": (p) =>
    `Smoke check ${p.index}/${p.total}${p.check ? `: ${p.check}` : ""}.`,
  "step.finish.cleaning": () => "Pruning old backups, images, release documents and source trees.",
  "rollback.freezing": () => "Stopping every managed service that runs a new image before probing.",
  "rollback.probing": () => "Reading the migration probe value to compare it with the baseline.",
  "rollback.restoring_env": () =>
    "Restoring the previous lines of the writable keys byte for byte.",
  "rollback.restarting": (p) => `Starting the previous version (${p.version}).`,
  "rollback.waiting": () => "Waiting for the previous version to answer.",
  "rollback.done": () => "Rolled back; the previous version answers.",
  "rollback.failed": () => "The rollback did not succeed.",
  "attention.stopping": (p) => `Stopping ${p.services ?? "the managed services"} for the operator.`,
  "attention.backup_kept": (p) => `The backup ${p.file ?? ""} was kept for a restore.`,
};

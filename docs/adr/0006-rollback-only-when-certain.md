# 0006. Roll back only when it is certain

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 6 of section 0) |

## Context

Once the new version has started, it may have migrated the database. Starting the old code
on a schema the new version changed can corrupt data or fail in ways that are hard to see.
Restoring the database backup automatically would also discard everything written since
the backup, and it is destructive by nature.

An updater that "always rolls back" therefore guesses, and a wrong guess costs data.

## Decision

On a failure in a step, the sidecar decides by a fixed rule:

| Situation | Result |
| --- | --- |
| failure before the point of no return (the start of the `stop` step) | partial artefacts discarded, outcome `unchanged` |
| nothing new was started yet (`applyAttempted` not set) | roll back |
| `rollback.policy: never` | `needs_attention` |
| `rollback.policy: always` (the app declares it has no persistent schema) | roll back |
| `rollback.policy: probe` | stop every service running a new image (freeze), read the migration probe, compare with the value taken before the backup: equal means roll back; different, unknown or a failed freeze means `needs_attention` |

A rollback restores the previous lines of the writable env keys byte for byte, starts the
previous images and waits for the services and, with an app health check, for the app to
report the previous version. If that fails, the run ends in `needs_attention` with both
reasons.

`needs_attention` stops the services marked `stopOnAttention`, keeps the backup (retention
never deletes it while it is referenced), and records the recovery facts: backup file,
previous version, previous images, previous env lines and the rendered restore commands.
The sidecar never restores a database on its own.

## Consequences

- Old code never starts on a schema the new version changed.
- When a rollback is not certain, the operator gets exact facts and commands instead of a
  guess ([backups and recovery](../backups-and-recovery.md)).
- Apps with persistent data need a migration probe for automatic rollbacks. Presets cover
  common migration tools; an optional schema fingerprint catches DDL a failed,
  non-transactional migration left behind.
- Some failures leave the app stopped until an operator acts; the edge keeps serving the
  maintenance page meanwhile.

## Alternatives considered

- **Always roll back the images.** Rejected: risks running old code on a new schema.
- **Always restore the backup.** Rejected: destructive, loses data written since the
  backup, and a non-goal for 1.0.
- **Never roll back.** Rejected: manual work even in the many cases where a rollback is
  provably safe (for example a health failure before any migration ran).
- **Probe without freezing the new services.** Rejected: a new container that is still
  running could apply a migration between the probe and the decision. Only a stopped new
  version makes "unchanged" a fact.

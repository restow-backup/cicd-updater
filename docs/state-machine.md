# State machine

This page describes how a run moves from scheduling to its end: the phases, the steps and
what each one does, every failure code, the exact rollback rule, cancelling and aborting,
what happens after a restart, and the files that hold the state. The engine
(`packages/engine/src/engine.ts`) is driven only through interfaces, so every path below is
covered by unit tests with fakes; the end-to-end tests against real Docker are tracked in
[compatibility](compatibility.md).

Three rules hold everywhere:

- The state is written to `status.json` before the side effect that follows it.
- A failure is never guessed: the previous version is started again only when it is certain
  that the new version did not change the data.
- After a restart the sidecar never starts or stops application services on its own.

## Phases

```
              schedule                startsAt reached                 end of run
    idle --------------------> scheduled ----------------> running ------------------> succeeded
     ^                          |    ^                      |                          failed
     |          cancel          |    | reschedule           | abort (before the            |
     +--------------------------+    +------+               |  point of no return)        |
     ^                                                      +----> failed (unchanged)      |
     |                                                                                     |
     +--------------------------------- acknowledge -------------------------------------+
```

| Phase | Meaning |
| --- | --- |
| `idle` | nothing announced; finished runs are in `history` |
| `scheduled` | announced, counting down to `startsAt`; can be rescheduled or cancelled |
| `running` | steps are executing; an abort is possible only before the point of no return |
| `succeeded` | finished; the new version answers |
| `failed` | finished without success; `run.outcome` says in which state the installation is |

A finished run stays the current run (phase `succeeded` or `failed`) until it is
acknowledged, so every admin sees the result. Scheduling a new run while the phase is
`succeeded` or `failed` acknowledges the old one implicitly.

## Steps

| Step | Weight | Default order | With `backup.quiesce: true` | Skipped when |
| --- | --- | --- | --- | --- |
| `prepare` | 5 | 1 | 1 | never |
| `fetch` | 30 | 2 | 2 | never |
| `backup` | 15 | 3 | 4 | `hooks.backup.type: none` and `rollback.policy` is not `probe` |
| `stop` | 5 | 4 | 3 | no service has `stopBeforeUpdate: true` |
| `migrate` | 10 | 5 | 5 | no `hooks.migrate` |
| `start` | 10 | 6 | 6 | never |
| `health` | 15 | 7 | 7 | never (without an app check it still waits for the containers) |
| `smoke` | 5 | 8 | 8 | no `hooks.smoke.checks` |
| `finish` | 5 | 9 | 9 | never |

`hooks.backup.type: volume` always uses the quiesced order. With `type: none` and
`rollback.policy: probe` the `backup` step runs only to read the probe baseline.

`run.steps` lists the steps in execution order; skipped steps have the status `skipped` from
the start. Each step is `pending`, `running`, `done`, `failed` or `skipped`.

**Progress** is the sum of the weights of the `done` and `skipped` steps plus half the weight
of the `running` step, rounded, and never decreases. A succeeded run is at 100.

### The point of no return

The **point of no return (PONR)** is the beginning of the `stop` step, also when the step is
skipped. The sidecar records it (`ponrReached`) before it stops anything. In the quiesced
order it comes before the backup.

Two more facts are recorded during a run and decide how a failure ends:

| Fact | Set |
| --- | --- |
| `applyAttempted` | immediately before the first command that could start a new image: the `migrate` run, or the first `compose up` of the `start` step |
| `envWritten` | immediately before the new references are written into the env file |

```
 prepare --> fetch --> backup --> | stop --> migrate --> start --> health --> smoke --> finish
                                  ^
                     point of no return (default order)

 prepare --> fetch --> | stop --> backup --> migrate --> start --> health --> smoke --> finish
                       ^
          point of no return (quiesced order)

 failure left of the mark: outcome unchanged
 failure right of the mark: the rollback rule decides (rolled_back or needs_attention)
```

## What each step does

### prepare

1. **Deep preflight**: every blocker of [troubleshooting](troubleshooting.md#blockers),
   including the Compose probe. The first blocker fails the step as `prepare.<blocker>`.
2. **Env file**: read it (`prepare.env_unwritable` when it cannot be read) and register the
   values of keys matching `env.redactKeyPattern` with the redactor.
3. **Release document**: load the `release.json` stored at scheduling. Its SHA-256 must equal
   the one recorded in the run (`prepare.release_mismatch`). In `keyless` and `key` mode its
   bundle is verified again, without refetching (`prepare.release_signature_invalid`). The
   document is validated again (version, tag, project) (`prepare.release_mismatch`). In
   source mode a release without `release.json` skips these checks.
4. **Running version and refusals**: detect the running version (see
   [hooks](hooks.md#the-running-version)) and refuse when it is unknown
   (`prepare.running_version_unknown`), not strictly older than the target
   (`prepare.not_newer`), below `upgrade.minimumFromVersion` (`prepare.below_minimum_version`),
   when the release requires manual steps (`prepare.manual_steps_required`), when the
   sidecar's version does not satisfy `requires.updater` (`prepare.updater_too_old`), or when
   a key of `requires.env` is missing or empty in the env file (`prepare.env_missing`; the
   detail names the keys, never values).
5. **Image plan**: for each managed service the release image of `services[].image` (with the
   mirror of `images.<key>.repository` applied). A missing key fails with
   `prepare.image_missing` unless the service is `optional` (then it keeps its current image
   and its key is not written). The host platform must be in the image's `platforms`
   (`prepare.platform_unsupported`).
6. **Compose probe**: `docker compose config` with every writable key set to
   `cicd-updater-probe.invalid/<key>:probe`. Every managed service must resolve to the probe
   value of its `imageVar` (`prepare.compose_unsupported`, the detail names the services), and
   the sidecar's own service must not resolve to any probe value
   (`prepare.updater_image_unpinned`). A failing `compose config` is `prepare.compose_invalid`.
7. **Capture**: the resolved image of every managed service (`previousImages`) and, byte for
   byte, the last assignment line of every writable key, including "absent"
   (`previousEnv`), are persisted.

### fetch (image mode)

1. For each distinct image of the plan, `ref = <repository>@<digest>`.
2. `keyless` and `key`: verify the signature of `ref` in the isolated verifier
   (`fetch.signature_missing`, `fetch.signature_invalid`, `fetch.registry_unauthorized`,
   `fetch.registry_unreachable`, `fetch.registry_rate_limited`, `fetch.image_not_found`,
   `fetch.verifier_failed`). `none`: the run records `signatures: not_checked` and logs it.
3. `docker pull <ref>`, by digest, with the registry credentials of
   `docker.registryAuthFile`. Errors are classified, never conflated (see
   [registry errors](troubleshooting.md#registry-access-denied-versus-not-found)).
4. The local image must be known by that digest (`fetch.digest_mismatch`).
5. If the image carries the label `org.opencontainers.image.version`, it must equal the target
   version (`fetch.version_label_mismatch`).

The reference written later is `<repository>:<tag>@<digest>`.

### fetch (source mode)

1. The feed repository must be allowed by `source.allowlist` (`fetch.source_not_allowed`).
2. Download the tag's archive into `/state/src/<runId>/` (`fetch.download_failed`;
   `fetch.token_unavailable` when the token file cannot be read).
3. Extract it safely and build each image key with `docker build`, tagged
   `cicd-updater.local/<project>/<imageKey>:<version>` (`fetch.build_failed`).
4. The source tree is removed afterwards, on success and on failure.

### backup

1. With `rollback.policy: probe`, read the probe **baseline** and persist it
   (`backup.baseline_unavailable` when the probe fails).
2. With a backup type other than `none`: check the space, create, verify, optionally encrypt
   the backup and write its metadata (`backup.insufficient_space`, `backup.failed`,
   `backup.timeout`, `backup.verify_failed`), then apply the retention. See
   [hooks](hooks.md#backup).

### stop

`docker compose stop -t <timeouts.stopSeconds>` for the services with
`stopBeforeUpdate: true`, group by group in descending `startOrder` (`stop.failed`).

### migrate

Persist `applyAttempted`, then run `hooks.migrate` with the new image:
`docker compose run --rm --no-deps -T --name cicd-updater-migrate-<runId> <service> <argv>`,
with the writable keys set to the new references in the process environment only
(`migrate.failed`, `migrate.timeout`). See [hooks](hooks.md#separate-migrations-hooksmigrate).

### start

1. The current lines of the writable keys must still equal the captured ones
   (`start.env_changed`: someone edited them during the run).
2. Persist `envWritten`, then write the new references (and `env.versionVar`) into the env
   file (`start.env_write_failed`). Only these lines change; the file is replaced atomically
   with its mode and owner, or rewritten in place when it is a single-file bind mount.
3. Persist `applyAttempted` (if not yet set), then
   `docker compose up -d --no-deps --no-build --pull never <services of the lowest group>`
   (`start.failed`).

### health

For each start group in ascending order: start it (from the second group on; `start.failed`
in step `health`), wait for its containers (`health.timeout`, `health.crashed`,
`health.unhealthy`), and after `health.afterGroup` wait for the app check with the target
version (`health.timeout`, `health.version_mismatch`). After the last group: the app check
once more, every managed service `running` within `servicesGraceSeconds`, every per-service
check (`health.unhealthy`). See [hooks](hooks.md#health).

### smoke

Every check with its retries; the first check that does not pass fails the step
(`smoke.failed`).

### finish

Apply the backup retention, remove old images of the managed repositories (keeping the
current image, the previous one used for a rollback and `cleanup.keepPreviousImages` more;
only images no container uses; `docker image rm` without force; never a global prune), keep
the last five release documents, remove source trees, then record `succeeded`. Errors here
are logged as warnings only: housekeeping never turns a successful update into a failed one.

## Failure codes

A failure code is `<step>.<reason>`, or one of `aborted`, `interrupted`, `missed_start`.
Clients translate codes; the sidecar never sends prose. Unknown codes must be rendered
generically, because 1.x may add codes. The remedies are in
[troubleshooting](troubleshooting.md).

| Code | Step | Before the PONR | Meaning |
| --- | --- | --- | --- |
| `prepare.docker_unreachable` | prepare | yes | the socket is missing or the daemon does not answer |
| `prepare.docker_too_old` | prepare | yes | Engine API older than 1.43 |
| `prepare.compose_missing` | prepare | yes | no Compose file found |
| `prepare.compose_invalid` | prepare | yes | `docker compose config` fails |
| `prepare.compose_unsupported` | prepare | yes | a managed service does not take its image from its `imageVar` |
| `prepare.project_mismatch` | prepare | yes | configured project directory or name differs from the container labels |
| `prepare.env_unwritable` | prepare | yes | the env file is missing or not writable (or its directory) |
| `prepare.state_unwritable` | prepare | yes | the state volume is not writable |
| `prepare.disk_space` | prepare | yes | less free space than `docker.minFreeMb` |
| `prepare.updater_image_unpinned` | prepare | yes | the sidecar's own image follows a writable key |
| `prepare.multiple_updaters` | prepare | yes | another sidecar runs for this project |
| `prepare.api_exposed` | prepare | yes | the sidecar has a published port |
| `prepare.verifier_unavailable` | prepare | yes | the isolated verifier cannot start |
| `prepare.release_signature_invalid` | prepare | yes | the stored `release.json` no longer verifies |
| `prepare.release_mismatch` | prepare | yes | the stored document is missing, differs from the scheduled one, or its project or tag does not match |
| `prepare.running_version_unknown` | prepare | yes | the running version cannot be determined |
| `prepare.not_newer` | prepare | yes | the target is not newer than the running version |
| `prepare.below_minimum_version` | prepare | yes | the running version is below `minimumFromVersion` |
| `prepare.manual_steps_required` | prepare | yes | the release requires manual steps |
| `prepare.updater_too_old` | prepare | yes | the sidecar does not satisfy `requires.updater` |
| `prepare.env_missing` | prepare | yes | keys of `requires.env` are missing or empty |
| `prepare.image_missing` | prepare | yes | the release lacks an image a non-optional service needs |
| `prepare.platform_unsupported` | prepare | yes | the host platform is not in the release |
| `fetch.signature_missing` | fetch | yes | no signature found for the digest |
| `fetch.signature_invalid` | fetch | yes | signed by another identity or key, or broken |
| `fetch.verifier_failed` | fetch | yes | cosign could not run or could not reach Sigstore or the registry |
| `fetch.registry_unauthorized` | fetch | yes | the registry refused access |
| `fetch.registry_unreachable` | fetch | yes | network, DNS or TLS problem, or a pull timeout |
| `fetch.registry_rate_limited` | fetch | yes | the registry's rate limit |
| `fetch.image_not_found` | fetch | yes | the manifest for the digest does not exist (access confirmed) |
| `fetch.pull_failed` | fetch | yes | another pull error |
| `fetch.digest_mismatch` | fetch | yes | the local image does not carry the verified digest |
| `fetch.version_label_mismatch` | fetch | yes | the OCI version label differs from the target |
| `fetch.source_not_allowed` | fetch | yes | source mode is not allowed for this repository |
| `fetch.token_unavailable` | fetch | yes | the token file is missing or unreadable |
| `fetch.download_failed` | fetch | yes | downloading or extracting the source archive failed |
| `fetch.build_failed` | fetch | yes | `docker build` failed |
| `backup.baseline_unavailable` | backup | yes (no in quiesced order) | the migration probe failed before the update |
| `backup.insufficient_space` | backup | yes (no in quiesced order) | the estimated backup does not fit |
| `backup.failed` | backup | yes (no in quiesced order) | the backup command failed |
| `backup.timeout` | backup | yes (no in quiesced order) | the backup exceeded `timeoutSeconds` |
| `backup.verify_failed` | backup | yes (no in quiesced order) | the backup did not verify |
| `stop.failed` | stop | no | `compose stop` failed |
| `migrate.failed` | migrate | no | the migration command exited non-zero |
| `migrate.timeout` | migrate | no | the migration exceeded its limit |
| `start.env_changed` | start | no | env file lines changed during the run |
| `start.env_write_failed` | start | no | the env file could not be read or written |
| `start.failed` | start or health | no | `compose up` failed |
| `health.timeout` | health | no | the services or the app were not healthy in time |
| `health.crashed` | health | no | a managed container keeps exiting |
| `health.version_mismatch` | health | no | the app is healthy but reports another version |
| `health.unhealthy` | health | no | Docker health `unhealthy`, a missing healthcheck with `waitForDockerHealth: always`, a service not running at the end, or a per-service check failed |
| `smoke.failed` | smoke | no | a smoke check failed |
| `aborted` | prepare, fetch or backup | yes | an operator aborted before the point of no return |
| `interrupted` | the step that was running | depends | the sidecar restarted during the run |
| `missed_start` | none | yes | the sidecar was down past `startsAt` plus `schedule.lateStartToleranceSeconds` |

An unexpected error inside a step is reported with that step's general code (for example
`fetch.pull_failed` or `backup.failed`). The failure detail (`run.failure.detail`) is
redacted and at most 2000 characters.

## Outcomes

| Outcome | Meaning | Services afterwards | Env file |
| --- | --- | --- | --- |
| `succeeded` | the new version runs and passed health (and smoke) | new images | new references |
| `unchanged` | failed or aborted before the point of no return | never stopped | untouched |
| `rolled_back` | failed after the PONR; it is certain the new version did not change the data; the previous images run again and passed the previous version's health check | previous images | restored byte for byte |
| `needs_attention` | failed after the PONR and a rollback was not certain to be safe, or the rollback failed, or the sidecar was interrupted after the PONR | services with `stopOnAttention` stopped (not after an interruption) | as the failure left it; the previous lines are in `recovery` |

`interrupted` is a failure code, not an outcome: an interrupted run ends `unchanged`,
`succeeded` or `needs_attention` (see [restart and resume](#restart-and-resume)).

`run.failure.schemaChanged` says what the sidecar knows about the schema: `false` (the probe
proved it unchanged, or nothing new ran), `true` (the probe value changed), `null` (unknown).

## The rollback rule

On a failure in step S:

```
if the PONR was not reached:
    discard partial artefacts                                  -> unchanged
elif not applyAttempted:          # stop, or a quiesced backup, failed; nothing new ran
    rollback()                    # the env file was not written
elif rollback.policy == "never":
    attention(schemaChanged = null)
elif rollback.policy == "always": # the app declares it has no persistent schema
    rollback()
else:                             # "probe"
    freeze: docker compose stop -t <stopSeconds> every managed service the run started
            with a new image; remove the migration container
    if the freeze failed:         # a new container may still be migrating
        attention(schemaChanged = null)
    after = probe()
    if the baseline is unknown or the probe failed:  attention(schemaChanged = null)
    elif after == baseline:                          rollback()
    else:                                            attention(schemaChanged = true)

rollback():
    if the sidecar wrote the env file: restore the captured lines (byte-exact; absent keys removed)
    docker compose up -d --no-deps --no-build --pull never <managed services>, group by group
    wait for the services (health.timeoutSeconds) and, with an app check, for the previous
    version (expected version = run.fromVersion)
    success -> rolled_back
    failure -> attention(schemaChanged as known); the detail keeps both reasons

attention(schemaChanged):
    docker compose stop every managed service with stopOnAttention
    record recovery {backup, fromVersion, previousImages, previousEnv, commands}
    -> needs_attention
```

As a decision table:

| PONR reached | `applyAttempted` | `rollback.policy` | Freeze and probe | Action | Outcome | `schemaChanged` |
| --- | --- | --- | --- | --- | --- | --- |
| no | - | any | - | discard partial artefacts | `unchanged` | `false` |
| yes | no | any | - | rollback | `rolled_back` | `false` |
| yes | yes | `never` | - | attention | `needs_attention` | `null` |
| yes | yes | `always` | - | rollback | `rolled_back` | `null` |
| yes | yes | `probe` | freeze failed | attention | `needs_attention` | `null` |
| yes | yes | `probe` | no baseline, or the probe failed | attention | `needs_attention` | `null` |
| yes | yes | `probe` | value equals the baseline | rollback | `rolled_back` | `false` |
| yes | yes | `probe` | value differs from the baseline | attention | `needs_attention` | `true` |

Every `rollback` that fails (a `compose up` fails, the previous version does not become
healthy or reports another version) turns into `attention` with the `schemaChanged` value of
its row; the detail then carries the original reason and the rollback's reason (up to 950
characters each).

Why freeze first: a new container that is still running could apply a migration between the
probe and the decision. Only a stopped new version makes "unchanged" a fact. A rollback never
starts old code on a schema the new version changed.

When stopping the `stopOnAttention` services fails, the run still ends `needs_attention` and
the detail says the services could not be stopped completely.

## Cancel, abort, reschedule, acknowledge

| Request | Phase | Effect | HTTP |
| --- | --- | --- | --- |
| cancel | `scheduled` | the run goes to `history` with `cancelled: true`; phase `idle`; journal `update.cancelled` | 200 |
| cancel | `running`, PONR not reached | `abortRequestedAt` is persisted, message `run.aborting`, journal `update.abort_requested`; the engine stops at its next check point; outcome `unchanged`, code `aborted` | 202 |
| cancel | `running`, PONR reached | refused | 409 `point_of_no_return` |
| cancel | `succeeded`, `failed` | refused | 409 `not_scheduled` |
| reschedule | `scheduled` | new `startsAt` (validated as at scheduling), timer re-armed, journal `update.rescheduled`; a start time that has passed starts the run now | 200 |
| reschedule | other phases | refused | 409 `not_scheduled` |
| acknowledge | `succeeded`, `failed` | phase `idle`, the run stays in `history`, journal `update.acknowledged` | 200 |
| acknowledge | `scheduled`, `running` | refused | 409 `not_finished` |
| schedule | `succeeded`, `failed` | the old run is acknowledged implicitly (journal `update.acknowledged` with `implicit: true`) | 202 |
| schedule | `scheduled`, `running` | refused | 409 `busy` |

A request that names a run id other than the current run gets 404 `not_found`. Cancel,
acknowledge and reschedule accept an optional `requestedBy` (`{ id, label }`) for the
journal; without it the actor's label is `api` or `cli`.

Scheduling accepts `leadSeconds` from 0 to `schedule.maxLeadSeconds`, or `startsAt` from now
to now plus `schedule.maxLeadSeconds` (a time up to 60 seconds in the past is accepted and
starts now).

**Check points of an abort:** before each step, before each signature verification and each
pull, between the stages of a source build, and when the backup step ends. A PostgreSQL dump
and the probe baseline query are interrupted at once (the dump's backends are terminated).
MySQL, volume and command backups cannot be interrupted safely mid-way; an abort during them
takes effect when the backup step ends, and the finished backup is kept like any other.

## Restart and resume

Before the HTTP server accepts requests, the sidecar:

1. takes the state lock (see [locks](#locks)) and loads `status.json`. An unreadable or
   schema-invalid file, or one with a newer schema version than the sidecar knows, is moved
   aside as `status.json.corrupt-<epoch ms>` (the newest five are kept); the sidecar
   continues `idle` without history. The running installation is not affected.
2. removes leftovers: source trees under `/state/src/`, `*.partial` backups, containers with
   the label `io.github.restow-backup.cicd-updater.managed=true`, a leftover
   `cicd-updater-migrate-*` container; then applies the backup retention.
3. resolves the run by its phase:

| Phase found | Condition | Action |
| --- | --- | --- |
| `scheduled` | now is before `startsAt` | re-arm the timer |
| `scheduled` | now is at most `schedule.lateStartToleranceSeconds` after `startsAt` | start now |
| `scheduled` | later | fail with `missed_start`, outcome `unchanged` |
| `running` | the PONR was not reached | fail with `interrupted`, outcome `unchanged` |
| `running` | the current step is `finish` | outcome `succeeded` (health and smoke had passed); the journal event carries `resumed: true` |
| `running` | the PONR was reached, any other step | fail with `interrupted`, outcome `needs_attention`, with recovery information (including the backup if it had been created and verified) |
| `succeeded`, `failed`, `idle` | | nothing |

After an interruption past the PONR the sidecar does **not** stop or start any service. It
does not know what happened while it was gone, so it records `needs_attention` with
`schemaChanged: null` and leaves the containers as they are. Check them yourself (see the
[runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention)).

On SIGTERM or SIGINT the sidecar stops its timers, refuses to begin further steps (a step
that is waiting stops at its next check), flushes the store and exits within 8 seconds. The
run is then resolved by the table above at the next start. Give the service
`stop_grace_period: 30s`, and do not restart or upgrade the sidecar while a run is `running`.

## `status.json`

The run state lives in `/state/status.json` (`<state.dir>/status.json`), mode `0600`,
written atomically after every change: temporary file, fsync, rename, directory fsync.

| Field | Content |
| --- | --- |
| `schemaVersion` | `1` |
| `instanceId` | a random id created on first start, kept |
| `phase` | `idle`, `scheduled`, `running`, `succeeded` or `failed` |
| `run` | the current run (null in `idle`): id `r-<epoch ms>-<4 hex>`, versions, release SHA-256, trust mode, verification results, requester, times, steps, progress, message, failure, recovery, the references written, `configHash` and the redacted log (at most 200 lines of at most 400 characters) |
| `runContext` | bookkeeping for rollback and resume, never sent to clients: `previousEnv`, `previousImages`, `baseline`, `applyAttempted`, `ponrReached`, `envWritten`, `backupFile`, `plan` |
| `history` | finished runs, newest first, without their log, at most `state.historyLimit` |
| `events` | journal events, oldest first, at most `state.eventLimit` |
| `eventCounter` | the counter part of event ids |

The file is internal and not part of the stability promise. Clients read the API views
(`GET /v1/state`, `GET /v1/runs/{id}`), never the file. 1.0 writes schema version 1. A file
with a newer schema version than the sidecar knows is moved aside like a corrupt file; by the
versioning policy, later versions read older files and rewrite them on start. The JSON Schema
is `schemas/status.schema.json`.

Two CLI commands read the file directly, so they work while the HTTP server does not answer:
`cicd-updater recover restore-env` and (for the backup files next to it)
`cicd-updater backups cat`.

## Locks

| Level | Mechanism |
| --- | --- |
| in the process | one engine; scheduling performs every check that waits for I/O first, then re-checks the phase and changes it without waiting in between, so two requests cannot both pass |
| state directory | `/state/.lock`, created exclusively, holding `{ instanceId, owner, pid, hostname, heartbeatAt }`, refreshed every 15 seconds. A lock of another host (container) with a heartbeat younger than 60 seconds makes the process exit with code **75**. An older lock, or one left by the same container, is taken over with a warning. |
| project | a running container with the label `io.github.restow-backup.cicd-updater.role=sidecar` in the same Compose project (other than itself) is the blocker `multiple_updaters`. A sidecar without that label gets the warning `self_label_missing`. |

## Messages and the journal

`run.message` is a code with parameters (versions, failure codes, counts), for example
`step.fetch.pulling {index, total}` or `run.needs_attention {code}`. Image names, file names
and paths appear only in the run log. The public status removes the `version` parameter
unless `publicStatus.showVersions` is set. The message codes and the journal events are
listed in [HTTP API](http-api.md).

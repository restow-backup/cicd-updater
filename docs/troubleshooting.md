# Troubleshooting

This page lists every blocker, warning and failure code with its cause and remedy, explains
registry errors and the `doctor` output, and says where the logs are. The codes and their
English texts come from `packages/protocol/src/codes.ts` and
`packages/protocol/src/messages.ts`; the steps they belong to are in the
[state machine](state-machine.md#failure-codes).

## Where to look first

```sh
docker compose exec updater cicd-updater status       # phase, run, failure code and detail, blockers, warnings
docker compose exec updater cicd-updater logs         # the redacted log of the current run
docker compose exec updater cicd-updater doctor       # every prerequisite, one line each
docker compose logs --tail 200 updater                # the sidecar's process log
```

If the run ended in `needs_attention`, go to the
[runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention) first.

## Where the logs are

| Log | How to read it | Content |
| --- | --- | --- |
| Sidecar process log | `docker compose logs updater` | start and stop, configuration hash, every run log line prefixed with `[<runId>]`, warnings (backup pruning, cleanup), errors. Info and debug lines go to stdout, warnings and errors to stderr. Format `<ISO time> <LEVEL> <message>`, or one JSON object `{ time, level, message }` per line with `logging.format: json`. Level: `logging.level`. |
| Run log | `cicd-updater logs [<runId>]`, `GET /v1/runs/{id}` | at most 200 lines of at most 400 characters, `<ISO time> <text>`. Kept only for the current run: once a run is acknowledged (or a new one scheduled), its history entry has no log. Read it before you acknowledge, or use the process log. |
| Failure detail | `cicd-updater status`, `run.failure.detail` | the redacted reason, at most 2000 characters; for health failures the last 40 log lines of the service |
| Recovery information | `cicd-updater recover show` | backup, previous images, previous env lines, commands (runs that ended in `needs_attention`) |
| Journal | `GET /v1/events` | one event per action, for the app's audit log |
| App containers | `docker compose logs <service>` | what the app itself logged |

Every line passes the redactor: the API token, credential-looking env values (keys matching
`env.redactKeyPattern`), feed and registry tokens, and the patterns of
`logging.redactPatterns` are replaced by `[redacted]`. If you see a secret in a log, add a
pattern for its format to `logging.redactPatterns` and report it.

## Reading `doctor` output

`cicd-updater doctor` checks every prerequisite separately and read-only. Each line is

```
<STATUS> <check>: <detail>  [<file and key the check is about>]
```

with `STATUS` one of `OK`, `WARN`, `FAIL`, `SKIP`. With `--json` it prints
`{ checks: [{ name, status, detail, where }], exitCode }`.

| Check | `FAIL` or `WARN` means | Fix |
| --- | --- | --- |
| `configuration` | always `OK` when the checks run (with the first 12 characters of the configuration hash) | an invalid configuration ends the command before any check, with exit code 64 and the list of problems |
| `docker socket` | `docker.socket` is not a socket in the container | mount `/var/run/docker.sock:/var/run/docker.sock` |
| `docker engine` | the daemon does not answer, or Engine API older than 1.43 | start Docker; upgrade Docker Engine to 24 or newer |
| `compose files` | none of `compose.yaml`, `compose.yml`, `docker-compose.yaml`, `docker-compose.yml` (or the files of `compose.files`) is in `compose.projectDir` | mount the project directory at the same path; check `compose.files` |
| `compose configuration` | a managed service does not take its image from its key, or `docker compose config` fails | use `image: ${KEY}` with the `imageVar` of `updater.yaml`; run `docker compose config` by hand |
| `env file` | the env file is missing, or it or its directory is not writable | create it; mount the project directory read-write; check owner and mode |
| `state volume` | `state.dir` is not writable | mount a named volume at `/state` |
| `disk space` | less free space for backups (`/state/backups`: the state volume or a volume mounted there) than `docker.minFreeMb` | free space |
| `own container` (`SKIP`) | the process is not in a container, or Docker cannot be asked | run the doctor in the sidecar container (`docker compose exec updater ...`) |
| `own labels` (`WARN`) | the role label is missing | add `io.github.restow-backup.cicd-updater.role: sidecar` to the service |
| `own image pinned` (`WARN`) | the sidecar's image reference has no digest | pin it: `...:X.Y.Z@sha256:<digest>` |
| `published ports` | the sidecar container publishes a port | remove `ports:` from the service |
| `project directory` | the container's Compose label `working_dir` differs from `compose.projectDir` | set `CICD_UPDATER_COMPOSE__PROJECT_DIR` to the host path the project is started from |
| `verifier volume` | no named volume at `trust.verifier.workDir` (keyless and key mode with isolation) | mount `updater-verify:/verify` (a named volume, not a bind mount) |
| `release feed` | the feed cannot be listed; `not found` for a private repository usually means the token has no access | check `release.feed.url` and `release.feed.tokenFile`, see [feeds](feeds.md) |
| `registry access` | the manifest of a currently configured image cannot be read (one line per image) | see the note below and [registry errors](#registry-access-denied-versus-not-found) |
| `sigstore` | `https://tuf-repo-cdn.sigstore.dev` cannot be reached (keyless mode) | allow outbound https to Sigstore, or set `trust.keyless.trustedRootFile` |
| `sigstore trusted root` | the configured trusted root file cannot be read | check the path and mount |
| `public key` | a key file cannot be read or holds no `-----BEGIN PUBLIC KEY-----` (key mode, one line per file) | check `trust.key.publicKeyFiles` and the mount |
| `trust mode` (`WARN`) | mode `none`: signatures are not checked | intended only for private setups, see [trust modes](trust-modes.md) |

Exit codes: `0` when no check failed (warnings and skips allowed), `1` when at least one check
failed, `64` when the configuration is invalid. Code `2` is defined for "nothing could be
checked"; with a valid configuration the configuration check itself passes, so it does not
occur in practice.

Note on `registry access`: the doctor reads the manifest of each image the managed services
currently run (`docker buildx imagetools inspect --raw`) with the credentials of
`docker.registryAuthFile`, as pulls do. It points the Docker client at a temporary directory
that links to your file and removes the directory afterwards. It checks the images that run
now; `cicd-updater verify <version>` checks the images and signatures of a new release.

## Blockers

A blocker stops every update until it is fixed. `cicd-updater status` lists them
(`ready: no`); scheduling is refused with the problem `blocked`; at the start of a run the
deep preflight turns the first blocker into the failure `prepare.<blocker>`.

| Blocker | Cause | Remedy |
| --- | --- | --- |
| `docker_unreachable` | the socket is not mounted, `docker.socket` points elsewhere, or the daemon does not answer | mount `/var/run/docker.sock`, check `docker.socket`, check the Docker service on the host |
| `docker_too_old` | Engine API older than 1.43 | upgrade Docker Engine to 24 or newer |
| `compose_missing` | no Compose file in `compose.projectDir`, or a file of `compose.files` is missing | mount the project directory at the same path; check `compose.files` |
| `compose_invalid` | `docker compose config` fails (the detail has its message), for example a required variable is empty | run `docker compose --profile <profiles> config` in the project directory and fix the file or `.env` |
| `compose_unsupported` | a managed service does not take its image from its `imageVar` (the detail names it) | write `image: ${APP_IMAGE}` in the Compose file; check the spelling of `imageVar` |
| `project_mismatch` | `compose.projectDir` differs from the label `com.docker.compose.project.working_dir` of the sidecar's container, or `compose.projectName` from `com.docker.compose.project` | set `CICD_UPDATER_COMPOSE__PROJECT_DIR` to the absolute host path the project is started from; remove or fix `compose.projectName` |
| `env_unwritable` | the env file is missing, not writable, or its directory is not writable | create the file; mount the project directory read-write; check permissions |
| `state_unwritable` | the state directory is not writable | mount a named volume at `state.dir` |
| `disk_space` | free space where backups are written (`/state/backups`) is below `docker.minFreeMb` | free space (old images, old backups); lower `docker.minFreeMb` only if you know the backup size |
| `updater_image_unpinned` | the sidecar's own service takes its image from a key the sidecar rewrites | give the sidecar a fixed image reference, or a variable that is not an `imageVar` |
| `multiple_updaters` | another running sidecar container of this Compose project carries the role label | keep one: `docker ps --filter label=io.github.restow-backup.cicd-updater.role=sidecar` |
| `api_exposed` | the sidecar container publishes a port | remove `ports:` (only `server.allowPublishedPort: true` would allow it; not recommended) |
| `verifier_unavailable` | `keyless`/`key` mode with isolation: the sidecar's own image is unknown (not in a container, or it cannot inspect itself) or no named volume is mounted at `trust.verifier.workDir` | mount `updater-verify:/verify`; or set `trust.verifier.isolate: false` (weaker, see [architecture](architecture.md#the-isolated-verifier)) |

## Warnings

Warnings do not block. They are shown in `status`, `GET /v1/state` and the app's UI.

| Warning | Meaning | What to do |
| --- | --- | --- |
| `trust_mode_none` | signatures are not checked (trust mode `none`) | use `key` or `keyless` for production, see [trust modes](trust-modes.md) |
| `updater_image_not_digest_pinned` | the sidecar's own image reference has no digest | pin it by digest, see [upgrading the updater](upgrading-the-updater.md) |
| `self_label_missing` | the sidecar lacks its role label, so a second sidecar cannot be detected | add `io.github.restow-backup.cicd-updater.role: sidecar` |
| `health_without_app_check` | `hooks.health.type: none`: only container states are checked after an update | configure an `http` or `command` health check, ideally with the version |
| `backup_none_with_probe` | a migration probe is configured but no backup | configure a backup, or accept that a `needs_attention` run has no backup to restore |
| `source_mode_enabled` | `source.allowlist` is not empty (the detail says when the feed repository is not in it) | intended? Source mode builds unsigned code on the host |

## Failure codes

Before the point of no return a failure ends `unchanged`; after it the
[rollback rule](state-machine.md#the-rollback-rule) decides between `rolled_back` and
`needs_attention`. The English text is what `cicd-updater status` prints after the code.

### prepare

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `prepare.docker_unreachable` | Docker is not reachable. | see the blocker | see the blocker |
| `prepare.docker_too_old` | The Docker Engine is too old (API 1.43 or newer is required). | see the blocker | see the blocker |
| `prepare.compose_missing` | No Compose file was found. | see the blocker | see the blocker |
| `prepare.compose_invalid` | The Compose configuration is not valid. | `docker compose config` failed at the start of the run | run it by hand, fix the file |
| `prepare.compose_unsupported` | A managed service does not take its image from its variable. | see the blocker | see the blocker |
| `prepare.project_mismatch` | The configured project differs from the running one. | see the blocker | see the blocker |
| `prepare.env_unwritable` | The env file cannot be written. | see the blocker; also when the env file cannot be read | see the blocker |
| `prepare.state_unwritable` | The state volume cannot be written. | see the blocker | see the blocker |
| `prepare.disk_space` | There is not enough free disk space. | see the blocker | see the blocker |
| `prepare.updater_image_unpinned` | The updater's own image follows a variable it rewrites. | see the blocker | see the blocker |
| `prepare.multiple_updaters` | Another updater runs for this project. | see the blocker | see the blocker |
| `prepare.api_exposed` | The updater has a published port. | see the blocker | see the blocker |
| `prepare.verifier_unavailable` | The signature verifier cannot start. | see the blocker | see the blocker |
| `prepare.release_signature_invalid` | The stored release document no longer verifies. | the stored `release.json` does not verify against the current trust configuration (a key was removed, the identity changed since scheduling) or the stored file was changed | investigate; schedule again |
| `prepare.release_mismatch` | The release document differs from the one that was scheduled. | the stored document is missing or differs from the scheduled bytes, or its version, tag or project does not match | investigate `/state/releases/<version>/`; schedule again |
| `prepare.running_version_unknown` | The running version cannot be determined. | neither the health check, the image label, the last run nor `env.versionVar` yields a version | report the version in the health check (`versionJsonPath`), or build with the OCI version label |
| `prepare.not_newer` | The release is not newer than the running version. | the target is not strictly newer | nothing; downgrades are not possible |
| `prepare.below_minimum_version` | The running version is too old for this release. | the running version is below `upgrade.minimumFromVersion` | install the intermediate release first (`cicd-updater releases` shows the next installable one) |
| `prepare.manual_steps_required` | This release requires manual steps. | `upgrade.manualSteps.required` | follow `manualSteps.url` and update by hand |
| `prepare.updater_too_old` | The updater is too old for this release. | the sidecar does not satisfy `requires.updater` | [upgrade the sidecar](upgrading-the-updater.md) by hand |
| `prepare.env_missing` | Required settings are missing in the env file. | keys of `requires.env` are missing or empty (the detail names them) | add them to the env file |
| `prepare.image_missing` | The release lacks an image a service needs. | `release.json` has no image for a non-optional service's `image` key | release defect, or a wrong `services[].image`; mark the service `optional` if it may stay |
| `prepare.platform_unsupported` | The release has no image for this platform. | the host architecture is not in the image's `platforms` | build the release for `linux/amd64` and `linux/arm64` |

### fetch

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `fetch.signature_missing` | An image is not signed. | no signature for the digest (cosign: "no signatures found") | check the signing step of the release workflow; a mirror needs `cosign copy`; see [registries](registries.md) |
| `fetch.signature_invalid` | An image signature is not valid for this release. | signed by another identity or key: wrong `trust.keyless.github.repository` or `workflow`, a different tag pattern, a reusable workflow, a removed key | do not install; compare `trust.identity` in `status` with `cosign verify` by hand |
| `fetch.verifier_failed` | The signature check could not run. | cosign could not run or reach Sigstore (TUF, transparency log), the verifier container failed, `trust.verifier.timeoutSeconds` passed | allow outbound https to Sigstore or set `trustedRootFile`; check `docker compose logs updater` |
| `fetch.registry_unauthorized` | The registry refused access. | credentials missing or without the right scope | see [registry errors](#registry-access-denied-versus-not-found) |
| `fetch.registry_unreachable` | The registry is not reachable. | network, DNS, TLS, or the pull exceeded `timeouts.pullSeconds` | check the network; raise `timeouts.pullSeconds` for large images |
| `fetch.registry_rate_limited` | The registry rate limit was reached. | too many anonymous or account pulls | wait, or authenticate with `docker.registryAuthFile` |
| `fetch.image_not_found` | An image of the release does not exist. | the registry says the manifest does not exist | check credentials first (see below), then treat it as a release defect |
| `fetch.pull_failed` | Downloading an image failed. | any other pull error | read the detail |
| `fetch.digest_mismatch` | A downloaded image does not match the release. | the local image is not known by the verified digest | investigate; with the containerd image store see [compatibility](compatibility.md) |
| `fetch.version_label_mismatch` | An image carries another version than the release. | the image's `org.opencontainers.image.version` label differs from the target | release defect (built with the wrong version) |
| `fetch.source_not_allowed` | Building from source is not allowed for this repository. | source mode requested but the feed repository is not in `source.allowlist`, or the feed has no source archives | adjust `source.allowlist`, or use image mode |
| `fetch.token_unavailable` | The access token is not available. | `source.tokenFile` (or `release.feed.tokenFile`) cannot be read | check the file and mount |
| `fetch.download_failed` | Downloading the source failed. | download, size cap `source.maxArchiveMb` or safe extraction failed | read the detail |
| `fetch.build_failed` | Building an image failed. | `docker build` failed, or build paths leave the source tree | read the detail; check `source.build` |

### backup

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `backup.baseline_unavailable` | The database schema state could not be read. | the migration probe failed before the update (query error, missing table, timeout, value too long) | run the probe query by hand in the database container; fix `hooks.migrationProbe` |
| `backup.insufficient_space` | The backup would not fit on the disk. | estimate × 1.25 + `docker.minFreeMb` exceeds the free space (the detail has the numbers) | free space where backups are written (`/state/backups`) |
| `backup.failed` | The backup failed. | the dump or command exited non-zero, or encrypting failed | read the detail (redacted error output) |
| `backup.timeout` | The backup took too long. | `hooks.backup.timeoutSeconds` passed | raise the limit |
| `backup.verify_failed` | The backup could not be verified. | empty file, not a PostgreSQL archive, `pg_restore --list` failed, the MySQL dump is truncated, the archive misses a volume, the command output is missing | read the detail; run the dump by hand |

### stop, migrate, start

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `stop.failed` | Stopping services failed. | `docker compose stop` failed | read the detail |
| `migrate.failed` | The database migration failed. | the migration command exited non-zero (the detail has the output tail) | fix the migration in a new release |
| `migrate.timeout` | The database migration took too long. | `hooks.migrate.timeoutSeconds` passed; the container was removed | raise the limit |
| `start.env_changed` | The env file was changed during the update. | the lines of the writable keys changed between `prepare` and `start` | do not edit the env file during an update |
| `start.env_write_failed` | The env file could not be written. | permissions, a read-only mount, a full disk | check the env file and its directory |
| `start.failed` | Starting services failed. | `docker compose up` failed (in step `start` or for a later group in step `health`) | read the detail |

### health and smoke

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `health.timeout` | The application did not become healthy in time. | the services or the app check were not healthy within `hooks.health.timeoutSeconds` | read the detail (last reason and the service's log tail) |
| `health.crashed` | A service keeps crashing. | a managed container was seen `restarting`, `exited` or `dead` `crashLimit` times | read the exit code and log tail in the detail |
| `health.version_mismatch` | The application reports another version. | the app is healthy but reports another version (or none) `versionMismatchLimit` times | check that the image reports its own version and that the health endpoint returns it to the token |
| `health.unhealthy` | A service is unhealthy. | Docker health `unhealthy`, no healthcheck with `waitForDockerHealth: always`, a service not running at the end, or a per-service check failed | read the detail |
| `smoke.failed` | A check after the update failed. | a smoke check failed all attempts (the detail names the check) | read the detail |

### Other codes

| Code | Text | Cause | Remedy |
| --- | --- | --- | --- |
| `aborted` | The update was aborted. | somebody cancelled the running run before the point of no return | none |
| `interrupted` | The updater restarted during the update. | the sidecar stopped (restart, upgrade, host reboot) while a run was running | before the PONR nothing changed; after it follow the [runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention) |
| `missed_start` | The update was not started in time. | the sidecar was not running at `startsAt` plus `schedule.lateStartToleranceSeconds` | schedule again |

## Registry access: denied versus not found

The sidecar never reports "not found" when the message names an access problem. Pull errors
are classified in this order:

| Order | The error output contains | Code |
| --- | --- | --- |
| 1 | `toomanyrequests`, `rate limit`, `too many requests`, `429` | `fetch.registry_rate_limited` |
| 2 | `denied`, `unauthorized`, `forbidden`, `requires 'docker login'`, `authentication required`, `401`, `403` | `fetch.registry_unauthorized` |
| 3 | `manifest unknown`, `manifest for ... not found`, `no such manifest`, `not found: manifest`, `name unknown`, or (containerd image store) `failed to resolve reference ...: not found` | `fetch.image_not_found` |
| 4 | `no such host`, `dial tcp`, `i/o timeout`, `connection refused`, `connection reset`, `tls:`, `x509`, `certificate`, `network is unreachable`, `context deadline exceeded` | `fetch.registry_unreachable` |
| 5 | anything else | `fetch.pull_failed` |

A pull that runs past `timeouts.pullSeconds` is `fetch.registry_unreachable`. Signature
verification classifies cosign's output the same way first (rate limit, then access), then
looks for a missing signature, an identity or key mismatch, a missing image, and Sigstore
problems.

Things to know:

- A message that says "denied ... not found" is an access problem, not a missing image.
- Some registries answer a request for a private repository without valid credentials with a
  plain "not found" or `name unknown`, without naming the access problem. From the message
  alone such an answer cannot be told apart from a missing image. Before you treat
  `fetch.image_not_found` as a release defect, check the credentials.
- A successful `docker login` proves the account, not the right to read a package. GHCR needs
  `read:packages`, the Forgejo/Gitea registry `read:package`; some registries need broader
  scopes even for pulls.
- `docker.registryAuthFile` must contain an `auths` object only. A file with `credsStore` or
  `credHelpers` is refused when the sidecar starts (exit code 64). Create it with
  `docker --config <empty dir> login <registry>` on a machine without a credential helper and
  copy the resulting `config.json`.
- For each verification the verifier receives only the one `auths` entry of the image's
  registry. The entry is found by host name, also when its key carries a scheme or a path
  (`ghcr.io`, `https://ghcr.io`); for Docker Hub any of `docker.io`, `index.docker.io`,
  `registry-1.docker.io`, with or without scheme and path (`https://index.docker.io/v1/`).
- `cicd-updater verify <version>` shows, per image, `signature` and `exists` (`null` when
  the registry could not be asked) and the classified error. It uses the configured
  credentials and pulls nothing.

More in [registries](registries.md).

## Refusals

A release in `cicd-updater releases`, the problem `release_refused` (HTTP 409) or the
`prepare` step can be refused for these reasons:

| Refusal | Text | What to do |
| --- | --- | --- |
| `not_newer` | Not newer than the running version. | nothing |
| `below_minimum_version` | Install an intermediate release first. | install the version shown as "next installable" first |
| `manual_steps_required` | Requires manual steps. | follow the release's `manualSteps.url` |
| `updater_too_old` | Requires a newer updater. | [upgrade the sidecar](upgrading-the-updater.md) |
| `env_missing` | Required settings are missing. | add the keys named in the detail to the env file |
| `platform_unsupported` | No image for this platform. | the release must be built for the host's architecture |
| `image_missing` | An image is missing in the release. | release defect, or `services[].image` / `optional` |
| `running_version_unknown` | The running version is unknown. | see `prepare.running_version_unknown` |
| `no_release_document` | Not installable by the updater (no release document). | the release has no `release.json`; update by hand or publish one |

## Problems from the API

The CLI prints a refused request as `refused (<code>): <detail>` followed by the blockers,
refusals or validation errors, and exits with code 1.

| Problem | HTTP | Typical cause |
| --- | --- | --- |
| `unauthorized` | 401 | wrong or missing token (the CLI exits with 3: "The sidecar refused the token.") |
| `not_found` | 404 | unknown route, or a run id that is not the current run |
| `invalid_request` | 422 | invalid body or parameters, for example `leadSeconds` above `schedule.maxLeadSeconds` |
| `release_not_found` | 404 | the version is not in the feed or has no `release.json` |
| `release_unverifiable` | 422 | `release.json` or an image signature or digest does not verify |
| `release_refused` | 409 | refusals, listed in `reasons` |
| `release_mismatch` | 409 | `expect.releaseSha256` differs from the document |
| `source_not_allowed` | 409 | source mode requested but not enabled for this repository |
| `busy` | 409 | a run is already scheduled or running |
| `blocked` | 409 | preflight blockers, listed in `blockers` |
| `not_scheduled` | 409 | reschedule or cancel without a scheduled (or running) run |
| `point_of_no_return` | 409 | cancel after the run passed the point of no return |
| `not_finished` | 409 | acknowledge while scheduled or running |
| `feed_unavailable` | 502 | the release host failed; `feedError` says how (`rate_limited`, `unauthorized`, `forbidden`, `not_found`, `server_error`, `network`, `timeout`, `invalid_response`, `no_release`, `redirect`) |
| `internal` | 500 | an unexpected error; the details are only in the sidecar log |

A feed `not_found` for a private repository usually means the token has no access. See
[HTTP API](http-api.md) for the problem format.

## The sidecar does not start or the CLI cannot reach it

| Symptom | Cause | Remedy |
| --- | --- | --- |
| container exits with code 64 | invalid configuration, an unreadable or invalid `auth.tokenFile`, or a `docker.registryAuthFile` with `credsStore`/`credHelpers` | `docker compose logs updater` lists the problems; `docker compose run --rm --no-deps updater config check` |
| container exits with code 75 | another sidecar (another container) holds `/state/.lock` with a heartbeat younger than 60 seconds | stop the other sidecar. After a hard kill and recreation the new container can exit with 75 for up to 60 seconds; the restart policy brings it back once the old lock is stale |
| CLI exit code 3, "The token file /shared/token cannot be read" | the sidecar has not started yet (it creates the token), or `/shared` is not mounted | check `docker compose ps updater` and the volume |
| CLI exit code 3, "The sidecar does not answer on http://127.0.0.1:8090" | the server is not up (still starting, crashed) | `docker compose logs updater` |
| CLI exit code 3, "The sidecar refused the token." | the token file changed while the server runs with another one | restart the sidecar |
| log line "status.json could not be used (...); moved to status.json.corrupt-<ms>" | the state file was unreadable or of a newer schema version | the sidecar continues idle without history; the old file stays in `/state` for inspection |
| the container is `unhealthy` | `cicd-updater healthcheck` (the image's `HEALTHCHECK`) gets no answer from `/healthz` | `docker compose logs updater` |

Recovery when the sidecar itself is broken is described in
[backups and recovery](backups-and-recovery.md#when-the-sidecar-itself-is-broken).

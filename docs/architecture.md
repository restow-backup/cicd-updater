# Architecture

This page describes the components of cicd-updater, how data flows between them, and the
volumes, networks and helper containers on the host. The normative text is section 2 of the
[design specification](design.md); where this page and the code differ, the code wins and
this page follows it.

## Overview

```
 +---------------------------+   push by digest,   +---------------------------+
 | RELEASE SIDE (CI)         |   index, sign       | REGISTRY                  |
 | build -> smoke ->         | ------------------> | multi-arch images and     |
 | publish -> release-json   |                     | signatures (by digest)    |
 +-------------+-------------+                     +-------------^-------------+
               | release.json + bundle                           | verify signature,
               v                                                 | pull by digest
 +---------------------------+   feed    +-----------------------+--------------------------+
 | RELEASE HOST              | <-------- | HOST: one Compose project, internal network      |
 | GitHub / Forgejo / Gitea  | (sidecar, |                                                  |
 | / GitLab releases, or a   |  app SDK) |  +-------------+  bearer token  +-------------+  |
 | static index              |           |  | app backend | -------------> | updater     |  |
 +---------------------------+           |  | (SDK/HTTP)  | <------------- | sidecar     |  |
                                         |  +-------------+ health+version | docker.sock |  |
                                         |  +-------------+                | .env keys   |  |
                                         |  | edge/proxy  | <------------- | status.json |  |
                                         |  +------^------+ public status  | backups     |  |
                                         |         |        (read-only)    +-------------+  |
                                         +---------+----------------------------------------+
                                                   |
                                     browsers: users, maintenance page
```

| Component | Where | Role |
| --- | --- | --- |
| Release actions and `release` CLI | the app's CI | build, smoke-test, sign, publish (see [release side](release-side.md)) |
| Registry | any OCI registry | stores the images and their signatures |
| Release host | GitHub, Forgejo/Gitea, GitLab, a static https host, or a mounted directory | serves the release list, `release.json` and its Sigstore bundle |
| Sidecar | a container of `ghcr.io/restow-backup/cicd-updater` in the app's Compose project | the only component with the Docker socket; verifies, backs up, installs, checks |
| App backend | the app's own containers | asks the sidecar (levels 2 and 3), reports its health and version |
| Edge | the app's reverse proxy | forwards the read-only public status and maintenance page, nothing else of the sidecar |

## The sidecar

One container image (multi-arch, signed keyless by the project's release workflow). It
contains Node.js and the sidecar, the Docker CLI with the Compose and Buildx plugins, cosign,
`age`, `tar`, `gzip` and `tini`, all at pinned versions. The same image also carries the
`release` CLI for CI systems without composite actions.

```
                        +-------------------------- sidecar process ----------------------------+
 HTTP :8090 ----------> | server ---- auth (bearer, constant time) ---- problem+json errors     |
 (internal network)     |   |                                                                   |
 CLI (exec, loopback) ->|   v                                                                   |
                        | engine (state machine) ---- store (status.json, atomic) ---- journal  |
                        |   |                                                                   |
                        |   +-- preflight (blockers, warnings, 30 s cache)                      |
                        |   +-- release catalog (feed providers, release.json, bundle), SSRF    |
                        |   |   guard                                                           |
                        |   +-- trust (cosign: keyless | key | none) ---> verifier container    |
                        |   +-- docker ops (docker / docker compose argument vectors, no shell) |
                        |   +-- env file (byte-exact edit of the writable keys)                 |
                        |   +-- hooks (backup, migration probe, migrate, health, smoke)         |
                        |   +-- redactor (known secrets and credential patterns)                |
                        +-----------------------------------------------------------------------+
 volumes:  /var/run/docker.sock   <projectDir> (same path as on the host, read-write)
           /state (status.json, backups/, releases/, src/)   /shared (token, read-only for the app)
           /verify (verification inputs, mounted read-only into the verifier)
```

| Part | What it does |
| --- | --- |
| server | the HTTP API (`/healthz`, `/public/v1/...`, `/v1/...`); JSON in and out, RFC 9457 problem documents for errors, `Cache-Control: no-store` on every response |
| auth | compares `Authorization: Bearer <token>` in constant time (both sides hashed first) |
| engine | the [state machine](state-machine.md): scheduling, steps, rollback rule, resume after a restart |
| store | `status.json`, written atomically (temporary file, fsync, rename, directory fsync) before the side effect that follows each change |
| journal | audit events with sortable ids for the app's cursor |
| preflight | blockers and warnings, cached for 30 seconds; a deep check (with the Compose probe) runs at scheduling and at the start of a run |
| release catalog | reads the feed, downloads and stores `release.json` and its bundle under `/state/releases/<version>/` |
| trust | runs cosign against the exact keyless identity or the configured public keys |
| docker ops | every Docker call is an argument vector for the `docker` binary; values from outside are validated against strict patterns first |
| env file | edits only the writable keys, keeps every other byte, keeps mode and owner |
| hooks | backup, migration probe, migrate, health and smoke checks, all from `updater.yaml` only |
| redactor | removes the token, credential-looking env values, feed tokens and configured patterns from every log line, detail and problem |

The sidecar holds no application credential: no `env_file`, no database password in its
environment. It reads the env file only to edit the writable keys and to register
credential-looking values with the redactor. Built-in database commands run inside the
database container with that container's own environment.

## Data flow of a scheduled update

```
 admin --> app: POST /admin/updates {version, leadSeconds}     (authorization and step-up in the app)
 app --> sidecar: POST /v1/runs {version, leadSeconds, requestedBy, expect.releaseSha256}
 sidecar: fetch release.json + bundle -- verify bundle -- check refusals -- verify image
          signatures in the registry (no pull) -- store the document -- persist the run (scheduled)
 sidecar --> app: 202 {state}             app: audit "update.scheduled" via the journal cursor
 every signed-in user: banner with countdown (the app polls the sidecar, the browser polls the app)
 at startsAt: prepare - fetch - backup - stop - (migrate) - start - health - (smoke) - finish
 while the app is down: the edge serves the maintenance page, which polls /public/v1/status
 end: status.json says succeeded | unchanged | rolled_back | needs_attention
 app (back up, new or old version): ingests the journal events, notifies admins
```

At level 1 the operator replaces the first two lines with `cicd-updater schedule` inside
the sidecar container.

The sidecar keeps the verified bytes of `release.json` and its bundle for the run. At the
start of the run it verifies the stored bytes again (no refetch) and checks that their
SHA-256 equals the one recorded at scheduling.

## Volumes

| Mount in the sidecar | Type | Content | Who else mounts it |
| --- | --- | --- | --- |
| `/var/run/docker.sock` | bind | the Docker Engine socket (`docker.socket`) | nobody |
| `<projectDir>` | bind, same path as on the host | the Compose files, `.env`, `updater.yaml`, files `updater.yaml` points to | nobody |
| `/state` | named volume | `status.json` (`0600`), `.lock`, `backups/` (`0700`, files `0600`), `releases/`, `src/` (source mode), `docker-config/` (a link to the registry auth file), `tmp/` | nobody |
| `/shared` | named volume | `token` (64 hex characters, `0640`, owner root, group `auth.tokenGroupId`) | the app backend, read-only |
| `/verify` | named volume | one short-lived directory per verification (`v-<time>-<random>`): the document, the bundle, public keys, a trusted root, a registry credential file; removed after the verification, leftovers removed at start | the verifier container, read-only |

The project directory must be mounted at the same absolute path inside and outside the
container: the sidecar runs `docker compose` in it, and Compose resolves relative paths (bind
mounts, `env_file`, build contexts) against it. `compose.projectDir` must equal the Compose
label `com.docker.compose.project.working_dir` of the sidecar's own container (blocker
`project_mismatch`).

`/state` must be a volume, not a directory inside the container: the run state must survive
a recreation of the sidecar.

## Networks

- The sidecar listens on `server.listen` (default `0.0.0.0:8090`) inside its container and is
  attached only to the project's internal network. It must not publish a port; a published
  port is the blocker `api_exposed` unless `server.allowPublishedPort: true`.
- The app backend reaches it as `http://updater:8090`. The browser never talks to the
  authenticated API.
- The edge may forward exactly `/public/v1/status` and the maintenance page under
  `/public/v1/maintenance/`. Both are read-only and unauthenticated.
- The CLI inside the container talks to the same API on `127.0.0.1`. A request counts as a
  CLI request (`via: "cli"` in the journal) only when it comes from a loopback address and
  carries the header `x-cicd-updater-client: cli`; anything else is `via: "api"`.

Outbound connections of the sidecar:

| Destination | When |
| --- | --- |
| the release host | reading the feed and downloading `release.json` and its bundle (only public addresses unless `release.feed.allowPrivateNetwork: true`) |
| the registries of the managed images | signature verification and pulls |
| Sigstore (TUF root and transparency log) | `keyless` mode, unless `trust.keyless.trustedRootFile` is set; `key` mode only with `transparencyLog: true` |
| the allowlisted repository host | source mode only |
| GitHub releases of `restow-backup/cicd-updater` | once a day, only with `selfCheck.enabled: true` |

There is no telemetry.

## The isolated verifier

cosign parses responses from registries and the transparency log. That parsing does not run
in the process that holds the Docker socket. For every verification the sidecar starts a
short-lived sibling container of its own image (resolved by image ID from inspecting its
own container):

```
docker run --rm --label io.github.restow-backup.cicd-updater.managed=true \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 65534:65534 --tmpfs /tmp:rw,size=64m --env HOME=/tmp \
  --volume <verify volume>:/verify:ro [--env DOCKER_CONFIG=<per-verification dir>] \
  --entrypoint cosign <own image ID> verify ...
```

The verifier has no Docker socket, no capabilities, a read-only root file system and only
the `/verify` volume, read-only. When `docker.registryAuthFile` is set, the sidecar writes a
credential file with only the one registry entry this verification needs into the
per-verification directory and deletes it afterwards. The entry is found by the registry's
host name, also when its key in the `auths` object carries a scheme or a path
(`https://ghcr.io`, `https://index.docker.io/v1/`).

`trust.verifier.isolate: false` runs cosign as a subprocess of the sidecar instead. This is
weaker and meant for environments that cannot start sibling containers. With isolation on,
the sidecar needs its own image ID and a named volume at `trust.verifier.workDir`; otherwise
`keyless` and `key` mode report the blocker `verifier_unavailable`.

## Helper containers

Besides the verifier the sidecar starts these containers, all through argument vectors:

| Container | Started for | Shape |
| --- | --- | --- |
| volume archive | `hooks.backup.type: volume` | `docker run --rm` of the sidecar's own image, `--network none --read-only --cap-drop ALL`, the volumes mounted read-only under `/backup-src/<name>`, `tar -czf -` to the sidecar |
| backup command | `hooks.backup.type: command` | `docker run --rm` of the configured digest-pinned image on the configured network (the project's default network, a named network of the Compose file, or none), a temporary volume at `/backup`, the configured env keys passed through a `0600` env file |
| backup copy | `hooks.backup.type: command` | the sidecar's own image reading the output file from the temporary volume |
| migration | `hooks.migrate` | `docker compose run --rm --no-deps -T --name cicd-updater-migrate-<runId> <service> <argv>` |
| commands in app containers | migration probe, `command` health and smoke checks, database backups | `docker compose exec -T <service> <argv>` |

Containers the sidecar starts with `docker run` (the verifier, volume archives, backup
commands and copies) and the temporary backup volume carry the label
`io.github.restow-backup.cicd-updater.managed=true`; the migration container is known by its
name. At start the sidecar removes leftover containers with that label, a leftover
`cicd-updater-migrate-*` container, and leftover verification directories
(`v-<time>-<random>`) in `/verify`.

## Process and lifecycle

- The image's entrypoint is `tini` running the Node.js program; the default command is
  `serve`. The image's `HEALTHCHECK` runs `cicd-updater healthcheck`, which asks
  `/healthz` on the configured listen address.
- The sidecar runs as root inside its container. With the Docker socket a non-root user
  would not have less power, and the sidecar must replace the env file with its original
  owner and mode.
- The configuration is read once at start. A run never sees two configurations; changing
  `updater.yaml` takes effect after the sidecar restarts.
- At start the sidecar takes the state lock (`/state/.lock`), loads `status.json`, removes
  leftovers and resolves an interrupted run (see
  [restart and resume](state-machine.md#restart-and-resume)). After a restart it never
  starts or stops application services on its own.
- On SIGTERM or SIGINT it stops its timers, refuses to begin further steps, flushes the store
  and exits within 8 seconds. Set `stop_grace_period: 30s` on the service.

## Labels

| Label | Where | Meaning |
| --- | --- | --- |
| `io.github.restow-backup.cicd-updater.role=sidecar` | the sidecar service (set by you) | detection of a second sidecar for the same project (blocker `multiple_updaters`) |
| `io.github.restow-backup.cicd-updater.managed=true` | helper containers and temporary volumes | cleanup of leftovers |
| `io.github.restow-backup.cicd-updater.managed=build` | images built in source mode | marks local builds |

The label names are fixed for 1.x (see [versioning](versioning.md)).

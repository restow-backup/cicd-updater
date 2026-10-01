# Getting started

This page walks from an existing Docker Compose project to its first update through the
cicd-updater sidecar. It covers all three integration levels. The steps for the release
side and the host are the same for every level; the app changes differ.

The [examples](../examples/) are complete projects that follow these steps:
[static-site](../examples/static-site/) (level 1),
[python-postgres](../examples/python-postgres/) (level 2) and
[node-postgres](../examples/node-postgres/) (level 3).

## Before you start

| Requirement | Details |
| --- | --- |
| Host | Linux, Docker Engine 24 or newer (Engine API 1.43 or newer), `linux/amd64` or `linux/arm64`. The sidecar brings its own Docker CLI, Compose and Buildx plugins and cosign. |
| Compose project | Compose v2 file format. Every service the sidecar should update takes its image from a variable in the env file (`image: ${APP_IMAGE}`). |
| Database | In the same Compose project, if you want the built-in backup and migration probe (PostgreSQL, MySQL, MariaDB). |
| CI | GitHub Actions, Forgejo/Gitea Actions, GitLab CI, or any CI that can run a container (through the `release` CLI). |
| Registry | One the CI can push to and the host can pull from, see [registries](registries.md). |

What is tested and what is still "To verify" (for example the containerd image store and
rootless Docker) is listed in [compatibility](compatibility.md). 1.0 is implemented and
unit-tested with fakes; the end-to-end tests against real Docker and registries are a later
step.

## Choose the integration level

| Level | App changes | Who starts an update | Typical app |
| --- | --- | --- | --- |
| 1. No app changes | none; a health endpoint helps | the operator, with `docker compose exec updater cicd-updater ...` on the host | static sites, small tools, apps you cannot change |
| 2. Any language | the backend calls the sidecar's HTTP API (`/v1`) | an admin, in the app's own admin UI | Python, Go, PHP, Java apps |
| 3. TypeScript | the backend uses the SDK `@restow-backup/cicd-updater`, optionally its React components | an admin, in the app's own admin UI | Node.js and TypeScript apps |

All three levels drive the same engine. The CLI is a client of the same HTTP API, inside the
sidecar container. Steps 1 to 7 below are needed at every level; the sections
[Level 2](#level-2-call-the-http-api) and [Level 3](#level-3-use-the-sdk) add the app side.

## Step 1: add the release workflow

The release side builds the images, smoke-tests them, signs them and publishes a signed
`release.json` next to them. Copy the template for your CI:

| CI | Template | Signing |
| --- | --- | --- |
| GitHub Actions | [templates/github/release.yml](../templates/github/release.yml) to `.github/workflows/release.yml` | `keyless` (the workflow's OIDC identity) |
| Forgejo / Gitea Actions | [templates/forgejo/release.yml](../templates/forgejo/release.yml) to `.forgejo/workflows/release.yml` | `key` (a cosign key pair in Actions secrets) |
| GitLab CI | [templates/gitlab/.gitlab-ci.yml](../templates/gitlab/.gitlab-ci.yml) | `keyless` (`SIGSTORE_ID_TOKEN`) |

Adjust the lines marked `ADJUST` (image names, Compose files, health URL). Then:

1. Add `.cicd-updater/release-policy.yaml` to the repository. It holds the upgrade
   constraints of the next release and is reviewed with the code:

   ```yaml
   minimumFromVersion: null
   requiresUpdater: ">=1.0.0"
   requiresEnv: []
   manualSteps:
     required: false
     summary: null
     url: null
   ```

2. Make sure `.env.example` lists every variable your Compose files reference (optional ones
   commented out). The smoke test fails otherwise.
3. Add a small Compose override for the smoke test that publishes the health endpoint on the
   runner's loopback, as in
   [examples/node-postgres/docker-compose.smoke.yml](../examples/node-postgres/docker-compose.smoke.yml).
4. Push a tag `v1.0.0`.

The workflow pushes the images by digest without a tag, starts them with your production
Compose file and `.env.example`, and only then tags and signs the images and publishes the
release with `release.json` and `release.json.sigstore.json`. A failed run leaves nothing
public. On GitHub, keep the file name `release.yml`: the sidecar checks the signature against
the identity of exactly this file at the release tag.

Details: [release side](release-side.md), [release.json](release-json.md),
[GitHub](ci/github.md), [GitLab](ci/gitlab.md), [Forgejo](ci/forgejo.md),
[trust modes](trust-modes.md).

## Step 2: prepare the Compose project

Every managed service must take its image from a variable of the env file, and the env file
must hold digest-pinned references. The first time you set them by hand, from the release
page or `release.json` of `v1.0.0`:

```sh
# .env (excerpt)
PROJECT_DIR=/opt/notes
APP_IMAGE=ghcr.io/acme/notes:1.0.0@sha256:<digest of the app image>
WEB_IMAGE=ghcr.io/acme/notes-web:1.0.0@sha256:<digest of the web image>
```

From then on the sidecar rewrites exactly these lines (the [writable keys](concepts.md#writable-keys))
and nothing else in the project.

## Step 3: add the updater service

Add the sidecar as an opt-in service. This is the normative shape; the comments mark the
lines that matter:

```yaml
# docker-compose.yml (excerpt)
services:
  api:
    image: ${APP_IMAGE:?set APP_IMAGE in .env}
    volumes:
      - updater-shared:/run/cicd-updater:ro      # the shared token, read-only (levels 2 and 3)
    networks: [internal]
  worker:
    image: ${APP_IMAGE:?set APP_IMAGE in .env}
    networks: [internal]
  web:
    image: ${WEB_IMAGE:?set WEB_IMAGE in .env}
    networks: [internal, public]
  db:
    image: postgres:17-alpine
    networks: [internal]

  updater:
    profiles: ["updater"]                          # opt-in
    image: ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>   # never from a writable key
    restart: unless-stopped
    stop_grace_period: 30s
    labels:
      io.github.restow-backup.cicd-updater.role: sidecar
    environment:
      CICD_UPDATER_CONFIG: ${PROJECT_DIR:?set PROJECT_DIR in .env}/updater.yaml
      CICD_UPDATER_COMPOSE__PROJECT_DIR: ${PROJECT_DIR:?set PROJECT_DIR in .env}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${PROJECT_DIR:?set PROJECT_DIR in .env}:${PROJECT_DIR:?set PROJECT_DIR in .env}   # same path inside and outside
      - updater-state:/state
      - updater-shared:/shared
      - updater-verify:/verify
    networks: [internal]                           # no ports:
    security_opt: ["no-new-privileges:true"]

volumes:
  updater-state:
  updater-shared:
  updater-verify:
networks:
  internal:
  public:
```

| Line | Why |
| --- | --- |
| `profiles: ["updater"]` | Nothing changes until you start the profile. Without it the app runs and is updated by hand as before. |
| `image: ...@sha256:<digest>` | You pin the sidecar yourself (step 5). It must not come from a variable the sidecar rewrites: a run refuses to start then (blocker `updater_image_unpinned`). A variable that is not a writable key, such as `CICD_UPDATER_IMAGE` in the examples, is fine. |
| `stop_grace_period: 30s` | The sidecar needs up to 8 seconds to stop cleanly. |
| label `...role: sidecar` | Lets a second sidecar for the same project be detected (blocker `multiple_updaters`). Without it you get the warning `self_label_missing`. |
| `CICD_UPDATER_CONFIG` | Path of `updater.yaml`. The default is `/etc/cicd-updater/updater.yaml`. |
| `CICD_UPDATER_COMPOSE__PROJECT_DIR` | Sets `compose.projectDir` from the environment, so `updater.yaml` stays the same on every host. |
| docker.sock | The sidecar controls Docker through it. This is root on the host, see [security](security.md). |
| project directory at the same path | Relative paths in the Compose files resolve as on the host. The directory must match the Compose label of the sidecar's own container (blocker `project_mismatch`). |
| `/state` | `status.json`, backups, verified release documents. Must be a volume. |
| `/shared` | The generated API token, `/shared/token`. Mount the same volume read-only into the app only (levels 2 and 3). |
| `/verify` | A named volume for the isolated signature verifier (blocker `verifier_unavailable` without it in `keyless` and `key` mode). |
| `networks: [internal]`, no `ports:` | The API must not be reachable from outside. A published port is the blocker `api_exposed`. |

The sidecar runs as root inside its container. With the Docker socket a non-root user would
not have less power, and the sidecar must replace the env file with its original owner and
mode. [Architecture](architecture.md) explains the volumes and networks in detail.

## Step 4: write `updater.yaml`

Put `updater.yaml` into the project directory. A complete example for an app with an API, a
worker, an edge and PostgreSQL:

```yaml
version: 1

compose:
  profiles: [updater]          # the sidecar's own profile; passed to every Compose call

release:
  feed:
    type: github
    url: https://github.com/acme/notes
  channel: stable

trust:
  mode: keyless
  keyless:
    github:
      repository: acme/notes
      workflow: .github/workflows/release.yml

services:
  - { name: api,    image: app, imageVar: APP_IMAGE, startOrder: 1 }
  - { name: worker, image: app, imageVar: APP_IMAGE, startOrder: 2 }
  - { name: web,    image: web, imageVar: WEB_IMAGE, startOrder: 3, stopBeforeUpdate: false, stopOnAttention: false }

hooks:
  backup:
    type: postgres
    service: db
  migrationProbe:
    type: postgres
    service: db
    preset: node-pg-migrate
  health:
    type: http
    http:
      url: http://api:3000/healthz
      versionJsonPath: $.version
  smoke:
    checks:
      - { type: http, url: http://web:8080/, expectStatus: [200] }

rollback:
  policy: probe
```

What the sections mean:

- `services` maps each Compose service to an image key of `release.json` and to the env
  variable it reads. Services are started in groups by `startOrder`; each group is
  health-checked before the next. `stopBeforeUpdate: false` keeps a service (here the edge)
  serving until it is recreated. `stopOnAttention: false` keeps it running when a run ends
  in `needs_attention`, so an edge can keep showing the maintenance page.
- `hooks.backup` and `hooks.migrationProbe` make a backup before the update and decide
  whether a rollback is safe. See [hooks](hooks.md).
- `hooks.health` is the app check after the update. With `versionJsonPath` the app must
  report the new version. If your app cannot report its version (level 1), leave
  `versionJsonPath` out; the sidecar then reads the running version from the image label
  `org.opencontainers.image.version`, which the build action sets.
- `rollback.policy: probe` rolls back only when the probe proves the schema unchanged. A
  stateless app (a static site) uses `always`. See [state machine](state-machine.md#the-rollback-rule).

For a static site the file is much shorter, see
[examples/static-site/updater.yaml](../examples/static-site/updater.yaml). Every key is in
the [configuration reference](configuration.md).

Validate the file before the first start. `config check` works offline (no Docker, no
network):

```sh
docker compose run --rm --no-deps updater config check
```

Exit code 0 prints the effective configuration and its hash; exit code 64 lists every
problem, one per line.

## Step 5: verify and pin the sidecar image

The sidecar holds the Docker socket, so verify its image before you run it. Every image is
signed keyless by the project's own release workflow at the release tag.

1. Resolve the digest of the version you want:

   ```sh
   docker buildx imagetools inspect ghcr.io/restow-backup/cicd-updater:1.0.0
   ```

   The `Digest:` line is the digest of the multi-arch index.

2. Verify exactly that digest with the exact identity of the workflow at the tag:

   ```sh
   cosign verify ghcr.io/restow-backup/cicd-updater@sha256:<digest> \
     --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-repository restow-backup/cicd-updater \
     --certificate-github-workflow-ref refs/tags/v1.0.0 \
     --certificate-github-workflow-trigger push
   ```

3. Pin the verified digest in the `image:` line (or in the variable it reads):
   `ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>`.

[Upgrading the updater](upgrading-the-updater.md) has the same procedure for later versions
and explains how to verify the release assets.

## Step 6: start and check

```sh
docker compose --profile updater up -d
docker compose logs updater
docker compose exec updater cicd-updater doctor
```

The log starts with a line like
`cicd-updater 1.0.0 starting (config <hash>, overrides CICD_UPDATER_COMPOSE__PROJECT_DIR).`
and then `Listening on 0.0.0.0:8090 (project notes, 3 managed services, trust mode keyless).` If
the container exits at once, its exit code says why: 64 is an invalid configuration (the
log lists the problems), 75 means another sidecar holds the state directory.

`doctor` checks every prerequisite separately and read-only and names the file and key for
each: the Docker socket and Engine version, the Compose files and whether each managed
service takes its image from its variable, the env file and the state volume, the
container's own labels, image pin and ports, the verifier volume, the release feed (with its
token), registry access per managed image, Sigstore (keyless) or the public keys (key) and
the free disk space. Fix every `FAIL` line. [Troubleshooting](troubleshooting.md#reading-doctor-output)
explains each line.

`cicd-updater status` shows the same blockers and warnings the sidecar uses before a run:

```sh
docker compose exec updater cicd-updater status
```

`ready: yes` means no blocker is left.

## Step 7: schedule the first update

Push the next tag (`v1.1.0`) and wait for the release. Then, on the host:

```sh
docker compose exec updater cicd-updater releases            # newer releases and why one is refused
docker compose exec updater cicd-updater verify 1.1.0        # dry run: release.json and image signatures, no pull
docker compose exec updater cicd-updater schedule 1.1.0 --in 15m
docker compose exec updater cicd-updater status
```

`schedule` asks for confirmation (add `--yes` in scripts). Before it accepts the run, the
sidecar verifies `release.json` and every image signature in the registry (in `keyless` and
`key` mode); nothing that does not verify is ever announced. `--in` takes `90s`, `15m`, `2h`,
`1d`; `--at` takes an RFC 3339 time; without either the run starts now.

During the countdown you can move or cancel the run:

```sh
docker compose exec updater cicd-updater reschedule --in 1h
docker compose exec updater cicd-updater cancel
```

While it runs, `status` shows the step and progress and `logs` the redacted run log.
`cancel` during the run aborts it, but only before the point of no return (the start of the
`stop` step). The run ends in one of four outcomes:

| Outcome | Meaning | What you do |
| --- | --- | --- |
| `succeeded` | the new version runs and passed health and smoke checks | `cicd-updater ack` |
| `unchanged` | failed before anything was stopped; the old version kept running | read the failure code, fix, schedule again |
| `rolled_back` | failed after the point of no return; the old version runs again, the data provably unchanged | read the failure code, fix, schedule again |
| `needs_attention` | failed and a rollback was not certain to be safe; the app is stopped, the backup kept | follow the [runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention) |

A finished run stays visible until it is acknowledged (`cicd-updater ack`) or a new run is
scheduled.

## Level 2: call the HTTP API

At level 2 the app's backend starts updates from its own admin UI. The app keeps the jobs
only it can do: authorization and a recent strong sign-in for scheduling, its audit log,
the "update available" notification and the health endpoint with version. The patterns are
in [app integration](app-integration.md).

1. Mount the token volume read-only into the backend (`updater-shared:/run/cicd-updater:ro`)
   and nowhere else. The token file is `0640`, owner root, group `auth.tokenGroupId`
   (default 0). If the backend runs as a non-root user, set `auth.tokenGroupId` to its group.
2. Let the health endpoint add `version` to its answer only when the request carries
   `Authorization: Bearer <token>` (the sidecar sends it by default, `sendToken: true`).
   Anonymous callers get readiness only.
3. Call the API on the internal network with the token:

   ```sh
   TOKEN="$(cat /run/cicd-updater/token)"
   curl -s -H "Authorization: Bearer $TOKEN" http://updater:8090/v1/state
   curl -s -X POST http://updater:8090/v1/runs \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"version":"1.1.0","leadSeconds":900,"requestedBy":{"id":"42","label":"Alice (admin)"}}'
   ```

4. Ingest the journal (`GET /v1/events?after=<cursor>`) into the app's audit log, each event
   and the cursor in one transaction.
5. Let the edge forward `/public/v1/` to the sidecar, so users see the
   [maintenance page](maintenance-page.md) while the app is replaced.

The API, its problem documents and the OpenAPI document are in [HTTP API](http-api.md). The
[python-postgres](../examples/python-postgres/) example does all of this with `httpx`.

## Level 3: use the SDK

At level 3 the backend uses the TypeScript SDK (Node.js 22 or newer). Install it from the
release tarball:

```sh
npm install https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/restow-backup-cicd-updater-1.0.0.tgz
```

```ts
import { createUpdaterClient } from "@restow-backup/cicd-updater";
import { createTokenVerifier } from "@restow-backup/cicd-updater/auth";

const updater = createUpdaterClient({
  url: "http://updater:8090",
  tokenFile: "/run/cicd-updater/token",
});
const state = await updater.state(); // null when no sidecar runs (it is opt-in)

// In the health endpoint: reveal the version to the sidecar only.
const verifier = createTokenVerifier({ tokenFile: "/run/cicd-updater/token" });
const isUpdater = await verifier.isUpdater(request.headers.authorization);
```

The SDK also has `syncJournal` for exactly-once audit ingestion, `checkFeed` (in
`/feed`) to tell admins about new releases even without a sidecar, and React components for
the countdown banner and the progress view. See [SDK](sdk.md), [React](react.md) and the
[node-postgres](../examples/node-postgres/) example.

## Updating by hand

The sidecar is a convenience, not a requirement. Without the `updater` profile, or when you
prefer it, update by hand:

1. Verify the new images with cosign (the same identity as in `updater.yaml`), take the
   digests from the release's `release.json`.
2. Back up the database.
3. Write the new digest-pinned references into `.env`.
4. `docker compose pull` and `docker compose up -d`.

If a release has `upgrade.manualSteps.required: true`, the sidecar refuses it and the
release notes describe the manual steps.

## Try it locally

Each example has `make update-demo`: it builds two versions, pushes them to a local
registry and updates one to the other through the sidecar with trust mode `none` and a local
file feed. It shows the mechanics; it is not a production setting.

## Next

- [Concepts](concepts.md) and [architecture](architecture.md)
- [Configuration reference](configuration.md), [hooks](hooks.md)
- [State machine](state-machine.md), [troubleshooting](troubleshooting.md)
- [Backups and recovery](backups-and-recovery.md), [CLI](cli.md)

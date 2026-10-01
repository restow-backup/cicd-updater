# cicd-updater

Deutsch: [README.de.md](README.de.md)

Signed, self-service updates for apps that run with Docker Compose: from a button in the
app or a command on the host.

Your CI builds the app's images, starts them once as a smoke test, signs them and
publishes a signed `release.json` next to them. On every installation an opt-in sidecar
container reads that document, verifies the signatures, backs up the database, installs
exactly the published image digests and checks that the new version is healthy. If
something fails, it rolls back only when it can prove that this is safe; otherwise it
stops, keeps the backup and tells the operator exactly what to do. Your app asks the
sidecar for updates over a small HTTP API (any language, or the TypeScript SDK with React
components), or the operator uses the CLI. cicd-updater was extracted from the opt-in
updater of [Restow](https://github.com/restow-backup/restow) and made generic.

## Contents

- [Who it is for](#who-it-is-for)
- [What problem it solves](#what-problem-it-solves)
- [What exactly it does](#what-exactly-it-does)
- [Set it up in an existing project](#set-it-up-in-an-existing-project)
- [Web app template](#web-app-template)
- [Compatibility](#compatibility)
- [Security](#security)
- [FAQ highlights](#faq-highlights)
- [Documentation](#documentation)
- [License](#license)

## Who it is for

Teams that ship self-hosted software as a Docker Compose stack, to their own servers or to
their customers' servers, and want updates that an admin can start safely, without SSH
and without a runbook. Typical cases:

- **On-premises edition of a SaaS.** Customers run your app on their hardware. Their
  admin sees "version 1.4.0 is available" in the app and schedules it for tonight.
- **Managed service providers and agencies.** The same app runs as one Compose project per
  client. Each installation installs your signed releases when its admin (or you)
  schedules them.
- **Internal tools.** A small team runs a handful of apps on a company server and wants a
  backup, a maintenance page and an audit trail with every update.
- **Open-source self-hosted apps.** Users run `docker compose up`. The opt-in sidecar gives
  them an update button that never installs an unsigned image.

### Who it is not for

| If you use | Use instead |
| --- | --- |
| Kubernetes | its own rollout model: Helm, Argo CD or Flux, readiness gates |
| Docker Swarm, Nomad, several hosts or a remote Docker host | the orchestrator's rolling updates; cicd-updater manages one Compose project on one host |
| Desktop or mobile apps | the platform's updater or app store |
| A managed platform (PaaS) | the platform's deployments from your CI |
| No CI that builds your images, or none that can sign | set up a CI first: `key` mode works with any CI that can run a container (the `release` CLI). Without one, update by hand; trust mode `none` is for test installations only |
| A policy that forbids the Docker socket in a container | updating by hand ([FAQ](#faq-highlights)) or your own host-level tooling; the sidecar needs the socket, and that cannot be reduced |
| Stateless containers where "pull the new tag and restart" is enough | a simpler registry watcher; backups, probes and signatures would be overhead |

## What problem it solves

Self-hosted software has an update problem. Installations lag behind because updating is
manual and risky. Update scripts skip the backup when someone is in a hurry, pull a moving
tag that may not be what was tested, and "roll back" by starting an old image against a
database the new version already migrated. Users get a bare `502` while it happens, and
afterwards nobody can say who updated what.

When it is set up as documented (trust mode `keyless` or `key`), cicd-updater guarantees:

- **Only signed releases.** It installs a release only when `release.json` and every image
  carry valid signatures of the exact identity you configured (your release workflow at
  that tag, or your cosign key). It pulls by digest and writes `repo:tag@sha256:...`, so a
  moved tag can never change what runs.
- **Only on request.** An admin or the operator schedules every update. The sidecar never
  installs on its own, never installs an older version and never updates itself.
- **Backup first.** It creates and verifies the backup (PostgreSQL, MySQL/MariaDB, Docker
  volumes or your own command, optionally encrypted with age) before anything is stopped.
- **Nothing changes before the point of no return.** A failure or a cancel before services
  are stopped leaves the installation exactly as it was.
- **Rollback only when certain.** After the point of no return it starts the previous
  version again only when that is provably safe. Otherwise it stops the app, keeps the
  backup and records the recovery commands (`needs_attention`).
- **One file, a few lines.** It writes only the image lines of your services (and an
  optional version line) in `.env`, byte-exact, and nothing else in your project.
- **An audit trail.** Every action is journaled with the person who requested it, for
  your app's audit log, exactly once.

It does **not**:

- update without downtime. The services are stopped between the `stop` and `health`
  steps; users see a countdown before and a maintenance page during the update.
- restore a database on its own. Restoring stays the operator's decision.
- judge whether a release is good. A signature proves where a release came from, not that
  it works; the CI smoke test and your health and smoke checks are the quality gate.
  Whoever controls your signing pipeline can sign a bad release.
- reduce what the Docker socket allows. The sidecar is root-equivalent on the host
  ([Security](#security)).
- verify anything in trust mode `none`.

## What exactly it does

cicd-updater has three sides with one contract, the signed `release.json`:

| Side | What it is | What it does |
| --- | --- | --- |
| Release side | your CI with the composite actions (GitHub, Forgejo/Gitea) or the `release` CLI (any CI) | builds the images per architecture, pushes them by digest, starts them with your production Compose file and `.env.example` (optionally upgrading from the previous release through the sidecar itself), and only then tags and signs them and publishes the release with a signed `release.json` |
| Host side | the `cicd-updater` sidecar container in your Compose project, opt-in by profile | finds releases in your feed, verifies them, backs up, installs exactly the published digests, checks health and version, rolls back or stops; serves the read-only public status for the maintenance page |
| App side | your app, in any language | decides who may update (authorization, a recent strong sign-in), asks the sidecar, copies its journal into the audit log, shows the banner, reports its version to the sidecar only |

```
 RELEASE SIDE (CI)                       REGISTRY
 build -> smoke -> publish ----------->  multi-arch images and signatures, by digest
       -> release-json                        ^
       |                                      | verify signature, pull by digest
       | release.json + signature bundle      |
       v                                      |
 RELEASE HOST  <---- feed ----  HOST: one Compose project, internal network
 GitHub, Forgejo, GitLab        +-------------+  bearer token   +--------------------+
 releases, or a static index    | app backend | --------------> | updater sidecar    |
                                | (SDK, HTTP) | <-------------- | docker.sock, .env  |
                                +-------------+  health with    | status.json,       |
                                +-------------+  version        | backups            |
                                | edge/proxy  | <-------------- +--------------------+
                                +-------------+  public status (read-only)
                                      ^
                                      | users, maintenance page
```

### A run, step by step

Somebody schedules a release: now, in 15 minutes or at a fixed time. Before the sidecar
accepts it, it verifies `release.json` and every image signature in the registry; what
does not verify is never announced. During the countdown every signed-in user sees a
banner, and the run can be moved or cancelled. Then the steps run in a fixed order:

| Step | What happens |
| --- | --- |
| `prepare` | Checks every blocker (Docker, Compose, env file, disk space, ports, the pinned sidecar image) and verifies the stored `release.json` again. Refuses the release when the running version is below its minimum, or it needs manual steps, a newer sidecar, a missing env key or another platform. Records the previous image of each service and the previous `.env` lines. |
| `fetch` | Verifies each image signature in an isolated verifier container, pulls by digest, checks the digest and the version label. |
| `backup` | Reads the migration probe's baseline, creates the backup, verifies it and encrypts it if configured. |
| `stop` | **The point of no return.** Stops the services that write (the API, workers). |
| `migrate` | Optional: runs your migration command with the new image. |
| `start` | Writes the new image references into `.env` and starts the first service group. |
| `health` | Starts the groups in order and waits until the containers run and your health endpoint reports the new version. |
| `smoke` | Optional HTTP or command checks, for example a page through your edge. |
| `finish` | Applies the backup retention and removes old images. |

With a quiesced backup (`backup.quiesce`, always for volume backups) `stop` comes before
`backup`, so the point of no return moves before the backup.

### How a run ends

| Outcome | Meaning | What you do |
| --- | --- | --- |
| `succeeded` | the new version runs and passed health and smoke | acknowledge |
| `unchanged` | it failed (or was cancelled) before the point of no return; nothing was changed | read the failure code, fix, schedule again |
| `rolled_back` | it failed after the point of no return; the previous version runs again and the data is provably unchanged | read the failure code, fix, schedule again |
| `needs_attention` | it failed and going back was not certain to be safe; the app is stopped, the backup kept, the recovery commands recorded | follow the [runbook](docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention) |

**The rollback rule.** Starting old code on a database the new code already migrated can
corrupt data. After the point of no return the sidecar starts the previous version again
only when one of these holds: nothing new had started yet; the app declares it has no
persistent schema (`rollback.policy: always`); or the migration probe reads the same value
as before the update, read while the new version is stopped (`rollback.policy: probe`).
In every other case the run ends in `needs_attention`. The exact rule, every failure code
and the resume after a restart are in [docs/state-machine.md](docs/state-machine.md).

## Set it up in an existing project

The path below takes an existing Compose app to its first update through the sidecar.
Each step names the files you add and the page with the details. The
[getting started guide](docs/getting-started.md) is the same path in more depth, and the
[examples](examples/) are complete projects.

### 1. Check the prerequisites (15 minutes)

- [ ] **Compose v2 on Linux**, Docker Engine 24 or newer, amd64 or arm64. The sidecar
      brings its own Docker CLI and Compose.
- [ ] **Images from a CI**, and every service you want updated takes its image from a
      variable of `.env`: `image: ${APP_IMAGE:?set APP_IMAGE in .env}`.
- [ ] **A health endpoint** that can report the version (to the sidecar only, step 4).
      Without one, the sidecar checks only the container states and reads the version
      from the image label.
- [ ] **A migration probe, or none.** With a database: your migration tool has a preset
      (drizzle, prisma, knex, alembic, django, flyway, rails, golang-migrate,
      node-pg-migrate, typeorm, sequelize), or you write one `SELECT`. Without a
      persistent schema: `rollback.policy: always`.
- [ ] **A backup type**: `postgres`, `mysql` (also MariaDB), `volume`, `command` or
      `none`. For the built-in types the database is in the same Compose project.

Details: [compatibility](docs/compatibility.md), [hooks](docs/hooks.md).

### 2. Release side (30 to 60 minutes, plus the first CI run)

1. Copy the workflow for your CI and adjust the lines marked `ADJUST`:

   | CI | Template | Trust mode |
   | --- | --- | --- |
   | GitHub Actions | [templates/github/release.yml](templates/github/release.yml) to `.github/workflows/release.yml` | `keyless` |
   | Forgejo / Gitea Actions | [templates/forgejo/release.yml](templates/forgejo/release.yml) to `.forgejo/workflows/release.yml` | `key` |
   | GitLab CI | [templates/gitlab/.gitlab-ci.yml](templates/gitlab/.gitlab-ci.yml) | `keyless` |

2. Add `.cicd-updater/release-policy.yaml` (the upgrade constraints, reviewed with the
   code), list every Compose variable in `.env.example`, and add a small
   `docker-compose.smoke.yml` that publishes the health endpoint on the runner's loopback.
3. Choose the trust mode. It is set on both sides and never falls back to a weaker one:

   | Mode | Trust anchor | Use it for |
   | --- | --- | --- |
   | `keyless` | your release workflow's OIDC identity at the exact tag, in Sigstore's public log | GitHub Actions, GitLab CI |
   | `key` | a cosign key pair; the CI holds the private key, the host the public key | Forgejo/Gitea, any other CI, private infrastructure |
   | `none` | nothing: whoever can change your release document chooses what runs next to the Docker socket | test installations only; it must be acknowledged explicitly and is shown on every run |

4. Push a tag `v1.0.0`. Nothing is tagged in the registry and no release is public before
   the smoke test passed.

Details: [release side](docs/release-side.md), [trust modes](docs/trust-modes.md),
[release.json](docs/release-json.md), CI guides for [GitHub](docs/ci/github.md),
[GitLab](docs/ci/gitlab.md) and [Forgejo](docs/ci/forgejo.md).

### 3. Host side (30 minutes)

1. Add the `updater` service to your Compose file, in the profile `updater`, with the
   Docker socket, the project directory at the same path, the volumes `/state`, `/shared`
   (the token) and `/verify`, the internal network and no `ports:`. The
   [web app template](templates/web-app/compose/docker-compose.updater.yml) has it as a
   commented fragment.
2. Mount the token volume read-only into your backend, and only there:
   `updater-shared:/run/cicd-updater:ro`.
3. Put `updater.yaml` into the project directory: feed, trust identity, the managed
   services and the `.env` keys they read, backup, probe, health
   ([commented template](templates/web-app/updater.yaml)). Check it offline with
   `docker compose run --rm --no-deps updater config check`.
4. Set the image variables in `.env` once by hand to the digest-pinned references of
   `v1.0.0` (`<repository>:<tag>@sha256:<digest>`, from its `release.json`).
5. Verify the sidecar image with cosign and pin its digest
   ([upgrading the updater](docs/upgrading-the-updater.md)):

   ```sh
   cosign verify ghcr.io/restow-backup/cicd-updater@sha256:<digest> \
     --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-repository restow-backup/cicd-updater \
     --certificate-github-workflow-ref refs/tags/v1.0.0 \
     --certificate-github-workflow-trigger push
   ```

6. Start it and fix every `FAIL` line:

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   docker compose exec updater cicd-updater status        # ready: yes
   ```

Without the `updater` profile nothing changes: your app runs as before and can always be
updated by hand. Details: [getting started](docs/getting-started.md),
[configuration](docs/configuration.md), [architecture](docs/architecture.md),
[CLI](docs/cli.md).

### 4. App side (no time at all to a few hours, depending on the level)

Pick an integration level. All three drive the same engine.

| Level | App changes | Who starts an update |
| --- | --- | --- |
| 1. No app changes | none; a health endpoint helps | the operator: `docker compose exec updater cicd-updater schedule 1.1.0 --in 15m` |
| 2. Any language | the backend calls the HTTP API ([OpenAPI](openapi/updater-api.v1.yaml)) | an admin, in your app's admin UI |
| 3. TypeScript | the backend uses the SDK `@restow-backup/cicd-updater`, optionally its React components | an admin, in your app's admin UI, with less code |

At levels 2 and 3 your app does what only it can do:

- **Authorization**: only installation-level admins may schedule, cancel and acknowledge;
  impersonated sessions never count.
- **Step-up**: scheduling requires a strong sign-in (passkey, password plus TOTP, OIDC)
  younger than 10 minutes.
- **Audit**: pass the acting user as `requestedBy` and the release hash the admin saw as
  `expect.releaseSha256`, and copy the sidecar's journal into your audit log exactly once.
- **An admin "Updates" page** with the running and the available version, a lead-time
  picker, cancel and the result; and **a maintenance banner** for every signed-in user,
  which falls back to the public status through your edge while the app is down.
- **Health with version**: readiness for everyone, the version only for the sidecar's
  token.

The [web app template](#web-app-template) has all of this ready to copy. Details:
[app integration](docs/app-integration.md), [HTTP API](docs/http-api.md),
[SDK](docs/sdk.md), [React](docs/react.md), [maintenance page](docs/maintenance-page.md).

### 5. The first update (15 minutes)

Push `v1.1.0` and wait for the release. Then schedule it from your admin page, or on the
host:

```sh
docker compose exec updater cicd-updater releases          # newer releases and why one is refused
docker compose exec updater cicd-updater verify 1.1.0      # dry run, no pull
docker compose exec updater cicd-updater schedule 1.1.0 --in 15m
docker compose exec updater cicd-updater status
docker compose exec updater cicd-updater ack               # once it has finished
```

If a run ends in `needs_attention`, nothing happens automatically:

1. Read what happened: `cicd-updater status`, `cicd-updater logs` and
   `cicd-updater recover show` (the backup, the previous images, the previous `.env`
   lines and the rendered restore commands).
2. Decide: go back (restore the backup if the schema changed, then
   `cicd-updater recover restore-env <runId>` and `docker compose --profile updater up -d`)
   or go forward (fix the cause and start the new version).
3. Check the app, then `cicd-updater ack`.

Details: [runbook](docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention),
[troubleshooting](docs/troubleshooting.md).

## Web app template

[templates/web-app/](templates/web-app/) is a framework-agnostic starter for steps 3 and 4
in an existing web app, with `TODO(cicd-updater)` markers and a
[30-minute walk-through](templates/web-app/README.md):

| Folder | What it is |
| --- | --- |
| `compose/` | the sidecar as a Compose fragment (paste it or merge it with `-f`) and the smoke override |
| `updater.yaml`, `.env.example` | the commented configuration and the `.env` lines to add |
| `release/` | the GitHub release workflow and the release policy |
| `backend/node/` | endpoints on web-standard `Request`/`Response` with authorization, step-up and audit hooks, health with version, journal ingestion, Express and Hono adapters (SDK) |
| `backend/python/` | the same endpoints and health for FastAPI (HTTP API) |
| `backend/http/`, `backend/sql/` | the API calls for any other language with a `curl` script; the probe query of every preset |
| `frontend/react/` | the admin `UpdatesPage` and the `MaintenanceNotice` banner |
| `frontend/vanilla/` | the same as one ES module without a build step |

Copy `compose/`, `updater.yaml`, `.env.example`, `release/`, one folder of `backend/` and
one of `frontend/` (with `frontend/updates.css`) into your project, then follow
[its README](templates/web-app/README.md) and tick off
[INTEGRATION-CHECKLIST.md](templates/web-app/INTEGRATION-CHECKLIST.md). The TypeScript
and JavaScript files are type-checked against the SDK in this repository's CI.

## Compatibility

| | 1.0 |
| --- | --- |
| Hosts | Linux, Docker Engine 24 or newer (API 1.43), amd64 and arm64. The sidecar brings its own Compose and Buildx |
| Apps | anything that runs with Docker Compose and takes its images from variables in the env file |
| CI and signing | GitHub Actions (keyless, key, none), Forgejo/Gitea Actions (key, none), GitLab CI and other CI through the `release` CLI |
| Registries | GHCR, Docker Hub, GitLab, Harbor, distribution, Forgejo/Gitea and others, see [docs/registries.md](docs/registries.md) |
| Release feeds | GitHub, Forgejo/Gitea and GitLab releases, a static index, a local directory |
| SDK | Node.js 22 and newer for the server parts; protocol, SemVer and messages run anywhere; React 18 and newer |

Every entry carries a status in [docs/compatibility.md](docs/compatibility.md): **Tested**
(covered by the unit tests, which run with fakes), **Expected** (should work according to
the upstream documentation) or **To verify**. 1.0 is implemented and covered by about 520
unit tests. Still **To verify**, in the end-to-end run that comes next: everything against
real Docker (Engine versions, the containerd image store, rootless Docker), real
registries (GHCR, distribution, signatures in the Forgejo/Gitea registry, mirrors filled
with `cosign copy`), keyless signing with Sigstore from GitHub Actions, the Forgejo
Actions runner, and the three examples updated end to end. The results are recorded on
that page. Not supported in 1.0: Podman, Kubernetes, Swarm, Nomad, multi-host apps and
remote Docker hosts.

## Security

**The sidecar holds the Docker socket, which is root on the host.** Treat it like root.
The design follows from that:

- **Opt-in**: a Compose profile; nothing runs until you start it, and updating by hand
  stays supported.
- **Least privilege around it**: it listens only on the internal network (a published port
  is a blocker), requires a bearer token that is mounted read-only into your backend
  only, offers no endpoint that runs a command or chooses an image, and holds no
  application credentials. Hooks (backup, probe, migration, health, smoke) come only from
  `updater.yaml`, which only the operator writes; the app must not be able to change it.
- **Verified input only**: in `keyless` and `key` mode it installs only releases whose
  `release.json` and images carry valid signatures of the exact identity you configured;
  cosign runs in an isolated container without the socket. Mode `none` must be
  acknowledged explicitly and is shown on every run.
- **Pinned, never self-updated**: its own image is pinned by digest and changed only by
  the operator. It refuses to run an update while its own service would follow an `.env`
  key it rewrites.

Read [docs/security.md](docs/security.md) (with a hardening checklist),
[docs/trust-modes.md](docs/trust-modes.md) and [docs/threat-model.md](docs/threat-model.md)
before you deploy it. Report vulnerabilities as described in [SECURITY.md](SECURITY.md).

## FAQ highlights

- **Why not automatic updates like Watchtower?** A moved tag is not a release, an app with
  a database needs a backup and a rule for failures, and users need to know. The sidecar
  never installs on its own.
- **Why no Kubernetes?** Kubernetes has its own rollout model; cicd-updater is for a single
  host with Docker Compose.
- **Why does the sidecar not update itself?** Whoever controlled its feed could then
  replace the most powerful container on the host. It only reports a newer version
  (`selfCheck`).
- **What happens without the sidecar?** Nothing changes. The SDK reports "no sidecar" and
  the app shows the manual steps: verify the images with cosign, back up, write the
  digest-pinned references from `release.json` into `.env`, `docker compose pull`,
  `docker compose up -d`.
- **Can I go back to an older version?** Not through the sidecar: it installs only newer
  versions. Going back means restoring a backup and the previous `.env` lines.

All answers: [docs/faq.md](docs/faq.md).

## Documentation

- [Documentation index](docs/index.md): getting started, concepts, configuration reference,
  hooks, state machine, troubleshooting, backups and recovery
- Release side: [actions and templates](docs/release-side.md), [release.json](docs/release-json.md),
  [feeds](docs/feeds.md), [trust modes](docs/trust-modes.md), [registries](docs/registries.md)
- App side: [app integration](docs/app-integration.md), [HTTP API](docs/http-api.md),
  [SDK](docs/sdk.md), [React components](docs/react.md),
  [web app template](templates/web-app/README.md)
- Operations: [CLI](docs/cli.md), [maintenance page](docs/maintenance-page.md),
  [upgrading the updater](docs/upgrading-the-updater.md), [versioning](docs/versioning.md),
  [FAQ](docs/faq.md), [design specification](docs/design.md)
- [Examples](examples/), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md),
  [CHANGELOG.md](CHANGELOG.md)

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright IT Systeme Flores UG (haftungsbeschränkt).
Third-party components: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

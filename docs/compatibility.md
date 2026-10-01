# Compatibility

What cicd-updater 1.0 runs on, and how well each claim is established.

| Label | Meaning |
| --- | --- |
| **Tested (e2e)** | Run for real by the end-to-end suite (`pnpm e2e`, [e2e/](../e2e)): real Docker, a real registry with TLS, the cosign of the sidecar image, the sidecar as a Compose service. The date and platform of the run are noted. |
| **Tested (unit)** | Covered by the unit tests, which run with fakes: fake servers, a fake resolver, a fake Docker and cosign runner. |
| **Expected** | Should work according to the upstream documentation (or the parts the tests cover), but nothing in the project's tests runs it. |
| **To verify** | Needs a run the suite has not made yet (another platform or image store, a registry product, a real CI runner). The result is recorded here after that run. |
| **To verify (first release run)** | Exercised by the project's own release workflow (keyless signing with GitHub's OIDC identity, GHCR, the GitHub release API); recorded after the first release. |

Where things stand (2026-10-02): about 550 unit tests, and the end-to-end suite with its
scenario files `10-trust` to `60-release-tools` (results at the end of this page). The
suite ran on `linux/arm64` (Colima on macOS); the scenarios run inside a Docker-in-Docker
host with Docker Engine 29.8.2 and the classic image store.

## Host

| Item | Status | Note |
| --- | --- | --- |
| Linux host, Docker Engine 24 or newer (API 1.43 or newer) | Tested (e2e) with Engine 29.8.2, 2026-10-02; Expected for 24 to 28 | The version check (blocker `docker_too_old`) is unit-tested. |
| Docker Compose plugin bundled in the sidecar image | Tested (e2e), Compose 5.5.1 | the sidecar runs Compose from its own image, so the host's Compose version does not matter to it |
| Classic image store | Tested (e2e), 2026-10-02 | pull of `repository:tag@digest`, the digest check after the pull (`RepoDigests`), `compose up --pull never` with the written reference, image pruning |
| containerd image store | To verify | the suite runs on it with `E2E_IMAGE_STORE=containerd`; not run yet |
| Rootless Docker | To verify | `docker.socket` path, same-path bind mount of the project directory |
| SELinux enforcing | Expected | bind mounts may need `:z` |
| Docker Desktop, colima (macOS, Windows) | Expected | development only; the project directory must be shared with the VM at the same path |
| `linux/arm64` | Tested (e2e), 2026-10-02 | the sidecar image built and run on arm64; the whole suite |
| `linux/amd64` | To verify | the CI image job builds and runs the image; the e2e has not run on amd64 yet |

Docker 29 lists images without a tag only with `docker image ls --all`, and images pulled as
`repository:tag@digest` carry no tag. The sidecar's image pruning lists with `--all` (found
in the e2e: before, nothing was pruned on Docker 29).

## Sidecar image

| Item | Status | Note |
| --- | --- | --- |
| Image build (Node.js 24.21 on Alpine 3.24; Docker CLI 29.8.2 with Buildx 0.37.2 and Compose 5.5.1; cosign 3.1.3; age 1.3.1; tini 0.19.0; BusyBox 1.37 `tar`) | Tested (e2e) on arm64, 2026-10-02 | 628 MB unpacked, 171 MB compressed (cosign 133 MB, Node.js 128 MB, Buildx 61 MB, Docker CLI 42 MB, Compose 30 MB, the sidecar 1.6 MB). Checked: `version`, `config check` of every example and the template, `healthcheck`, BusyBox `tar -czf`/`-tzf`/`-xzf`, the licence files in `/usr/share/doc/cicd-updater`, the OCI labels, no npm/npx/corepack/yarn. The runtime runs as root by design (docs/security.md); the build stage and the verifier do not. |
| Verifier container (read-only, no capabilities, user `65534:65534`, `/verify` read-only) | Tested (e2e) | every key-mode scenario verifies through it |
| cosign flags of the verifier, key mode (`verify --key ... --insecure-ignore-tlog=true`, `verify-blob --bundle ... --key ...`) | Tested (e2e), cosign 3.1.3 | |
| cosign flags of the verifier, keyless (exact identity, issuer, GitHub workflow repository, ref and trigger, `--trusted-root`) | To verify (first release run) | the argument vectors are unit-tested; the release workflow's `verify-release` job uses the same flags |
| Classification of cosign and `docker pull` errors | Tested (e2e) | real messages for: no signature (`signature_missing`), another key (`signature_invalid`; cosign 3 says "no matching attestations: failed to verify signature", which was classified as missing before), refused login (`registry_unauthorized`), a deleted image (`image_not_found`) |

## Apps and stacks

Prerequisites of an app:

| Prerequisite | Requirement |
| --- | --- |
| Compose | v2 file format; managed services take `image:` from a variable in the env file |
| Images | built by a CI (or source mode); OCI labels set by the build |
| Health | an HTTP endpoint (ideally revealing the version to the token) or a command; without it only container states are checked |
| Database | in the same Compose project for the built-in backup and probe; migrations idempotent at start, or through `hooks.migrate` |
| Rollback | a migration probe, or `rollback.policy: always` for apps without a persistent schema |

| Language or framework | Integration level | Status | Note |
| --- | --- | --- | --- |
| Node.js / TypeScript | 3 (SDK, React) | Tested (e2e), 2026-10-02 | example `node-postgres`: built from its Dockerfiles with the SDK tarball, installed from its Compose file and `.env.example`, updated from 1.0.0 to 1.1.0 from the app's admin endpoint (SDK client) with a node-pg-migrate 8 migration in `hooks.migrate`, the probe preset `node-pg-migrate`, health revealing the version only to the token, the smoke through Caddy, the journal in the audit log, and Caddy's `handle_errors` serving the maintenance page |
| Python | 2 (HTTP API) | Tested (e2e), 2026-10-02 | example `python-postgres`: Alembic at start, an age-encrypted backup, nginx `error_page` with the named location serving the maintenance page |
| Static sites (nginx) | 1 (CLI) | Tested (e2e), 2026-10-02 | example `static-site`: no backup, `rollback.policy: always`, the version from `version.json` |
| Go, PHP, Java, .NET, Ruby | 2 | Expected | through the OpenAPI contract `openapi/updater-api.v1.yaml` |

| Built-in backup and probe | Status | Note |
| --- | --- | --- |
| PostgreSQL 17 (`pg_dump -Fc` in the database container) | Tested (e2e), 2026-10-02 | backup, `pg_restore --list` from stdin, a restore into a scratch database, the recorded recovery commands run for real, an abort during the dump (its backends ended, nothing left), a query probe with the schema fingerprint |
| PostgreSQL 13 to 16 | Expected | |
| MySQL 8.4 (`mysqldump` with `MYSQL_PWD`) | Tested (e2e), 2026-10-02 | backup and the documented restore |
| MySQL 8.0 | Expected | |
| MariaDB 11.8 (`mariadb-dump` with `MYSQL_PWD`) | Tested (e2e), 2026-10-02 | backup and the documented restore |
| MariaDB 10.6 to 11.4 | Expected | |
| File data, `volume` backup (quiesced) | Tested (e2e), 2026-10-02 | BusyBox `tar`, the documented restore |
| `command` backup | Tested (e2e), 2026-10-02 | a digest-pinned image, env values through an env file, the project network |
| age encryption | Tested (e2e), 2026-10-02 | only `<name>.age` stays; the identity decrypts it |
| Backups on another disk (a volume at `/state/backups`) | Tested (e2e), 2026-10-02 | the space check measures that file system |
| MongoDB, Redis and others, `command` backup | Expected | |

## CI systems and trust modes

| CI | Mode | Status | Note |
| --- | --- | --- | --- |
| GitHub Actions | `keyless` | To verify (first release run) | the project's own release workflow signs keyless with its OIDC identity, and `verify-release` checks the exact identity |
| GitHub Actions | `key`, `none` | Tested (e2e) through the `release` CLI, 2026-10-02; the composite actions on a runner: To verify | the actions run the same code (`actions/lib/release-tools.mjs`) |
| GitLab CI (gitlab.com) | `keyless` | Expected | `SIGSTORE_ID_TOKEN`, `templates/gitlab/.gitlab-ci.yml`; the project's CI cannot run GitLab pipelines |
| GitLab CI (gitlab.com) | `key`, `none` | Expected | the same `release` CLI as in the e2e |
| GitLab self-managed | `keyless` | Expected | only if the Sigstore instance accepts the instance's issuer; otherwise use `key` |
| GitLab self-managed | `key`, `none` | Expected | |
| Forgejo / Gitea Actions | `key`, `none` | To verify | composite actions on the Forgejo runner, including how the runner resolves the third-party actions |
| Other CI systems, through the `release` CLI | `key`, `none` | Tested (e2e), 2026-10-02 | the e2e builds, signs and publishes every release with the CLI of the sidecar image |

Release-side functions:

| Item | Status | Note |
| --- | --- | --- |
| `release.json` creation, validation, signing (`sign-blob --bundle`), the release policy file | Tested (e2e), 2026-10-02 | |
| cosign signing in key mode without the transparency log (`sign`, `sign-blob`, `attest --type spdxjson`) | Tested (e2e), cosign 3.1.3 | cosign 3 refuses `--tlog-upload=false` together with its default signing config; the release tools add `--use-signing-config=false` (fixed) |
| `docker buildx build --metadata-file`, push by digest | Tested (e2e), 2026-10-02 | needs a BuildKit builder (`docker-container` driver); the `docker` driver refuses push by digest. The actions set one up with `docker/setup-buildx-action`, the GitLab template with `docker buildx create` |
| `docker buildx imagetools create` and `inspect --raw` | Tested (e2e), 2026-10-02 | an index from platform manifests (no attestation entries), an index source expanded into its platform manifests, an existing version tag refused |
| Release smoke against real Docker, with the upgrade through the sidecar (a file feed, `none` mode, Compose `!override`, the previous release from a static feed over TLS) | Tested (e2e), 2026-10-02 | three fixes came from it: the work directory lies inside the checkout (the sidecar container mounts it), the sidecar gets the smoke's Compose files, and the teardown includes the sidecar's profile |
| Upload: GitHub, Forgejo/Gitea and GitLab release APIs, server URL or API base | Tested (unit) | against fake servers |
| Upload to the real GitHub API | To verify (first release run) | |
| Upload to the real Forgejo and GitLab APIs | To verify | |

## Registries

Signature storage depends on cosign: cosign 3 writes signatures as OCI 1.1 referring
artifacts and falls back to the referrers tag schema (`sha256-<digest>` index) where the
registry has no referrers API ([registries.md](registries.md)).

| Registry | Status | Note |
| --- | --- | --- |
| distribution/registry v3 (3.0.0) | Tested (e2e), 2026-10-02 | TLS with a private CA, with and without an htpasswd login (`docker.registryAuthFile`); it has no referrers API, so cosign 3 uses the referrers tag schema |
| distribution/registry v2 | Expected | |
| GitHub Container Registry (GHCR) | To verify (first release run) | the project's own images |
| Docker Hub | Expected | |
| GitLab container registry | Expected | |
| Harbor 2.5 and later | Expected | |
| Quay, Amazon ECR, Azure Container Registry, Artifactory | Expected | |
| Forgejo / Gitea built-in registry | To verify | neither project documents OCI referrers or cosign (open question Q5). Not run yet: push, `key` signing, verification through the sidecar and the token scope needed to read |
| Mirrors filled with `cosign copy` | To verify | whether the copy carries cosign 3's referrers |
| Any registry without signature support | Expected | `none` mode only |

## Release hosts (feeds)

| Provider | Status | Note |
| --- | --- | --- |
| GitHub releases: list, drafts, tag pattern, public and private asset URLs | Tested (unit) | against a fake server |
| GitHub releases: the real API | To verify (first release run) | |
| Forgejo / Gitea releases API, with a path prefix | Tested (unit) | against a fake server |
| Forgejo / Gitea releases API: a real Forgejo | To verify | |
| GitLab releases with asset links | Tested (unit) | against a fake server |
| GitLab releases: the real API, private projects | Expected | |
| Static feed index (any https host) | Tested (unit); Tested (e2e) in the release smoke | the e2e serves it over TLS with a private CA (`--feed-allow-private-host`) |
| File feed (mounted directory) | Tested (e2e), 2026-10-02 | every e2e scenario reads its releases from one |
| Address guard (https only, public addresses, no pooling, redirects, token dropped across origins, caps) | Tested (unit) | fake resolver, fake servers and a real local socket |

## SDK runtimes

| Runtime | Status | Note |
| --- | --- | --- |
| Node.js 22, 24 | Tested (unit); Node.js 24 also in the e2e | the CI matrix runs both; the node-postgres example runs the SDK on Node.js 24 |
| Bun, Deno: `/protocol`, `/semver`, `/messages`, `/maintenance` | Expected | no Node.js-specific APIs |
| Browsers: `/react`, `/maintenance`, `/protocol`, `/semver`, `/messages` | Expected | the React components are unit-tested with server-side rendering in Node.js, not in a browser |

## Not supported in 1.0

- Podman (its Docker-compatible API may work; untested, no promise), Kubernetes, Docker
  Swarm, Nomad, plain `docker run` setups.
- Multi-host apps and remote Docker hosts.
- Windows and macOS hosts in production; 32-bit ARM and other architectures.
- Keyless signing on CI systems whose OIDC identity the Sigstore instance does not accept,
  including Forgejo and Gitea Actions.
- The SDK's `/feed` outside Node.js (it needs Node's socket lookup hook).
- GitHub Enterprise Server as a `github` feed, and GitLab installed under a path prefix as
  a `gitlab` feed.
- Registries over plain HTTP for signature verification.

## Recorded end-to-end results

2026-10-02, `linux/arm64` (Colima 6 GiB on macOS; Docker-in-Docker host
`docker:29.8.2-dind`, classic image store; registry `registry:3.0.0`; the sidecar image built
from this repository):

| Scenario file | Covers | Result |
| --- | --- | --- |
| `10-trust` | key mode end to end, cosign 3 storage in registry v3, API authentication and the public status (no token in any answer or log), unsigned images, images and a release.json signed with another key, a release.json changed after signing, swapped digests, a missing bundle, a signature deleted after scheduling (fetch fails, unchanged), keyless refusing an unsigned release, none mode recorded | passed |
| `20-failures` | health never passes, a crash loop (fails fast), a wrong version, a failing migrate hook: all `rolled_back` with the env file byte-identical; a failure after a migration: `needs_attention`, the recorded recovery commands run for real, the documented restore into a fresh database; release policy refusals (minimum version, manual steps, `requiresEnv`, `requiresUpdater`) | passed |
| `25-fetch` | a registry with a login (`docker.registryAuthFile` for pull and cosign), a refused login, a deleted image, an optional service left out of a release, an image whose version label does not match | passed |
| `30-lifecycle` | reschedule and cancel, an abort during the PostgreSQL backup, the sidecar killed during fetch (`interrupted`, unchanged) and during health (`interrupted`, `needs_attention`, services left alone), a missed start, the state lock (exit 75), the blockers `api_exposed`, `updater_image_unpinned` and `multiple_updaters`, image pruning that keeps the rollback image, retention by count and age with the protected backup | passed |
| `40-backups` | PostgreSQL round trip, age, a separate backups volume, MariaDB 11.8, MySQL 8.4, a quiesced volume, a command backup | passed |
| `50-examples` | node-postgres, python-postgres, static-site | passed |
| `60-release-tools` | build by digest, imagetools indexes from platform manifests and from an index, cosign attest, the release smoke with the upgrade through the sidecar | passed |

Not run yet: the containerd image store (`E2E_IMAGE_STORE=containerd`), `linux/amd64`,
Forgejo's registry and releases API (Q5), rootless Docker, `make update-demo` of the
examples, and on the first release run: keyless signing, GHCR and the GitHub release API.

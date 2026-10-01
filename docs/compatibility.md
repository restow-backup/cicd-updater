# Compatibility

What cicd-updater 1.0 runs on, and how well each claim is established.

| Label | Meaning |
| --- | --- |
| **Tested** | Covered by the project's unit tests, which run with fakes: fake servers, a fake resolver, a fake Docker and cosign runner. |
| **Expected** | Should work according to the upstream documentation (or the parts the unit tests cover), but nothing in the project's tests runs it. |
| **To verify** | Needs real Docker, a real registry, Sigstore or a real CI. It must be tested in the end-to-end run; the result is recorded on this page after that run. |

Where things stand: 1.0 is implemented and unit-tested with fakes (about 520 unit tests).
The Docker end-to-end tests, the checks against real registries and Sigstore, and the
build of the sidecar image are a later step. Until then, nothing that needs one of them is
marked Tested.

## Host

| Item | Status | Note |
| --- | --- | --- |
| Linux host, Docker Engine 24 or newer (API 1.43 or newer) | To verify | recorded after the e2e run. The version check (blocker `docker_too_old`) is unit-tested. |
| Docker Compose plugin bundled in the sidecar image | To verify | the sidecar runs Compose from its own image, so the host's Compose version does not matter to it; recorded after the e2e run |
| Classic image store | To verify | digest check after the pull (`RepoDigests`); recorded after the e2e run |
| containerd image store | To verify | digest check after the pull, and whether `compose up --pull never` resolves the written `repository:tag@digest` to the pulled image. If it does not, the sidecar switches to writing `repository@digest`; the choice is recorded here after the e2e run. |
| Rootless Docker | To verify | `docker.socket` path, same-path bind mount of the project directory |
| SELinux enforcing | Expected | bind mounts may need `:z` |
| Docker Desktop, colima (macOS, Windows) | Expected | development only; the project directory must be shared with the VM at the same path |
| `linux/amd64` | To verify | sidecar image and release actions; recorded after the e2e run |
| `linux/arm64` | To verify | sidecar image and release actions; recorded after the e2e run |

## Sidecar image

| Item | Status | Note |
| --- | --- | --- |
| Image build (Node.js 24 on Alpine; Docker CLI 29.8.2 with Buildx and Compose; cosign 3.1.3; age; tini) | To verify | tools pinned by image digest or taken from Alpine's signed packages (`docker/Dockerfile`); recorded after the image build |
| Verifier container (read-only, no capabilities, user `65534:65534`, `/verify` read-only) | To verify | the `docker run` arguments are unit-tested |
| cosign flags of the verifier against cosign 3.1.3 (exact identity, issuer, GitHub workflow repository, ref and trigger, `--trusted-root`, `--key`, `--insecure-ignore-tlog=true`) | To verify | the argument vectors are unit-tested |
| Classification of cosign and `docker pull` errors | Tested | against sample messages; the messages of real registries are to be verified |

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
| Node.js / TypeScript | 3 (SDK, React) | To verify | example `node-postgres`, update v1 to v2 through the sidecar; recorded after the e2e run |
| Python | 2 (HTTP API) | To verify | example `python-postgres`; recorded after the e2e run |
| Static sites (nginx) | 1 (CLI) | To verify | example `static-site`; recorded after the e2e run |
| Go, PHP, Java, .NET, Ruby | 2 | Expected | through the OpenAPI contract `openapi/updater-api.v1.yaml` |

| Built-in backup and probe | Status | Note |
| --- | --- | --- |
| PostgreSQL 16, 17 (`pg_dump -Fc` in the database container) | To verify | backup, verification, restore commands, probe presets; the commands are unit-tested. Recorded after the e2e run. |
| PostgreSQL 13 to 15 | Expected | |
| MySQL 8.4 (`mysqldump`) | To verify | recorded after the e2e run |
| MySQL 8.0 | Expected | |
| MariaDB 11 LTS (`mariadb-dump`) | To verify | recorded after the e2e run |
| MariaDB 10.6 to 11.x, other versions | Expected | |
| SQLite and file data, `volume` backup (quiesced) | To verify | recorded after the e2e run |
| MongoDB, Redis and others, `command` backup | Expected | |

## CI systems and trust modes

| CI | Mode | Status | Note |
| --- | --- | --- | --- |
| GitHub Actions | `keyless` | To verify | positive path signed with the workflow's own OIDC identity, and wrong-identity rejection; recorded after the e2e run |
| GitHub Actions | `key` | To verify | recorded after the e2e run |
| GitHub Actions | `none` | To verify | recorded after the e2e run |
| GitLab CI (gitlab.com) | `keyless` | Expected | `SIGSTORE_ID_TOKEN`, `templates/gitlab/.gitlab-ci.yml`; the project's CI cannot run GitLab pipelines |
| GitLab CI (gitlab.com) | `key` | Expected | |
| GitLab CI (gitlab.com) | `none` | Expected | |
| GitLab self-managed | `keyless` | Expected | only if the Sigstore instance accepts the instance's issuer; otherwise use `key` |
| GitLab self-managed | `key`, `none` | Expected | |
| Forgejo / Gitea Actions | `key` | To verify | composite actions on the Forgejo runner, including how the runner resolves the third-party actions; recorded after the e2e run |
| Forgejo / Gitea Actions | `none` | To verify | recorded after the e2e run |
| Other CI systems, through the `release` CLI | `key` | Expected | |
| Other CI systems, through the `release` CLI | `none` | Expected | |

Release-side functions:

| Item | Status | Note |
| --- | --- | --- |
| `release.json` creation and validation, the release policy file | Tested | |
| cosign argument vectors of signing (`sign`, `sign-blob`, `attest`) | Tested | real signing is to be verified |
| Build, index and SBOM argument vectors; the immutability check of `index` | Tested | against a fake `docker buildx imagetools`; real registries are to be verified |
| Release smoke: env check, env file (with `--env` values), Compose calls without the runner's variables named like env file keys, no-restart override, health and version | Tested | with a fake Docker; real Compose is to be verified |
| Release smoke against real Docker, including `upgrade-from` by recreate | To verify | recorded after the e2e run |
| Release smoke: upgrade through the sidecar (file feed, `none` mode, sidecar environment and volumes replaced with `!override`) | To verify | needs Docker Compose 2.24 or newer on the runner; recorded after the e2e run |
| Upload: GitHub, Forgejo/Gitea and GitLab release APIs, server URL or API base | Tested | against fake servers |
| Upload to the real GitHub and Forgejo APIs | To verify | recorded after the e2e run |
| Upload to the real GitLab API | Expected | |

## Registries

Signature storage depends on cosign: cosign 3 writes signatures as OCI 1.1 referring
artifacts and falls back to the referrers tag schema (`sha256-<digest>` index) where the
registry has no referrers API ([registries.md](registries.md)).

| Registry | Status | Note |
| --- | --- | --- |
| GitHub Container Registry (GHCR) | To verify | the project's own images and the GitHub template; recorded after the e2e run |
| distribution/registry (v2, v3) | To verify | the registry of the e2e harness (fallback tag schema); recorded after the e2e run |
| Docker Hub | Expected | |
| GitLab container registry | Expected | |
| Harbor 2.5 and later | Expected | |
| Quay, Amazon ECR, Azure Container Registry, Artifactory | Expected | |
| Forgejo / Gitea built-in registry | To verify | neither project documents OCI referrers or cosign; the e2e pushes, signs in `key` mode, verifies and checks the token scopes for reading. Recorded after the e2e run. |
| Mirrors filled with `cosign copy` | To verify | whether the copy carries cosign 3's referrers; recorded after the e2e run |
| Any registry without signature support | Expected | `none` mode only |

## Release hosts (feeds)

| Provider | Status | Note |
| --- | --- | --- |
| GitHub releases: list, drafts, tag pattern, public and private asset URLs | Tested | against a fake server |
| GitHub releases: the real API, public and private repositories | To verify | recorded after the e2e run |
| Forgejo / Gitea releases API, with a path prefix | Tested | against a fake server |
| Forgejo / Gitea releases API: a real Forgejo | To verify | recorded after the e2e run |
| GitLab releases with asset links | Tested | against a fake server |
| GitLab releases: the real API, private projects | Expected | not part of the e2e run |
| Static feed index (any https host) | Tested | against a fake server |
| File feed (mounted directory) | Tested | index, documents and bundles by plain file name |
| File feed in the release smoke and on an air-gapped host | To verify | recorded after the e2e run |
| Address guard (https only, public addresses, no pooling, redirects, token dropped across origins, caps) | Tested | fake resolver, fake servers and a real local socket |

## SDK runtimes

| Runtime | Status | Note |
| --- | --- | --- |
| Node.js 22, 24 | Tested | unit tests; the CI matrix runs both |
| Bun, Deno: `/protocol`, `/semver`, `/messages` | Expected | no Node.js-specific APIs |
| Browsers: `/react`, `/protocol`, `/semver`, `/messages` | Expected | the React components are unit-tested with server-side rendering in Node.js, not in a browser |

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

None yet. Each "To verify" row above gets its result here, with the versions tested,
after the end-to-end run.

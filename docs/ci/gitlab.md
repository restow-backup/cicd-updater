# GitLab CI

This guide sets up the release side of an app on GitLab CI with keyless signing (the job's
OIDC token), images in the GitLab container registry, and GitLab releases as the feed. It
uses `templates/gitlab/.gitlab-ci.yml`. GitLab has no composite actions, so the pipeline
runs the `release` CLI from the sidecar image, which contains the Docker CLI, Buildx,
Compose and cosign ([release-side.md](../release-side.md#the-release-cli-for-other-ci-systems)).

Status: **Expected**. The CLI is unit-tested with fakes, but the project's own CI cannot run
GitLab pipelines; a GitLab run has not been tested ([compatibility.md](../compatibility.md)).

## What the template does

On a tag matching `^v\d+\.\d+\.\d+`, three stages run in the sidecar image with a
Docker-in-Docker service:

| Job | Commands |
| --- | --- |
| `build` | `release build` for `linux/amd64,linux/arm64` (QEMU through `binfmt`), pushed by digest; the built images and the smoke images are passed on as a dotenv artifact |
| `smoke` | `release smoke` with the upgrade from the previous GitLab release; the report is kept as an artifact |
| `publish` | `release index`, `release sign-images --signing keyless`, `release json create`, `json validate`, `json sign`, `release upload --host gitlab` |

The publish job is the only job with an OIDC token
(`id_tokens: { SIGSTORE_ID_TOKEN: { aud: sigstore } }`); cosign reads `SIGSTORE_ID_TOKEN`
from the environment.

## Before you start

- A runner with the Docker executor that allows **privileged** containers: the
  `docker:dind` service and the `binfmt` installer need it. Privileged jobs are root on the
  runner host; use a runner reserved for this project (select it with `tags:`).
- The app repository with a Dockerfile, a Compose file whose managed services take their
  image from a variable, a complete `.env.example`, a health endpoint that reports the
  version, and `.cicd-updater/release-policy.yaml`
  ([release-side.md](../release-side.md#the-release-policy-file)).
- A smoke override that publishes the health port. The app runs inside the dind service
  and the job reaches it as host `docker`, so publish on all interfaces of the dind
  service, not on its loopback:

  ```yaml
  # docker-compose.smoke.yml
  services:
    api:
      ports:
        - "3000:3000"
  ```

## Step by step

### 1. Copy the template

Copy `templates/gitlab/.gitlab-ci.yml` to `.gitlab-ci.yml` (or include it). The signing
identity names the project's top-level CI configuration path (`.gitlab-ci.yml` unless the
project settings say otherwise), so keep it in sync with `ciConfigPath` on the hosts.

### 2. Pin the images

- `CICD_UPDATER_IMAGE`: verify the sidecar image and append its digest
  (`ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>`,
  [upgrading-the-updater.md](../upgrading-the-updater.md)).
- `docker:28-dind` and `tonistiigi/binfmt`: pin both by digest.

### 3. Adjust the marked lines, and fix two lines of the template

The lines marked `ADJUST`: the image repository, the Compose files, `--image-vars` and the
health URL. Two more changes are needed:

- **The API base for the upload.** `release upload --host gitlab` expects the API base
  (`https://<host>/api/v4`), and GitLab provides it as `CI_API_V4_URL`. Use

  ```yaml
      - >-
        cicd-updater release upload --host gitlab --api-url "$CI_API_V4_URL"
        --repository "$CI_PROJECT_PATH" --tag "$CI_COMMIT_TAG"
        --files release.json,release.json.sigstore.json,smoke-report.md
  ```

  instead of `--api-url "$CI_SERVER_URL"`.
- **The variable that holds the repository.** The template defines
  `APP_IMAGE: $CI_REGISTRY_IMAGE/app` in `variables:` and passes
  `--image-vars '{"app": "APP_IMAGE"}'`. CI variables are in the job's environment, and
  Compose prefers its environment to the smoke env file, so the smoke would start
  `$CI_REGISTRY_IMAGE/app` (the `latest` tag) instead of the pushed digest. Rename the CI
  variable, for example to `APP_REPOSITORY`, in `variables:` and in the `build` script.

### 4. Tokens and variables

| Variable | Kind | Used for |
| --- | --- | --- |
| `CI_REGISTRY_USER`, `CI_REGISTRY_PASSWORD` | predefined | `docker login` to the project's container registry (push, index, signatures) |
| `SIGSTORE_ID_TOKEN` | `id_tokens`, `aud: sigstore` | keyless signing, publish job only |
| `CI_JOB_TOKEN` | predefined | `release upload`: sent as `JOB-TOKEN` to upload the files to the generic package registry and to create the release |
| `RELEASE_TOKEN` | optional CI/CD variable, masked and protected | when set, `release upload` uses it instead (header `PRIVATE-TOKEN`, scope `api`), and `release smoke` reads earlier releases with it (needed for a private project) |

### 5. The upgrade test

The smoke job runs `--upgrade-from previous --feed-type gitlab --feed-url "$CI_PROJECT_URL"`.
For the very first release the project has no release, the feed read fails with
`no_release`, and so does the smoke: use `--upgrade-from none` for that release. A
self-managed GitLab on a private address cannot be read by `upgrade-from` (the feed client
only connects to public addresses); use `none` there.

### 6. Release

```sh
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

The files go to the generic package registry (package `release-assets`, version = tag),
and the release is created last with asset links named `release.json`,
`release.json.sigstore.json` and `smoke-report.md`.

### 7. Configure the hosts

```yaml
# updater.yaml
release:
  feed:
    type: gitlab
    url: https://gitlab.com/acme/notes

trust:
  mode: keyless
  keyless:
    gitlab:
      host: gitlab.com
      project: acme/notes
      ciConfigPath: .gitlab-ci.yml
```

For a private project add `release.feed.tokenFile` with a `read_api` token
([feeds.md](../feeds.md)); for a private registry add `docker.registryAuthFile` with a
deploy token or access token with `read_registry` ([registries.md](../registries.md)).
Reading release assets of a private project through the asset links is to be verified.

### What the template does not do

- **No SBOMs.** The sidecar image has no `syft`; add a job with syft and
  `release sbom` if you want them.
- **No automatic signature check before the upload.** `release json verify` checks GitHub
  identities and public keys only. Verify a GitLab keyless release by hand (below) before
  announcing it.

## Key mode instead of keyless

For self-managed GitLab that the public Sigstore instance does not accept as an issuer,
use a cosign key pair:

- add a CI/CD variable `COSIGN_KEY` of type **File** with the content of `cosign.key`, and
  a masked variable `COSIGN_PASSWORD`; protect both;
- commit `cosign.pub` (the public half) to the repository;
- remove the `id_tokens` block and sign with the key:

```yaml
    - cicd-updater release sign-images --images "$PUBLISHED" --signing key --key "$COSIGN_KEY"
    - >-
      cicd-updater release json create --images "$PUBLISHED" --version "$VERSION" --tag "$CI_COMMIT_TAG"
      --signing key --out release.json
    - cicd-updater release json validate --file release.json --tag "$CI_COMMIT_TAG"
    - cicd-updater release json sign --file release.json --signing key --key "$COSIGN_KEY"
    - cicd-updater release json verify --file release.json --public-key cosign.pub
```

The CLI passes `COSIGN_PASSWORD` to cosign in its environment only. On the hosts use
`trust.mode: key` with `publicKeyFiles` ([trust-modes.md](../trust-modes.md#key)).

## Repository protections

- **Protected tags** `v*` (Settings, Repository, Protected tags): allowed to create:
  Maintainers. Without it, every developer can push a tag that the pipeline signs.
- **Protected variables need protected tags.** GitLab gives protected CI/CD variables only
  to pipelines of protected branches and tags. Protect the release tags so that
  `COSIGN_KEY`, `COSIGN_PASSWORD` and `RELEASE_TOKEN` are available to them, and to no
  other pipeline.
- **Protected default branch**: merge requests with approval, no force push.
- **`id_tokens` only in the signing job.** The template does this; do not move it to a
  default section.
- **Pinned images** by digest, and a runner reserved for privileged release jobs.
- **Never move or reuse a tag.** GitLab refuses to create a release twice for a tag; a
  correction is a new version.

## Keyless identity specifics

For the tag `v1.4.0` of `acme/notes` on gitlab.com, the hosts expect:

| | |
| --- | --- |
| Issuer | `https://gitlab.com` |
| Identity | `https://gitlab.com/acme/notes//.gitlab-ci.yml@refs/tags/v1.4.0` |

Note the double slash before the CI configuration path. The identity changes when the
project is renamed or moved to another group, when the CI configuration path changes, or
for a tag that does not match `release.tagPattern`.

Self-managed GitLab signs with its own issuer `https://<host>`. Keyless works only if the
Sigstore instance in use accepts that issuer; otherwise use key mode.

Verify a release by hand:

```sh
cosign verify-blob --bundle release.json.sigstore.json \
  --certificate-identity https://gitlab.com/acme/notes//.gitlab-ci.yml@refs/tags/v1.4.0 \
  --certificate-oidc-issuer https://gitlab.com \
  release.json

cosign verify registry.gitlab.com/acme/notes/app:1.4.0 \
  --certificate-identity https://gitlab.com/acme/notes//.gitlab-ci.yml@refs/tags/v1.4.0 \
  --certificate-oidc-issuer https://gitlab.com
```

and on a host: `docker compose --profile updater exec updater cicd-updater verify 1.4.0`.

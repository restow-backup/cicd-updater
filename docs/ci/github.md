# GitHub Actions

This guide sets up the release side of an app on GitHub Actions with keyless signing,
images on the GitHub Container Registry (GHCR), and GitHub releases as the feed. It uses
`templates/github/release.yml`.

Status: the template and the actions are implemented and unit-tested with fakes; a real
GitHub run (signing with the workflow's OIDC identity, GHCR, the release API) is to be
verified in the end-to-end run ([compatibility.md](../compatibility.md)).

## What the template does

Pushing a tag `v*` starts two jobs:

| Job | Runs on | Steps |
| --- | --- | --- |
| `build` (matrix `amd64`, `arm64`) | `ubuntu-24.04` and `ubuntu-24.04-arm` (native runners) | `actions/build` pushes the image by digest, untagged; `actions/smoke` starts that digest and checks health, version and the upgrade from the previous release; the digest is kept as an artifact |
| `release` (after both builds) | `ubuntu-24.04` | `actions/publish` creates and tags the multi-arch index, signs it keyless and attaches SBOMs; `actions/release-json` writes, signs and verifies `release.json`, uploads it to a draft release and publishes the release |

Nothing is tagged and no release is public unless both smoke tests passed
([release-side.md](../release-side.md)).

## Before you start

The app repository needs:

- a Dockerfile per image;
- a Compose file whose managed services take their image from a variable, for example
  `image: ${APP_IMAGE:?set APP_IMAGE in .env}`;
- `.env.example` with every variable the Compose files use (optional ones commented out);
- a health endpoint that answers JSON with the version (for example `{"version": "1.4.0"}`);
- `docker-compose.smoke.yml`, used only by the smoke test, which publishes the health port
  on the runner's loopback:

  ```yaml
  services:
    api:
      ports:
        - "127.0.0.1:3000:3000"
  ```

- `.cicd-updater/release-policy.yaml` ([release-side.md](../release-side.md#the-release-policy-file)).

## Step by step

### 1. Copy the template

Copy `templates/github/release.yml` to `.github/workflows/release.yml`. Keep the file name,
or set `trust.keyless.github.workflow` on the hosts to the name you choose: the file path
is part of the signing identity.

### 2. Adjust the marked lines

The lines marked `ADJUST`:

- the image repository per image key (lowercase, for example `ghcr.io/acme/notes`);
- one `build` step per further image, and its digest in the "Keep the digest" and "The
  platform digests per image" steps;
- the smoke inputs: `compose-files`, `image-vars` (the env key of each image in the Compose
  file), `health-url`, `health-version-path`.

**Rename the workflow variable that holds the repository.** The template keeps the
repository in a workflow-level variable `APP_IMAGE` and passes `image-vars:
'{"app": "APP_IMAGE"}'`. When the Compose file also reads `APP_IMAGE`, the workflow
variable reaches Compose during the smoke test and wins over the smoke env file, so the
smoke would start `ghcr.io/acme/notes` (the `latest` tag) instead of the pushed digest.
Give the workflow variable another name, for example:

```yaml
env:
  APP_REPOSITORY: ghcr.io/acme/notes

# and in the steps
          image: ${{ env.APP_REPOSITORY }}
          images: '{"app": {"repository": "${{ env.APP_REPOSITORY }}", "digest": "${{ steps.app.outputs.digest }}"}}'
          image-vars: '{"app": "APP_IMAGE"}'
```

and use `$APP_REPOSITORY` in the "The platform digests per image" step.

### 3. Pin the actions

The template references the cicd-updater actions by tag (`@v1.0.0`) for readability.
Replace the tag with the full commit SHA of the release you reviewed and keep the tag as a
comment:

```yaml
        uses: restow-backup/cicd-updater/actions/build@<40-character commit SHA> # v1.0.0
```

Let Dependabot propose updates:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

The actions pin every third-party action they use to a commit SHA themselves.

### 4. The upgrade test

The template sets `upgrade-from: previous` on the smoke step: it starts the newest earlier
release with a `release.json` first and then updates it to the new digests. For the very
first release the repository has no release at all, and the feed read fails with
`no_release`; set `upgrade-from: none` for that release and switch to `previous`
afterwards.

To run the upgrade through the sidecar itself, add:

```yaml
          updater-config: updater.yaml
          updater-image: ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>
```

### 5. Release

```sh
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

### 6. Configure the hosts

```yaml
# updater.yaml
release:
  feed:
    type: github
    url: https://github.com/acme/notes

trust:
  mode: keyless
  keyless:
    github:
      repository: acme/notes
      workflow: .github/workflows/release.yml
```

For a private repository add `release.feed.tokenFile` ([feeds.md](../feeds.md)); for a
private GHCR package add `docker.registryAuthFile` ([registries.md](../registries.md)).

## Permissions, secrets and tokens

| Scope | Permissions | Why |
| --- | --- | --- |
| Workflow | `contents: read` | default for every job |
| `build` job | `contents: read`, `packages: write` | push by digest to GHCR with `GITHUB_TOKEN` |
| `release` job | `contents: write` | create, upload and publish the GitHub release |
| | `packages: write` | tag the indexes, store signatures and SBOM attestations |
| | `id-token: write` | keyless signing with the workflow's OIDC identity |

No other secret is needed: only `GITHUB_TOKEN` and the OIDC identity. Do not use personal
access tokens in the release workflow. For another registry, pass `registry`, `username`
and a `password` secret to `build` and `publish`.

GHCR package settings: the first push creates the package. Link it to the repository and
set its visibility. A public package needs no credentials on the hosts; a private one needs
a token with `read:packages` in `docker.registryAuthFile`. If the package was created
outside this workflow, give the repository write access to it in the package's Actions
access settings.

Native arm64 runners: the template uses `ubuntu-24.04-arm`. If such runners are not
available to the repository, build both platforms in one job with QEMU
(`platforms: linux/amd64,linux/arm64` in one `build` step and that one digest in
`digests`), or use the single-job `release` action. The smoke test then starts only the
amd64 images.

## Repository protections

In `keyless` mode the release workflow is the trust anchor: whoever can make it run on a
release tag can publish a release that every host accepts. Protect it:

- **Tag ruleset** for `v*` (repository settings, Rules, Rulesets, new tag ruleset): restrict
  creations to a bypass list of maintainers, restrict updates, restrict deletions. Without
  it, everyone with write access can push a release tag.
- **Release tags from the default branch only.** Rulesets cannot express this. Add a job
  before `build` that checks it, as the project's own release workflow does:

  ```yaml
  verify:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@<SHA> # v7.0.1
        with:
          fetch-depth: 0
      - name: The tag is annotated and its commit is on main
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
          TAG: ${{ github.ref_name }}
        run: |
          set -euo pipefail
          kind="$(gh api "repos/$GITHUB_REPOSITORY/git/ref/tags/$TAG" --jq '.object.type')"
          [ "$kind" = tag ] || { echo "::error::$TAG is not an annotated tag"; exit 1; }
          git merge-base --is-ancestor "$GITHUB_SHA" origin/main \
            || { echo "::error::$TAG is not on main"; exit 1; }
  ```

  and add `verify` to `needs` of `build`. Signed tags are recommended.
- **Branch protection** on the default branch: pull requests with review, required status
  checks, no force push, no deletion.
- **An environment with required reviewers** for the `release` job (optional, recommended
  for public projects): add `environment: release` to the job. The signing identity does
  not change; it stays the workflow file at the tag.
- **Default token permissions** read-only (repository settings, Actions, General). The
  template sets the permissions explicitly per job.
- **Pinned actions** by full commit SHA, updated by Dependabot or Renovate.
- **Never move or reuse a tag.** A correction is a new version.

## Keyless identity specifics

For the tag `v1.4.0` of `acme/notes`, the hosts expect:

| | |
| --- | --- |
| Issuer | `https://token.actions.githubusercontent.com` |
| Identity | `https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0` |
| Workflow repository | `acme/notes` |
| Workflow ref | `refs/tags/v1.4.0` |
| Trigger | `push` |

A release does not verify when:

- the workflow ran on another event than `push` of the tag (`workflow_dispatch`, a
  `release` event, a schedule);
- the workflow file was renamed, or the signing step moved into a reusable workflow (the
  identity is the file whose job signs);
- the repository was renamed or transferred after the release was signed, or the release
  was signed in a fork;
- the tag does not match `release.tagPattern`.

[trust-modes.md](../trust-modes.md) explains the checks.

## Verify a release by hand

```sh
cosign verify ghcr.io/acme/notes:1.4.0 \
  --certificate-identity https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository acme/notes \
  --certificate-github-workflow-ref refs/tags/v1.4.0 \
  --certificate-github-workflow-trigger push

gh release download v1.4.0 --repo acme/notes --pattern 'release.json*'
cosign verify-blob --bundle release.json.sigstore.json \
  --certificate-identity https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository acme/notes \
  --certificate-github-workflow-ref refs/tags/v1.4.0 \
  --certificate-github-workflow-trigger push \
  release.json
```

On a host with the sidecar, the dry run checks the same and more, without pulling:

```sh
docker compose --profile updater exec updater cicd-updater verify 1.4.0
```

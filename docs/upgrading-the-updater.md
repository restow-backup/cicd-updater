# Upgrading the updater

The sidecar never updates itself. Its container holds the Docker socket, which is root on the
host, so its image changes only by an operator's action, after the operator verified it. This
page explains when to upgrade, how to verify and pin a new sidecar image, what stays
compatible between 1.x versions, and how to go back.

## Why the sidecar does not update itself

- The image of the `updater` service is pinned by you, by digest. The sidecar never pulls or
  starts its own image as an update.
- A run refuses to start while the sidecar's own service would take its image from a key the
  sidecar rewrites (blocker `updater_image_unpinned`), so the container that holds the socket
  can never run an image the sidecar installed.
- An image reference without a digest gives the warning `updater_image_not_digest_pinned`.
- `selfCheck` only tells you that a newer version exists; it never installs it.

## When to upgrade

| Reason | How you notice |
| --- | --- |
| a security fix | the project's security advisories and release notes. The latest minor of the current major is supported; the previous minor for 3 months after the next minor (see `SECURITY.md`) |
| a release of your app needs a newer sidecar | the release is refused with `updater_too_old` (`requires.updater` in its `release.json`) |
| a new feature or fix you want | the changelog |
| the selfCheck notice | `updater.latestAvailable` in `GET /v1/state` |

### The selfCheck notice

```yaml
selfCheck:
  enabled: true
```

With `selfCheck.enabled: true` the sidecar reads the release list of
`https://github.com/restow-backup/cicd-updater` (stable channel) when it starts and once a day.
When a newer version exists, `GET /v1/state` reports it as `updater.latestAvailable`; your app
can show it to admins, and `cicd-updater status --json` shows it on the host. It reads only
the release list, sends nothing about your installation, and installs nothing. It is off by
default, because it is an outbound connection to GitHub that some installations do not want.

## Before you upgrade

1. Read the changelog entries between your version and the target.
2. Make sure no run is in the `running` phase:

   ```sh
   docker compose exec updater cicd-updater status
   ```

   A restart during a run interrupts it: before the point of no return it ends `unchanged`,
   after it `needs_attention`. A **scheduled** run survives the restart if the new sidecar is
   back before `startsAt` plus `schedule.lateStartToleranceSeconds`.
3. At levels 2 and 3, let the app ingest the journal first (it normally does so every few
   seconds), so no event is pending if something goes wrong.

## Verify the new image

Every sidecar image is signed keyless by the project's release workflow,
`.github/workflows/release.yml` of `restow-backup/cicd-updater`, at the release tag. Verify
the exact digest you are going to pin, not a tag that could move:

```sh
VERSION=1.1.0
docker buildx imagetools inspect ghcr.io/restow-backup/cicd-updater:$VERSION
# Name:      ghcr.io/restow-backup/cicd-updater:1.1.0
# MediaType: application/vnd.oci.image.index.v1+json
# Digest:    sha256:<digest>

cosign verify ghcr.io/restow-backup/cicd-updater@sha256:<digest> \
  --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v$VERSION \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository restow-backup/cicd-updater \
  --certificate-github-workflow-ref refs/tags/v$VERSION \
  --certificate-github-workflow-trigger push
```

| Flag | What it pins down |
| --- | --- |
| `--certificate-identity` | exactly this workflow file of this repository, run for exactly this tag (no regular expression) |
| `--certificate-oidc-issuer` | the identity was issued by GitHub Actions |
| `--certificate-github-workflow-repository` | the workflow ran in `restow-backup/cicd-updater`, not in a fork or another repository |
| `--certificate-github-workflow-ref` | it ran for the tag `v<version>` |
| `--certificate-github-workflow-trigger` | it was started by a tag push, not by hand |

`cosign verify` must exit 0. Use a recent cosign; the image itself was signed with the cosign
version pinned in the project (3.1.3 in 1.0).

Optionally verify the release assets too. The release carries `release.json` (with the image
key `updater`), `SHA256SUMS` and a Sigstore bundle for each:

```sh
cosign verify-blob release.json --bundle release.json.sigstore.json \
  --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v$VERSION \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository restow-backup/cicd-updater \
  --certificate-github-workflow-ref refs/tags/v$VERSION \
  --certificate-github-workflow-trigger push
jq -r .images.updater.digest release.json      # must equal the digest you pin

cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v$VERSION \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --check --ignore-missing SHA256SUMS
```

## Pin it by digest

Put the verified digest into the `image:` of the `updater` service, or into the variable it
reads (a variable that is not one of the writable keys):

```yaml
services:
  updater:
    image: ghcr.io/restow-backup/cicd-updater:1.1.0@sha256:<digest>
```

```sh
# or, as in the examples, in .env
CICD_UPDATER_IMAGE=ghcr.io/restow-backup/cicd-updater:1.1.0@sha256:<digest>
```

The tag is for people reading the file; Docker uses the digest. Pin the image the same way
wherever you run the `release` CLI (the GitLab template's `CICD_UPDATER_IMAGE`), and pin the
release actions by commit SHA.

## Check the configuration with the new version

A newer sidecar may add configuration keys but never changes the meaning of existing ones.
Still, validate your `updater.yaml` with the new image before you switch:

```sh
docker run --rm --network none \
  -v /opt/notes:/opt/notes:ro \
  -e CICD_UPDATER_COMPOSE__PROJECT_DIR=/opt/notes \
  ghcr.io/restow-backup/cicd-updater:1.1.0@sha256:<digest> \
  config check --file /opt/notes/updater.yaml
```

Exit code 0 means the new version accepts the configuration.

## Switch

```sh
docker compose --profile updater up -d updater
docker compose logs --tail 20 updater          # "cicd-updater 1.1.0 starting (config ...)"
docker compose exec updater cicd-updater version
docker compose exec updater cicd-updater doctor
docker compose exec updater cicd-updater status
```

Compose recreates the container with the new image. The volumes (`/state`, `/shared`,
`/verify`) stay: the history, the journal, the backups and the token survive, so the app
needs no change. `status.json` is internal: 1.0 writes format version 1, and a later version
that changes the format reads older files and rewrites them on start (versioning policy).

## Compatibility between 1.x versions

Everything in this table keeps working across 1.x; breaking changes come only with 2.0 (see
[versioning](versioning.md)):

| Contract | Promise |
| --- | --- |
| `release.json` schema 1 | a sidecar 1.x accepts every valid document produced by any 1.x release action; new optional fields only |
| feed index schema 1 | the same |
| `updater.yaml` `version: 1` | keys keep their meaning and defaults; new optional keys only; a default that weakens security never changes |
| environment overrides `CICD_UPDATER_*` | as the keys |
| HTTP API `/v1` and the public status | additive only; clients tolerate unknown fields and render unknown codes generically |
| failure, message, blocker, warning and problem codes | never removed or renamed; new codes in minor versions |
| outcomes and phases | fixed |
| SDK public exports | SemVer; an SDK 1.x talks to any sidecar 1.x and adapts to its features (`api.features` in `GET /v1/state`) |
| CLI commands, flags and exit codes | SemVer |
| release action inputs and outputs | SemVer |
| labels `io.github.restow-backup.cicd-updater.*` | fixed |

Not covered: `status.json` (internal; newer versions convert older files on start), log texts, the HTML and CSS
of the maintenance page, the internal packages, poll timings, and the exact versions of the
Docker CLI, Compose, Buildx and cosign bundled in the image (they change in patch and minor
releases).

So you can upgrade the sidecar and the release side independently within 1.x, in either
order. A release of your app that needs a newer sidecar says so with `requires.updater` and
is refused (`updater_too_old`) until you upgrade.

## Rolling back the sidecar

If a new sidecar misbehaves, go back to the previous verified digest:

1. Make sure no run is `running` (see above).
2. Put the previous image reference back into the Compose file or `.env`.
3. `docker compose --profile updater up -d updater`, then `doctor` and `status`.

Things to check when going back:

| Situation | Effect | What to do |
| --- | --- | --- |
| `updater.yaml` uses a key the older version does not know | the older sidecar refuses the file (unknown key, exit code 64) | remove the key first; `config check` with the old image tells you |
| the newer version wrote `status.json` in a newer internal format | the older sidecar moves it aside as `status.json.corrupt-<epoch ms>` and starts idle without history and journal | let the app ingest the journal before; the file stays in `/state` for inspection, so you can go forward again |
| a release requires the newer sidecar (`requires.updater`) | it is refused with `updater_too_old` | stay on the newer sidecar for that release |
| the app uses an SDK feature the older sidecar lacks | the SDK sees it missing in `api.features` | nothing; the SDK adapts |

In 1.0 the internal format of `status.json` is version 1.

## Upgrading to a new major version

A major version may change the contracts above. Read its upgrade notes before you switch. A
sidecar 2.x keeps serving `/v1` for at least one major version, so the app can follow later.

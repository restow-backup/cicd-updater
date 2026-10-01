# Versioning

cicd-updater uses [Semantic Versioning](https://semver.org) for the whole repository: one
version number for the sidecar image, the SDK, the actions, the `release` CLI, the JSON
Schemas and the OpenAPI document. Breaking changes to anything in the stability promise
below happen only in a new major version.

## What is published

| Artefact | Name | Where |
| --- | --- | --- |
| Sidecar image (also contains the `release` CLI) | `ghcr.io/restow-backup/cicd-updater:<X.Y.Z>` | GHCR; `linux/amd64` and `linux/arm64`; signed keyless by the project's release workflow, with SBOM attestations; only immutable `X.Y.Z` tags |
| SDK | `@restow-backup/cicd-updater` | GitHub release asset `restow-backup-cicd-updater-<X.Y.Z>.tgz`, installable with `npm install <URL of the asset>`; on npm when trusted publishing is set up for the repository |
| Actions | `restow-backup/cicd-updater/actions/<name>@v<X.Y.Z>` | this repository; pin the commit SHA of the tag |
| JSON Schemas, OpenAPI | `schemas/*.schema.json`, `openapi/updater-api.v1.yaml` | the repository at the tag, and release assets |
| Checksums | `SHA256SUMS` and `SHA256SUMS.sigstore.json` | release assets |
| The project's own `release.json` | `release.json` and `release.json.sigstore.json` | release assets (image key `updater`) |

How to verify and pin a new sidecar image: [upgrading-the-updater.md](upgrading-the-updater.md).

## The 1.x stability promise

These contracts keep working across all 1.x versions:

| Contract | Promise |
| --- | --- |
| `release.json` schema version 1 | Readers accept every valid 1.x document. New fields are optional; readers ignore fields they do not know. |
| Feed index schema version 1 | The same. |
| `updater.yaml` `version: 1` | Keys keep their meaning and their defaults. New keys are optional. A default that weakens security never changes. |
| Environment overrides (`CICD_UPDATER_*`) | As the keys they set. |
| HTTP API `/v1` and the public status | Additive only: new endpoints, new optional request fields, new response fields, new code values. |
| Failure, message, blocker, warning and problem codes | Never removed or renamed in 1.x. New codes come in minor versions. |
| Outcomes and phases | Fixed for 1.x. |
| SDK public exports (`@restow-backup/cicd-updater` and its subpaths) | SemVer. |
| CLI commands, flags and exit codes, including `cicd-updater release` | SemVer. The sidecar CLI exits with `0`, `1`, `2`, `3`, `64`, `75`; the release CLI with `0`, `1`, `2` ([cli.md](cli.md)). |
| Action inputs and outputs, with their defaults | SemVer. |
| Release asset names `release.json`, `release.json.sigstore.json` | Fixed. |
| Labels `io.github.restow-backup.cicd-updater.*` (`role`, `managed`) | Fixed. |

Clients must be written for additive change: tolerate unknown fields in every response,
and render an unknown code generically instead of failing. The SDK does: it ignores
unknown response fields, reads codes as strings, and its message catalogs fall back to a
generic text for codes they do not know.

### Not covered

- `status.json` and everything else in the state volume. It is internal and migrated
  forward automatically on start; clients use the API, never the file.
- Log texts and the wording of messages. Use the codes.
- The HTML and CSS of the built-in maintenance page.
- The internal packages of the monorepo (`@cicd-updater/protocol`, `feed`, `engine`,
  `sidecar`, `release-tools`) and the bundled `actions/lib/release-tools.mjs`.
- Timing: poll intervals, cache durations, retry behaviour.
- The exact versions of the tools in the sidecar image (Node.js, Docker CLI, Buildx,
  Compose, cosign, age). They are updated in patch or minor releases.

## Compatibility across components

| Combination | Rule |
| --- | --- |
| Release side 1.x and sidecar 1.x | A sidecar 1.x accepts `release.json` documents written by any 1.x action or CLI. A release that needs a newer sidecar says so in `requires.updater`; an older sidecar refuses it with `updater_too_old` instead of misreading it. |
| SDK 1.x and sidecar 1.x | Any combination works. Optional capabilities are announced in `GET /v1/state` as `api.features` (`abort`, `reschedule`, `verification`, `source_mode`, `encryption`, `events`, `backups`, `public_status`, `maintenance_page`), so an SDK can adapt to an older sidecar. An SDK that cannot parse the state reports `incompatible`. |
| cosign on both sides | The actions' `cosign-version` input defaults to the cosign version of the sidecar image of the same release (`v3.1.3` in 1.0). Keep both on the same cosign minor version: signatures are stored where the signing cosign writes them and found where the verifying cosign looks ([registries.md](registries.md)). Update the actions when you update the sidecar. |
| Major versions | A breaking API change gets a new path prefix (`/v2`); a sidecar 2.x keeps serving `/v1` for at least one major version. A breaking `release.json` change gets `schemaVersion: 2`, which a sidecar 1.x rejects (`release.unsupported_schema`). |

## Releases and the changelog

- `main` is always releasable. Releases are annotated tags `vX.Y.Z` on `main`.
- `CHANGELOG.md` follows Keep a Changelog: an `Unreleased` section on top, one section per
  version with its date, `## [X.Y.Z] - YYYY-MM-DD`.
- Every change to a contract in the table above is named explicitly in the changelog.
- The release workflow refuses a tag that is lightweight or not on `main`, a version
  without a dated changelog section, and a tag that differs from the versions in the
  `package.json` files (`cicd-updater release check-tag`).
- A published version is never changed. Image tags `X.Y.Z` are never moved; a correction
  is a new version.

## Supported versions

The latest minor version of the current major version receives fixes. The previous minor
version receives fixes for three months after a new minor version is released.
Report vulnerabilities as described in `SECURITY.md`.

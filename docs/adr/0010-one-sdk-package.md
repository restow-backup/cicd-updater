# 0010. One npm package, optional npm

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 10 of section 0) |

## Context

The SDK serves two runtimes: server code (client, feed check, token verifier) and browser
code (React components, protocol types, SemVer, message catalogs). Internally it builds on
packages of the repository that are not published (protocol, feed).

Publishing to npm needs either a long-lived token in CI or npm's trusted publishing set up
for the repository and package. Neither should block the first release.

## Decision

- The SDK ships as **one** self-contained package, `@restow-backup/cicd-updater`, with
  subpath exports: `.`, `/feed`, `/auth`, `/protocol`, `/semver`, `/messages`, `/react`.
- ESM only, TypeScript declarations included. All internal code is bundled; `zod` is the
  only regular dependency, and `react` is an optional peer dependency.
- Every GitHub release carries the package as a tarball
  (`restow-backup-cicd-updater-<version>.tgz`), covered by the signed `SHA256SUMS`. 1.0 is
  installable with `npm install <tarball URL>`.
- Once trusted publishing is set up, the release workflow publishes the same tarball to npm
  with provenance; until then that step is skipped.
- The package name inside the tarball is the npm name, so switching from the tarball to npm
  changes only the install source, not any import.

## Consequences

- One version for the sidecar image, the SDK, the actions and the schemas; no version skew
  between parts of the SDK.
- The package is installable without npm, and verifiable through the release checksums.
- Until npm publishing exists, updating the SDK means changing the tarball URL by hand.
- Server-only entry points use Node.js modules; browser code imports only the browser-safe
  entry points (`/react`, `/protocol`, `/semver`, `/messages`).

## Alternatives considered

- **Several packages** (client, feed, React, protocol). Rejected: more publishing, and
  apps could combine incompatible versions.
- **npm required for 1.0.** Rejected: it would block the release on registry setup or on a
  long-lived token in CI.
- **Publishing the internal packages.** Rejected: their APIs would fall under the SemVer
  promise although they are implementation details.

# 0001. Three sides, one contract

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 1 of section 0) |

## Context

An update touches three parties: the CI that builds the app's images, the host that runs
them, and the app that users and admins work with. cicd-updater was extracted from the
opt-in updater of Restow. That updater found the image digests to install by parsing
lines in the human-written release notes.

Release notes are free text. Their format drifts, nothing signs them, and they cannot
express which digest belongs to which service, from which version an upgrade is allowed,
or that a release needs manual steps. Each app that wanted self-service updates also had
to carry its own update logic next to its business code.

## Decision

The update is split into three sides with fixed roles and one machine-readable contract
between them:

- **Release side.** The CI builds signed multi-arch images and publishes a signed
  `release.json` next to them. The document names the version, tag, channel, commit, one
  digest per image key, the minimum version an upgrade may start from, manual steps, and
  requirements (sidecar version, env keys). It is generated from the actually pushed
  digests, never typed by hand, and validated against a JSON Schema.
- **Sidecar.** One container on the host installs only what `release.json` and the
  signatures allow.
- **App.** The app only asks: it schedules, moves, cancels and acknowledges runs through
  the HTTP API. It cannot choose an image, a repository, a hook or a file.

`release.json` replaces digests parsed from release notes.

## Consequences

- One document carries everything an installation needs to decide, and the sidecar and the
  SDK read it with the same parser and rules.
- Any language can integrate (the HTTP API with OpenAPI); TypeScript apps get the SDK.
- The release side must adopt the release actions or the `release` CLI to produce the
  document. A release without `release.json` is listed as not installable by the updater
  (`no_release_document`) and never installed in image mode.
- The document has its own compatibility rules: readers ignore unknown fields, new optional
  fields may appear in 1.x, and `schemaVersion: 2` is reserved and rejected by a 1.x
  sidecar.
- The release document is a contract covered by the [stability promise](../versioning.md).

## Alternatives considered

- **Keep parsing digests from release notes.** Rejected: unsigned, fragile, and it cannot
  bind digests to services or carry upgrade rules.
- **Attach the metadata to the images** (annotations or attestations). Rejected for 1.0,
  see [0003](0003-signed-release-document.md).
- **Let the app perform the update itself** with access to the Docker socket. Rejected: a
  compromise of the app would be a compromise of the host, and the app is the component
  that is stopped and replaced during the update ([0008](0008-pull-model-local-state.md)).

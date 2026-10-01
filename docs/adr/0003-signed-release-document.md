# 0003. `release.json` is signed too

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 3 of section 0) |

## Context

Image signatures prove that each image was built by the release workflow. They do not say
which digest belongs to which service, from which version an upgrade is allowed, or whether
a release needs manual steps. Those facts live in `release.json`.

Someone who can edit release assets but cannot run the workflow could, with image
signatures alone:

- swap the digests of two images of the same release, both validly signed;
- remove `manualSteps.required`, so a release that needs operator work installs anyway;
- lower `minimumFromVersion`, so an unsupported upgrade path is attempted.

## Decision

- In `keyless` and `key` mode, `release.json` is signed with `cosign sign-blob` by the same
  identity or key as the images. The Sigstore bundle is published as the release asset
  `release.json.sigstore.json`.
- In `keyless` mode the bundle must verify for the exact identity and issuer, and the
  certificate's ref must be the release tag. In `key` mode it must verify against one of the
  configured public keys.
- The sidecar verifies the document **before** it trusts any field of it, stores the
  verified bytes for the run, verifies the stored bytes again at the start of the run and
  checks that their SHA-256 equals the one recorded at scheduling.
- A schedule request may carry `expect.releaseSha256`, the hash the admin was shown. A
  different document is refused (`release_mismatch`), so what an admin read is what gets
  installed.

## Consequences

- A tampered release asset cannot swap images between services, lower the minimum version
  or hide manual steps.
- The release side has one more signing step and one more asset; the release actions do
  both.
- In `none` mode the document is not verified (`document: "not_checked"`).
- Feed checks in the app (the SDK) parse documents without verifying them; they inform
  admins, and the sidecar verifies before installing.

## Alternatives considered

- **Image signatures alone.** Rejected: the gaps listed above.
- **An in-toto attestation attached to each image.** Rejected for 1.0: it ties the
  document to one image, needs registry support for attestations, and is harder to fetch
  before any image is known.
- **Signing the human release notes.** Rejected: not machine-readable, and the notes are
  edited after publication.

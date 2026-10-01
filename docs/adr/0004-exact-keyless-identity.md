# 0004. Exact keyless identity, composite actions instead of a reusable workflow

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 4 of section 0) |

## Context

In `keyless` mode the trust anchor is the identity in the signing certificate: which
workflow, in which repository, at which ref signed the release. The check is only as
strong as the identity it expects.

The obvious way to share release logic on GitHub is a reusable workflow. When a reusable
workflow signs, the certificate identity names that reusable workflow, not the caller's
workflow. A sidecar that expects "signed by the cicd-updater release workflow" would then
accept images from every repository that calls it.

## Decision

- The expected identity is the **app's own** release workflow at the **exact** release
  tag:
  - GitHub: issuer `https://token.actions.githubusercontent.com`, identity
    `https://github.com/<repository>/<workflow>@refs/tags/<tag>`, plus the GitHub-specific
    checks: workflow repository, workflow ref `refs/tags/<tag>`, trigger `push`.
  - GitLab: issuer `https://<host>`, identity
    `https://<host>/<project>//<ciConfigPath>@refs/tags/<tag>`.
  - Generic: an issuer and an identity template with `{tag}` (and optionally `{version}`).
- The tag is rendered from `release.tagPattern` and must equal `release.json`'s `tag`. The
  identity is computed per release and passed to cosign as an exact identity, never as a
  regular expression.
- 1.0 ships **composite actions** (`build`, `smoke`, `publish`, `release-json`, and the
  all-in-one `release`) and **copyable workflow templates** for GitHub, Forgejo and GitLab.
  The app's own workflow runs the actions, so the app's own identity signs.

## Consequences

- A signature from another repository, another workflow file, a branch or another tag is
  rejected.
- Adopters copy a workflow template instead of calling one reusable workflow. Template
  improvements reach them only when they update their copy.
- The actions should be referenced by full commit SHA, like any third-party action.
- Tag protection becomes part of the trust anchor: whoever can create a release tag can
  produce a valid signature. [Security](../security.md) lists the recommended repository
  protections.

## Alternatives considered

- **A reusable release workflow.** Rejected: it puts the shared workflow into the
  certificate and lets any caller's images pass.
- **Identity matching by regular expression.** Rejected: easy to widen by mistake, hard to
  review.
- **Repository-only identity** (any workflow, any ref of the repository). Rejected: a
  branch build or an unrelated workflow could produce installable releases.

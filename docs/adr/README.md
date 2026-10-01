# Decision records

These records explain the fundamental decisions behind cicd-updater 1.0: what was decided,
why, what it costs, and which alternatives were considered. There is one record per
decision of section 0 of the [design specification](../design.md).

| # | Decision | Status |
| --- | --- | --- |
| [0001](0001-three-sides-one-contract.md) | Three sides, one contract: a signed, machine-readable `release.json` replaces digests parsed from release notes | Accepted |
| [0002](0002-explicit-trust-modes.md) | Explicit trust modes (`keyless`, `key`, `none`), no silent downgrade | Accepted |
| [0003](0003-signed-release-document.md) | `release.json` is signed too, with the same identity as the images | Accepted |
| [0004](0004-exact-keyless-identity.md) | Exact keyless identity; composite actions instead of a reusable workflow | Accepted |
| [0005](0005-pull-by-digest.md) | Pull by digest, write `repo:tag@sha256:...` | Accepted |
| [0006](0006-rollback-only-when-certain.md) | Roll back only when it is certain; otherwise `needs_attention` | Accepted |
| [0007](0007-no-self-update-no-api-hooks.md) | The sidecar never updates itself and never runs what it installed; hooks only from `updater.yaml` | Accepted |
| [0008](0008-pull-model-local-state.md) | Pull model, local durable state, exactly-once journal | Accepted |
| [0009](0009-smoke-before-publish.md) | What does not start is not published | Accepted |
| [0010](0010-one-sdk-package.md) | One npm package with subpath exports, installable without npm | Accepted |

## Format

Each record has the sections Status, Context, Decision, Consequences and Alternatives
considered. Records are numbered in order and never renumbered. A decision that changes
gets a new record that supersedes the old one; the old record stays, with its status set
to "Superseded by NNNN".

# 0002. Explicit trust modes, no silent downgrade

| | |
| --- | --- |
| Status | Accepted |
| Scope | cicd-updater 1.0 ([design](../design.md), decision 2 of section 0) |

## Context

Keyless signing with Sigstore needs a CI identity that the public Sigstore instance
accepts. GitHub Actions and GitLab CI provide one. Forgejo and Gitea Actions, private
infrastructure and other CI systems do not. Some test setups sign nothing at all.

A verifier that falls back to "unsigned" whenever verification fails gives an attacker a
downgrade path: block Sigstore or strip the signature, and the host installs an unverified
image. The same holds for a trust policy taken from the release itself.

## Decision

The trust mode is configured explicitly, on both sides, and never changes implicitly:

| Mode | Trust anchor |
| --- | --- |
| `keyless` (default) | the CI's OIDC identity of the release workflow at the release tag, the Sigstore root, the transparency log |
| `key` | a cosign key pair; the sidecar lists 1 to 5 public keys (rotation); the transparency log is optional |
| `none` | digests only, over TLS |

Rules:

- Without a `trust` section the mode is `keyless`. An incomplete `keyless` or `key`
  configuration, or leftover settings of an inactive mode, is a configuration error; the
  sidecar does not start (exit code 64).
- `none` requires `mode: none` **and** `none.acknowledgeUnsigned: true`. It adds the
  warning `trust_mode_none`, every run records `trustMode: "none"` and
  `verification.signatures: "not_checked"`, the journal carries it and the UI shows it.
  Digests remain mandatory.
- In `keyless` and `key` mode a missing, invalid or unverifiable signature (including
  "Sigstore unreachable") fails the run before the point of no return with outcome
  `unchanged`. The sidecar never retries in a weaker mode.
- Switching modes means changing `updater.yaml` and recreating the sidecar.
- The `signing` block in `release.json` is informational and never influences the policy.

## Consequences

- Forgejo, Gitea and private infrastructure get real signatures through `key` mode.
- There is no downgrade path: what cannot be verified is not installed.
- In `keyless` mode a Sigstore outage blocks updates; air-gapped hosts use a local
  trusted root (`trust.keyless.trustedRootFile`).
- `none` relies on TLS of the release host and registry only. Its risk is stated in
  [trust modes](../trust-modes.md): anyone who can change the release document can make
  the host run an image of their choice next to a root-equivalent socket.
- Release side and sidecar must be configured consistently; a mismatch fails visibly.

## Alternatives considered

- **Keyless only.** Rejected: it excludes Forgejo and Gitea Actions and private
  infrastructure.
- **Verify when possible, fall back to unsigned otherwise.** Rejected: a silent downgrade
  is an attack path.
- **Take the mode from `release.json` (`signing.mode`).** Rejected: the document's author
  would choose how the document is checked.
- **No signature requirement by default.** Rejected: the default must be the safe one.

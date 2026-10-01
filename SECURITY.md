# Security policy

cicd-updater runs next to your app with access to the Docker socket, so its security
matters more than that of most libraries. Thank you for helping to keep it safe.

## Supported versions

| Version | Supported |
| --- | --- |
| Latest minor of the current major (1.x) | yes |
| Previous minor | for 3 months after the next minor was released |
| Older versions | no |

## Reporting a vulnerability

Please do **not** open a public issue for a vulnerability.

Report it privately through GitHub's private vulnerability reporting:
[Security, Report a vulnerability](https://github.com/restow-backup/cicd-updater/security/advisories/new).
If that is not possible for you, use the security contact address published on the
repository's security page.

Please include:

- the affected version (`cicd-updater version`) and component,
- your configuration with secrets removed (`cicd-updater config check --json` redacts values),
- the steps to reproduce and what you expected instead.

## What happens next

- We acknowledge your report within 5 business days.
- We assess it within 14 days and tell you our view of severity and the plan.
- We fix it and coordinate the disclosure with you. The default embargo is up to 90 days.
- We credit you in the advisory if you want.

## Scope

In scope:

- the sidecar image (`ghcr.io/restow-backup/cicd-updater`) and the `cicd-updater` CLI in it,
- the release actions under `actions/` and the `release` CLI,
- the SDK `@restow-backup/cicd-updater`,
- the JSON Schemas under `schemas/` and the HTTP API contract under `openapi/`.

Out of scope:

- the fact that the sidecar holds the Docker socket: this is by design and documented in
  [docs/security.md](docs/security.md),
- installations running with `trust.mode: none` (no signatures are checked there, by choice),
- vulnerabilities of the apps that use cicd-updater.

## Verifying our releases

Every release image is signed keyless by this repository's release workflow at the release
tag. Verify the sidecar image before you run it (replace `1.0.0` with the version):

```sh
cosign verify ghcr.io/restow-backup/cicd-updater:1.0.0 \
  --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository restow-backup/cicd-updater \
  --certificate-github-workflow-ref refs/tags/v1.0.0 \
  --certificate-github-workflow-trigger push
```

The release assets carry `SHA256SUMS` and its Sigstore bundle. Verify them with:

```sh
cosign verify-blob SHA256SUMS --bundle SHA256SUMS.sigstore.json \
  --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
sha256sum --check --ignore-missing SHA256SUMS
```

## Hardening

The hardening checklist for operators is in [docs/security.md](docs/security.md).

# Threat model

This page lists what cicd-updater protects, against whom, how, and what risk remains. The
mechanisms are described in [security.md](security.md), [trust-modes.md](trust-modes.md),
[feeds.md](feeds.md) and [registries.md](registries.md).

Status: the mitigations are implemented and unit-tested with fakes. Their behaviour against
real Docker, registries and Sigstore is to be verified in the end-to-end run
([compatibility.md](compatibility.md)).

## Assets

| Asset | Why it matters |
| --- | --- |
| The host | The sidecar holds the Docker socket, which is root on the host. |
| The app's data and database | The installed release runs with them; a migration can change them irreversibly. |
| Backups | Plaintext copies of all data unless encrypted with `age`. |
| Secrets in the env file | Database passwords and API keys of the app. |
| The shared token | Grants the API of the sidecar: scheduling, cancelling, reading state. |
| The signing key (`key` mode) | Whoever holds it can publish releases every host accepts. |
| The release pipeline | In `keyless` mode, the workflow at a release tag is the trust anchor. |

## Trust boundaries

```
 release side (CI, signing identity or key)
        │ push by digest, sign, publish
        ▼
 registry, release host, Sigstore            ◀── network attacker, compromised registry,
        │ https                                   someone who can edit release assets
        ▼
 host: sidecar (Docker socket) ◀── token ── app backend ◀── users, admins
        │                                       ▲
        └── public status (read-only) ── edge ──┘◀── anonymous visitors
```

Inside the host, the sidecar trusts only `updater.yaml` (written by the operator), the
signature policy in it, and the Docker daemon. It trusts the app only as far as the token
and the API allow.

## Adversaries and mitigations

| # | Adversary or event | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | Network attacker between the host and the registry, the feed or Sigstore | https only for feeds; `release.json` signed and verified before any field is used; images verified by signature and pulled by digest | `none` mode relies on TLS only; denial of service |
| T2 | Compromised or malicious registry or mirror | images verified by digest and signature; pulled by digest; the local image must carry the verified digest (`fetch.digest_mismatch`); cosign parses registry and transparency log responses in an isolated container without the socket and without capabilities | denial of service; a cosign vulnerability is contained by the isolation, not excluded, and not contained with `trust.verifier.isolate: false` |
| T3 | Someone who can edit releases or assets on the release host but cannot run the workflow | the signed `release.json` binds the digest of each image key, the minimum version, manual steps and requirements; a schedule request can pin the document's SHA-256 (`expect.releaseSha256`); the stored bytes are re-verified at the start of the run | denial of service (assets deleted or replaced are refused); withholding releases (T9) |
| T4 | Compromised app (code execution in the app container) holding the token | the API schedules only signed, strictly newer releases from the configured feed; no endpoint chooses a command, an image, a repository, a hook or a file; source mode only when the operator enabled it, and only from the configured repository; no downgrade; backup contents and `recover restore-env` are only reachable through the CLI on the host | forced update to a legitimate newer release at a time of its choice; cancelling, aborting before the point of no return, rescheduling, acknowledging; reading the update state, run logs (redacted), the effective configuration (redacted) and backup metadata (not contents) |
| T5 | Another container on the internal network | token required for `/v1`, compared in constant time; the token file is mounted read-only into the app only | if the operator mounts the token elsewhere; the unauthenticated endpoints (`/healthz`, public status, maintenance page) answer anyone on the network |
| T6 | Compromised CI or release workflow (the trust anchor) | out of the sidecar's reach; the keyless identity accepts only the configured workflow file of the configured repository, at the release tag, triggered by a push; repository protections ([ci/github.md](ci/github.md), [ci/gitlab.md](ci/gitlab.md), [ci/forgejo.md](ci/forgejo.md)) | full: a signed malicious release is installed |
| T7 | Leaked signing key (`key` mode) | rotation and revocation by editing `trust.key.publicKeyFiles`; optional transparency log on both sides for detection | releases signed with the stolen key are accepted until the key is removed |
| T8 | Replay or downgrade with an old signed release | the target must be strictly newer than the running version; version and tag are signed in `release.json`; in `keyless` mode the identity contains the tag, so a signature for one tag does not verify for another | someone holding the token (T4) can choose an older release that is still newer than the running one |
| T9 | Freeze: the feed hides new releases | none in 1.0 | stale installations |
| T10 | Huge or slow responses (denial of service) | size caps (feed list 8 MiB, `release.json` 64 KiB, bundle 256 KiB, source archive `source.maxArchiveMb`), time limits, streaming reads; request bodies at most 64 KiB; captured command output capped | none beyond a failed check or run |
| T11 | Information leak through the public status | no user, no image, no path, no log; versions only with `publicStatus.showVersions`; message parameters are versions, codes and counts only | phase and timing of updates are public by design |
| T12 | Local host user reading backups | state directory `0700`, backup files `0600`; optional `age` encryption with the private key off the host; retention by count and age | root on the host can read plaintext backups |
| T13 | SSRF through an admin-entered feed URL in the app | the address guard of the SDK and the sidecar: https only, every resolved address public, no pooling, redirects by hand with the token dropped across origins ([feeds.md](feeds.md)) | hosts the operator allowed on private networks |
| T14 | Secrets in logs, status, problem details and process lists | redactor (registered values and patterns, plus `logging.redactPatterns`); no secrets in argv; child processes get a filtered environment; registry credentials for the verifier as per-verification files | patterns can miss token formats they do not know |
| T15 | Env file injection | the sidecar writes only the writable keys (refused in code for any other key); values must match the image reference grammar (no quotes, no `$`, no whitespace); only those lines change, byte-exact; a change by someone else during the run stops it (`start.env_changed`) | none known |
| T16 | Time of check to time of use between verification and pull | verify `repository@digest`, pull exactly that digest, check the local image by digest, write a digest-pinned reference `repository:tag@digest` | none known |
| T17 | Two sidecars on one project | state lock with heartbeat (exit code 75); label scan, blocker `multiple_updaters` | sidecars without the role label and with another state volume |
| T18 | Malicious hook configuration | hooks come only from `updater.yaml`, which only the operator writes; the app has no write access to the project directory (an operator requirement); the configuration is read once at start and its hash recorded in every run | an operator mistake |
| T19 | Someone who can edit release assets, aiming at the release CI | the release smoke reads the previous release's `release.json` without verifying it (it only decides what the smoke starts); the images run in the smoke job with the app's own Compose files, before anything is signed | an image of the attacker's choice can run on the CI runner during the smoke job, with the runner's network and resources; it gets no CI secret unless the Compose files pass one. Keep signing secrets out of the job that runs the smoke where the CI allows it (the GitHub template signs in a separate job) |

## Supply-chain assumptions

The trust anchor is the release workflow in `keyless` mode, and the private key with its CI
secret in `key` mode. cicd-updater cannot detect a malicious release that this anchor
signed (T6). Recommended protections, detailed per CI in the guides:

- protected release tags (`v*`): only maintainers create them, no update, no deletion;
  release tags only from the default branch; annotated, preferably signed tags;
- a protected default branch: reviewed changes, required checks, no force push;
- the signing job in a protected environment where the CI supports it; minimal token
  permissions; OIDC tokens or signing secrets only in the job that signs;
- third-party actions and images pinned by digest or commit SHA, updated by a bot; the
  cicd-updater actions referenced by commit SHA too;
- no personal access tokens in the release workflow where the CI token suffices;
- registry package visibility and access tied to the repository;
- never move or reuse a tag; a correction is a new version.

The cicd-updater project releases itself with the same actions and the same rules
([upgrading-the-updater.md](upgrading-the-updater.md) shows how to verify its image).

## Out of scope

- The fact that the sidecar holds the Docker socket: it is the design, and the reason for
  everything above.
- Installations in `trust.mode: none` (no authenticity is claimed).
- Vulnerabilities of the adopters' apps, and of the images they publish.

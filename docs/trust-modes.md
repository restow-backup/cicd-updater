# Trust modes

A trust mode decides how the sidecar establishes that a release is authentic: that
`release.json` and every image digest it names come from the app's own release pipeline.
There are three modes, configured on both sides independently and never changed
implicitly.

| | `keyless` | `key` | `none` |
| --- | --- | --- | --- |
| Release side input | `signing: keyless` | `signing: key`, `cosign-key` (+ `cosign-password`) | `signing: none` |
| Works on | GitHub Actions, GitLab CI (gitlab.com; self-managed only if the Sigstore instance accepts its issuer) | any CI: Forgejo and Gitea Actions, other CI, a workstation; private registries | any |
| Trust anchor | the CI's OIDC identity of the release workflow at the release tag, the Sigstore root, the transparency log | possession of the private key | TLS of the release host and the registry only |
| Sidecar setting | `trust.keyless.*` | `trust.key.publicKeyFiles` | `trust.none.acknowledgeUnsigned: true` |
| `release.json` | bundle verified for the exact identity and issuer | bundle verified against one of the keys | not verified (`not_checked`) |
| Images | `cosign verify` of `repository@digest` for the exact identity | `cosign verify --key` | not verified; the digest is still required and checked after the pull |
| Transparency log | always (the public Rekor instance) | off by default on both sides | none |
| Network of the sidecar | Sigstore's TUF repository (or `trustedRootFile`), the registry | the registry | the registry |

Status: the cosign argument vectors of both sides are unit-tested with fakes. Signing and
verification against the real Sigstore services and registries are to be verified in the
end-to-end run ([compatibility.md](compatibility.md)).

## Rules

- **The default requires a signature.** Without a `trust` section the mode is `keyless`.
  An incomplete `keyless` or `key` configuration is a configuration error: the sidecar does
  not start (exit code 64) and names the missing keys.
- **`none` is deliberate.** It needs `mode: none` **and** `none.acknowledgeUnsigned: true`.
- **Settings of an inactive mode are an error.** A `keyless` block next to `mode: key`, or
  a leftover `none` block next to `mode: keyless`, stops the sidecar with exit code 64, so
  a reader of the file is never misled about what is checked.
- **No fallback.** In `keyless` and `key` mode a missing, invalid or unverifiable
  signature, including "Sigstore unreachable", refuses the release at scheduling
  (`422 release_unverifiable`) or fails the run before the point of no return with outcome
  `unchanged`. The sidecar never retries in a weaker mode.
- **`release.json` says how it was signed, but does not decide.** `signing.mode` in the
  document is informational; only `updater.yaml` sets the policy.

## `keyless`

### Release side

The release workflow signs with the CI's own OIDC identity; there is no key to manage.

- `cosign sign --yes <repository>@<index digest>` for every image;
- `cosign sign-blob --yes --bundle release.json.sigstore.json release.json`;
- SBOM attestations with `cosign attest` (not evaluated by the sidecar).

| CI | Requirement |
| --- | --- |
| GitHub Actions | `permissions: id-token: write` in the job that signs |
| GitLab CI | `id_tokens: { SIGSTORE_ID_TOKEN: { aud: sigstore } }` in the job that signs |

Signatures and certificates are recorded in the public transparency log. That makes the
release metadata (repository, workflow, tag, digests) public.

The identity is the workflow file **whose job signs**. That is why cicd-updater ships
composite actions and copyable templates instead of a reusable workflow: a reusable
workflow from another repository would put that repository into the certificate, and any
caller's images would pass a check for it.

### Sidecar: the exact identity

Exactly one of three forms must be set:

```yaml
trust:
  mode: keyless
  keyless:
    github:
      repository: acme/notes                  # owner/repo
      workflow: .github/workflows/release.yml  # the file that signs
```

```yaml
trust:
  mode: keyless
  keyless:
    gitlab:
      host: gitlab.com                         # default
      project: acme/notes                      # group[/subgroup...]/project
      ciConfigPath: .gitlab-ci.yml             # default
```

```yaml
trust:
  mode: keyless
  keyless:
    issuer: https://issuer.example.com
    identityTemplate: https://ci.example.com/acme/notes/release@refs/tags/{tag}
```

The identity is computed per release from the release tag, which is
`release.tagPattern` rendered with the version (default `v{version}`), and must equal
`release.json.tag`:

| Form | Issuer | Certificate identity (exact) | Additional checks |
| --- | --- | --- | --- |
| `github` | `https://token.actions.githubusercontent.com` | `https://github.com/<repository>/<workflow>@refs/tags/<tag>` | workflow repository = `<repository>`, workflow ref = `refs/tags/<tag>`, trigger = `push` |
| `gitlab` | `https://<host>` | `https://<host>/<project>//<ciConfigPath>@refs/tags/<tag>` | none |
| generic | `issuer` | `identityTemplate` with `{tag}` (required) and `{version}` (optional) replaced | none |

The identity is passed to cosign as an exact string, never as a regular expression. For
the release `1.4.0` of the GitHub example the sidecar runs:

```sh
cosign verify \
  --certificate-identity https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0 \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com \
  --certificate-github-workflow-repository acme/notes \
  --certificate-github-workflow-ref refs/tags/v1.4.0 \
  --certificate-github-workflow-trigger push \
  ghcr.io/acme/notes@sha256:<digest>
```

and the same flags with `cosign verify-blob --bundle release.json.sigstore.json release.json`
for the document. With `trustedRootFile` set, `--trusted-root <file>` is added.

What the exact GitHub identity means in practice:

- The release workflow must run on **`push` of the tag**. A run started by
  `workflow_dispatch`, by a `release` event or by a schedule has another trigger and does
  not verify.
- The **file name** is part of the identity. Renaming `release.yml` requires changing
  `trust.keyless.github.workflow` on every host, and old releases keep the old name.
- The **repository** is part of the identity, as `owner/repo`. Write it exactly as GitHub
  shows it; the comparison is exact. A fork signs as the fork and does not verify.
- The **tag** is part of the identity. A tag that does not match `release.tagPattern` is
  never listed, and a signature made for another tag does not verify.

GitLab: the identity is GitLab's CI configuration reference, which uses a double slash
before the configuration path, for example
`https://gitlab.com/acme/notes//.gitlab-ci.yml@refs/tags/v1.4.0`. A self-managed GitLab
uses its own issuer `https://<host>`; keyless works only if the Sigstore instance accepts
that issuer. If it does not, use `key` mode.

Generic form: for another CI whose OIDC issuer the Sigstore instance accepts. Both
`issuer` and `identityTemplate` are required; the template must contain `{tag}`, may
contain `{version}`, and must render to printable ASCII without spaces (at most 1024
characters). `GET /v1/state` shows the configured identity with `<version>` as a
placeholder (`trust.identity`).

### Air-gapped hosts: `trustedRootFile`

By default cosign fetches and caches Sigstore's trusted root through TUF
(`https://tuf-repo-cdn.sigstore.dev`). On a host without that access, set
`trust.keyless.trustedRootFile` to a Sigstore trusted root JSON file that you copy onto
the host and keep current. `cicd-updater doctor` checks that the file is readable, or that
the TUF repository is reachable when no file is set. Offline keyless verification is to
be verified in the end-to-end run.

## `key`

### Release side

```sh
cosign generate-key-pair      # writes cosign.key (encrypted) and cosign.pub
```

Store the content of `cosign.key` as a CI secret (input `cosign-key`) and its password as
a second secret (input `cosign-password`). `cosign-key` may also be a KMS URI that cosign
supports (anything with `://`); then export the public key with
`cosign public-key --key <uri>`. The actions write a PEM key to a temporary file with
`umask 077` and remove it in a step that always runs; the password reaches cosign only as
`COSIGN_PASSWORD` in its environment.

The release side signs with `cosign sign --yes --key <key> --tlog-upload=false` and
`cosign sign-blob --yes --key <key> --tlog-upload=false --bundle ...`. With
`transparency-log: true` the `--tlog-upload=false` flag is left out and the signatures are
uploaded to the public transparency log.

### Sidecar

```yaml
trust:
  mode: key
  key:
    publicKeyFiles: [/etc/cicd-updater/cosign.pub]   # 1 to 5 PEM public keys
    transparencyLog: false                           # default
```

For each key in order, the sidecar runs `cosign verify --key <file>
[--insecure-ignore-tlog=true] <repository>@<digest>` (and `cosign verify-blob --bundle ...
--key <file>` for `release.json`) until one passes. A wrong key lets the next key try; an
infrastructure failure (registry unreachable, unauthorized, rate limited) stops at once.
The public key files are copied into the verifier's workspace for each verification.

### Transparency log in `key` mode

| Release side `transparency-log` | Sidecar `trust.key.transparencyLog` | Result |
| --- | --- | --- |
| `false` (default) | `false` (default) | verifies; nothing about the release is published |
| `true` | `false` | verifies; the log entry is not checked |
| `true` | `true` | verifies; a signature without a log entry fails |
| `false` | `true` | fails (`signature_invalid` or `signature_missing`) |

With `transparencyLog: true` the sidecar needs the Sigstore services for the log's public
key; there is no trusted root file setting in `key` mode. Keep it `false` on air-gapped
hosts.

### Key rotation and revocation

1. Generate the new key pair.
2. Add the new public key to `trust.key.publicKeyFiles` on every host (up to 5 keys) and
   recreate the sidecar (`docker compose --profile updater up -d updater`).
3. Switch the CI secrets to the new private key and password. New releases are signed
   with it; older releases still verify with the old key.
4. When no release you still want to install depends on the old key, remove it from the
   list and recreate the sidecar.

Revocation is removing a key from the list. A leaked key is valid on every host until
then; releases it signed are accepted. The transparency log (when enabled on both sides)
makes misuse visible, not impossible.

## `none`

```yaml
trust:
  mode: none
  none:
    acknowledgeUnsigned: true
```

and `signing: none` on the release side (or any signing; nothing is checked).

What still holds:

- the feed, the documents and the registry are reached over https only;
- `release.json` is validated, and every refusal applies (newer version, minimum version,
  manual steps, requirements, platform);
- every needed image must have a digest in `release.json`; the sidecar pulls exactly that
  digest, checks that the local image carries it, and writes a digest-pinned reference.

What is lost: anyone who can change the release document can choose what runs. That
includes whoever controls the release host account, a leaked CI or release token, or a
man in the middle wherever TLS is broken. The image they choose runs with the app's data,
next to a container that holds the Docker socket, which is root on the host.

`none` is shown everywhere, so nobody mistakes it for a verified installation:

- warning `trust_mode_none` in the capabilities, and a warning line in
  `cicd-updater doctor`;
- `trust.mode: "none"` in `GET /v1/state`;
- every run records `trustMode: "none"`, `release.document: "not_checked"` and
  `verification.signatures: "not_checked"`, logs that signatures were not checked, and the
  journal events carry it.

Use `none` only for test installations, demos (the examples' `update-demo` targets), or
fully private networks where the operator controls build, registry and host. `key` mode
costs one secret and is almost always the better choice. The release smoke test uses
`none` internally for a throwaway sidecar on the CI runner, because the images are signed
only after the smoke passed ([release-side.md](release-side.md)).

## When the two sides disagree

| Release side signs | Sidecar mode | Result |
| --- | --- | --- |
| `keyless` | `keyless`, matching identity | verified |
| `keyless` | `keyless`, other identity (workflow, repository, tag, trigger) | refused: `signature_invalid` |
| `key` | `key` with the public key | verified |
| `key` | `keyless` | refused |
| `keyless` | `key` | refused |
| `none` | `keyless` or `key` | refused: no bundle, `signature_missing` |
| any | `none` | installed without verification |

## Changing the mode

The mode is read once when the sidecar starts. To change it, edit `updater.yaml` (set
`mode`, add the new mode's block, **remove the old mode's block**), then recreate the
sidecar. A run never sees two configurations.

Environment overrides (`CICD_UPDATER_TRUST__MODE` and friends,
[configuration.md](configuration.md)) can set scalar keys but cannot remove a block of the
file. Because settings of an inactive mode are a configuration error, a trust mode cannot
be switched by environment variables alone while the file still contains the other
mode's block: for example `CICD_UPDATER_TRUST__MODE=key` with a file that has
`trust.keyless.github` stops the sidecar with exit code 64. Switching works by
environment only when the file has no mode-specific block, for example a file without a
`trust` section plus `CICD_UPDATER_TRUST__MODE=key` and
`CICD_UPDATER_TRUST__KEY__PUBLIC_KEY_FILES=/etc/cicd-updater/cosign.pub`. Keep the mode in
the file; it is the place a reviewer looks.

Check a configuration offline with `cicd-updater config check`, and the running sidecar
with `cicd-updater doctor` ([cli.md](cli.md)).

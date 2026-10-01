# Registries

The sidecar talks to the registries of the managed images in four ways, always by digest:

| What | Command | When |
| --- | --- | --- |
| Signature verification | `cosign verify ... <repository>@<digest>` in the isolated verifier | dry run, scheduling, `fetch` step (`keyless`, `key`) |
| Existence check | `docker buildx imagetools inspect --raw <repository>@<digest>` | dry run in `none` mode |
| Pull | `docker pull <repository>@<digest>` | `fetch` step |
| Access check | `docker buildx imagetools inspect --raw <current image>` | `cicd-updater doctor` |

Status: the registry handling is implemented and unit-tested with fakes. No real registry
has been tested yet; every registry below is **Expected** or **To verify** until the
end-to-end run records a result in [compatibility.md](compatibility.md).

## Credentials: `docker.registryAuthFile`

Public images need no credentials. For private images, point the sidecar at a Docker
`config.json` that contains an `auths` object and nothing that needs a helper program:

```json
{
  "auths": {
    "ghcr.io": { "auth": "<base64 of user:token>" },
    "registry.example.com:5000": { "auth": "<base64 of user:token>" }
  }
}
```

```yaml
# updater.yaml
docker:
  registryAuthFile: /etc/cicd-updater/registry-auth.json
```

Create the `auth` value with `printf '%s' 'user:token' | base64`. Keep the file owned by
root with mode `0600` on the host and mount it read-only into the sidecar.

Rules:

- **Only `auths`.** A file with `credsStore` or `credHelpers` is refused when the sidecar
  starts (exit code 64): a credential helper would need a program and secrets outside the
  file, inside the container that holds the Docker socket.
- **Docker commands** (pull, `imagetools inspect`, Compose) use the file in place: the
  sidecar links it as `<state.dir>/docker-config/config.json` and sets `DOCKER_CONFIG` to
  that directory for its child processes. The file is not copied.
- **Verification** gets its own copy for each verification, with only the one entry it
  needs: the entry whose key is the registry host of the image reference (`ghcr.io`,
  `registry.example.com:5000`; for Docker Hub `docker.io` or
  `https://index.docker.io/v1/`). The copy is written into the verification workspace
  under `trust.verifier.workDir` with mode `0400`, owned by the verifier user
  (`65534:65534`), handed to cosign as the path in `DOCKER_CONFIG`, and deleted after the
  verification. Use the bare host as the key; an entry keyed `https://ghcr.io` is not found
  for verification.
- Credentials never appear in command-line arguments.

Give the sidecar a read-only token. As a guide: on GHCR a token with `read:packages`; on
the GitLab registry a deploy token or access token with `read_registry`; on Forgejo and
Gitea `read:package`; on Docker Hub a read-only access token.

`cicd-updater doctor` reads the manifest of every image the managed services currently
run, with these credentials. That proves read access to the package, which a successful
`docker login` does not.

## Mirrors: `images.<key>.repository`

A host can pull from a mirror instead of the repository named in `release.json`:

```yaml
images:
  app:
    repository: registry.example.com/mirror/notes
```

For the image key `app`, the sidecar then verifies and pulls
`registry.example.com/mirror/notes@<digest>` and writes
`registry.example.com/mirror/notes:<tag>@<digest>` into the env file. The digest comes from
the signed `release.json`; the trust policy (identity or keys) stays the same.

cosign looks for signatures in the repository it verifies, so **the signatures must be in
the mirror too**. Copy the image together with its signatures by digest:

```sh
cosign copy ghcr.io/acme/notes@sha256:<digest> registry.example.com/mirror/notes:1.4.0
```

Use the cosign version of the sidecar image for the copy. Copy before you schedule: the dry
run (`cicd-updater verify <version>`) checks the mirror. A mirror without signatures fails
with `fetch.signature_missing` (or `signature_missing` in the dry run). Whether
`cosign copy` carries the OCI 1.1 referrers that cosign 3 writes is to be verified in the
end-to-end run.

## Where cosign stores signatures

cosign 3 stores signatures (and attestations) as OCI 1.1 artifacts that refer to the
signed digest. On a registry without the OCI referrers API it falls back to the referrers
tag schema: an index under the tag `sha256-<digest>`. cosign 2 used tags named
`sha256-<digest>.sig`. Key-based and keyless signatures are stored the same way, so the
registry question is the same for `key` and `keyless` mode.

The sidecar does not look at the storage itself: it runs the cosign bundled in its image
(3.1.3 in 1.0), which looks where its version writes. Keep the release side on the same
cosign minor version; the actions' `cosign-version` input defaults to it.

A registry must therefore accept either the referrers API or the fallback tag for
signatures, and keep them. Two consequences for operators of self-hosted registries:

- **Cleanup policies.** Signatures stored as referrers and the platform manifests of a
  multi-arch index are untagged. A policy that deletes untagged manifests can remove them
  and break verification of releases that are still installed. Exclude them, or keep such
  policies off for release repositories.
- **Immutable tags.** The release side never moves a version tag; a registry setting that
  forbids it is compatible. The fallback tag `sha256-<digest>` must stay writable for
  later signatures and attestations of the same digest.

## Self-hosted quirks

- **`docker login` proves the account, not the right to read a package.** Use
  `cicd-updater doctor`, which reads a manifest.
- **Token scopes.** Some registries need broader scopes than "read" even for pulls, or
  separate scopes for the package and the repository. Test the token with the doctor.
- **404 instead of 401/403.** Private registries often answer "not found" for a repository
  the token may not see. The sidecar classifies by the message and checks the access words
  first: `denied`, `unauthorized`, `forbidden`, `authentication required`,
  `requires 'docker login'`, `401` or `403` make it `fetch.registry_unauthorized` even when
  the message also says "not found". A bare `manifest unknown` is reported as
  `fetch.image_not_found`; on a private registry, check the credentials first when you see
  it.
- **Rate limits.** `toomanyrequests`, `rate limit` or `429` give
  `fetch.registry_rate_limited`; authenticate or wait.
- **Private certificate authorities.** Pulls run in the Docker daemon of the host, so the
  daemon must trust the registry's certificate (for example
  `/etc/docker/certs.d/<host>/ca.crt`). The isolated verifier runs cosign with the
  certificate store of the sidecar image and does not see a private CA. With
  `trust.verifier.isolate: false`, cosign runs as a subprocess of the sidecar and receives
  `SSL_CERT_FILE` and `SSL_CERT_DIR` from the sidecar's environment. This setup is to be
  verified.
- **Plain HTTP registries** are not supported for verification; cosign is run without
  options for insecure registries.

How failures are reported:

| Code | Cause |
| --- | --- |
| `fetch.registry_unauthorized` | access refused (see above) |
| `fetch.image_not_found` | the manifest for the digest does not exist |
| `fetch.registry_rate_limited` | rate limit |
| `fetch.registry_unreachable` | DNS, connection, TLS or timeout |
| `fetch.pull_failed` | any other pull error |
| `fetch.signature_missing` | no signature found for the digest (signing off in CI, mirror without signatures) |
| `fetch.signature_invalid` | a signature by another identity or key, or a broken one |
| `fetch.verifier_failed` | cosign could not run or reach Sigstore |
| `fetch.digest_mismatch` | the pulled image is not known by the verified digest |

Remedies: [troubleshooting.md](troubleshooting.md).

## Registry status

Labels: **Tested** = covered by the project's tests; **Expected** = documented to work by
the upstream project, not tested by us; **To verify** = must be tested in the end-to-end
run, the result is recorded in [compatibility.md](compatibility.md).

| Registry | Pull by digest | cosign 3 signatures (referrers or fallback tag) | Status | Note |
| --- | --- | --- | --- | --- |
| GitHub Container Registry (GHCR) | yes | yes | To verify | the project's own images and the GitHub template; recorded after the e2e run |
| distribution/registry (v2, v3) | yes | fallback tag schema | To verify | the registry of the e2e harness; recorded after the e2e run |
| Docker Hub | yes | yes | Expected | |
| GitLab container registry | yes | yes | Expected | the GitLab template |
| Harbor (2.5 and later) | yes | yes | Expected | referrers in newer versions |
| Quay, Amazon ECR, Azure Container Registry, Artifactory | yes | yes | Expected | |
| Forgejo / Gitea built-in registry | yes | unknown | To verify | neither the Forgejo nor the Gitea documentation mentions OCI referrers or cosign; the e2e pushes, signs in `key` mode, verifies, and checks the token scopes needed to read. If it fails, use another registry for signed images or `none` mode |
| Any registry without signature support | yes | none | Expected | `none` mode only ([trust-modes.md](trust-modes.md)) |

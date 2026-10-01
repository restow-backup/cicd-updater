# Forgejo and Gitea Actions

This guide sets up the release side of an app on Forgejo Actions (Gitea Actions works the
same way) with a cosign key pair, images in the Forgejo container registry, and Forgejo
releases as the feed. It uses `templates/forgejo/release.yml`.

Forgejo and Gitea Actions have no OIDC identity that the public Sigstore instance accepts,
so **keyless signing is not available** here. Use `key` mode, or `none` for test setups
([trust-modes.md](../trust-modes.md)).

Status: **To verify**. The composite actions are unit-tested with fakes; running them on a
Forgejo runner, signing into the Forgejo registry and reading the Forgejo releases API are
to be verified in the end-to-end run ([compatibility.md](../compatibility.md)).

## What the template does

One job on a runner with Docker, on every tag `v*`:

1. `actions/build` builds `linux/amd64` and `linux/arm64` with QEMU and pushes the result
   by digest, untagged (most Forgejo runners have one architecture);
2. `actions/smoke` starts the digest (the runner's architecture only) and tests the
   upgrade from the previous release read from the Forgejo releases API;
3. `actions/publish` creates and tags the index, signs it with the key and attaches SBOMs;
4. `actions/release-json` writes, signs and verifies `release.json`, uploads it to a draft
   release and publishes it.

Nothing is tagged or published when the build or the smoke fails.

## Before you start

- Forgejo with Actions enabled and a runner whose jobs can use Docker, including
  privileged containers for QEMU. The template's `runs-on: docker` is a runner label;
  adjust it.
- The composite actions use well-known third-party actions by short name
  (`actions/setup-node`, `docker/setup-qemu-action`, `docker/setup-buildx-action`,
  `docker/login-action`, `docker/build-push-action`, `sigstore/cosign-installer`,
  `anchore/sbom-action`), pinned by commit SHA. The runner resolves short names through
  the instance's default actions URL (`DEFAULT_ACTIONS_URL` in the `[actions]` section of
  the server configuration), which must serve these repositories at those commits, for
  example by pointing it at `https://github.com`. This is part of what is to be verified.
- The app repository with a Dockerfile, a Compose file whose managed services take their
  image from a variable, a complete `.env.example`, a health endpoint that reports the
  version, a smoke override that publishes the health port on `127.0.0.1`, and
  `.cicd-updater/release-policy.yaml`
  ([release-side.md](../release-side.md#the-release-policy-file)).

## Step by step

### 1. Create the key pair

```sh
cosign generate-key-pair      # asks for a password, writes cosign.key and cosign.pub
```

Keep an offline copy of `cosign.key` and its password. `cosign.pub` goes to every host.

### 2. Create the tokens and secrets

Repository settings, Actions, Secrets:

| Secret | Content | Scope |
| --- | --- | --- |
| `REGISTRY_TOKEN` | access token that pushes the images; the template logs in as `${{ github.actor }}`, so use a token of that user or set `username` to the token's user (for example a bot account) | `write:package` |
| `RELEASE_TOKEN` | access token that creates the release and reads earlier releases | `write:repository` |
| `COSIGN_KEY` | the PEM text of `cosign.key` | |
| `COSIGN_PASSWORD` | its password | |

The hosts need their own read-only tokens: `read:package` in `docker.registryAuthFile`
(private images) and `read:repository` in `release.feed.tokenFile` (private repository).

### 3. Copy and adjust the template

Copy `templates/forgejo/release.yml` to `.forgejo/workflows/release.yml` and adjust the
lines marked `ADJUST`:

- `APP_REPOSITORY` (`<forgejo host>/<owner>/<image>`, lowercase) and `REGISTRY`. The
  repository variable is deliberately not named like the Compose image variable
  (`APP_IMAGE`), which receives `repository@digest` in the smoke;
- the runner label, the Compose files, `image-vars`, the health URL;
- throwaway values for variables the Compose file requires but `.env.example` leaves
  empty, in the commented `env` input of the smoke step:

  ```yaml
            env: |
              POSTGRES_PASSWORD=smoke-${{ github.run_id }}
  ```

`api-url: ${{ github.server_url }}` with `release-host: gitea` is correct as it is: the
release tools append `/api/v1` to a server URL (the API base works too).

Reference the actions by commit SHA rather than by tag:

```yaml
        uses: https://github.com/restow-backup/cicd-updater/actions/build@<commit SHA> # v1.0.0
```

### 4. The upgrade test

The smoke step reads earlier releases with `feed-type: gitea`, `feed-url:
${{ github.server_url }}/${{ github.repository }}` and `token: ${{ secrets.RELEASE_TOKEN }}`.

- For the first release there is nothing to upgrade from; the upgrade test is skipped with
  a note.
- The release tools connect only to public addresses. For a Forgejo instance on a private
  network, uncomment `feed-allow-private-host` and set it to the exact host name, for
  example `git.example.com` ([feeds.md](../feeds.md)).

### 5. Release

```sh
git tag -a v1.0.0 -m "v1.0.0"
git push origin v1.0.0
```

### 6. Configure the hosts

```yaml
# updater.yaml
release:
  feed:
    type: gitea                          # Forgejo and Gitea
    url: https://git.example.com/acme/notes
    tokenFile: /etc/cicd-updater/feed-token     # private repository
    allowPrivateNetwork: true            # only if git.example.com has a private address

docker:
  registryAuthFile: /etc/cicd-updater/registry-auth.json   # private images

trust:
  mode: key
  key:
    publicKeyFiles: [/etc/cicd-updater/cosign.pub]
```

`allowPrivateNetwork: true` allows exactly the host of `release.feed.url` to resolve to a
private or loopback address; redirects and assets on other private hosts stay refused.

## The Forgejo container registry

Whether the Forgejo (and Gitea) built-in registry stores and serves the signatures cosign 3
writes (OCI 1.1 referrers, or the `sha256-<digest>` fallback tag) is unknown: neither
project documents it. It is to be verified in the end-to-end run, together with the token
scopes a pull needs ([registries.md](../registries.md)). If it does not work, the options
are to push the signed images to another registry, or to use `none` mode with its risks.

## Repository protections

In `key` mode the private key and the secrets that hold it are the trust anchor: whoever
can run a workflow with access to `COSIGN_KEY` can publish a release every host accepts.

- **Protected tags** for `v*` (repository settings, Tags): allow only maintainers to
  create them.
- **Branch protection** on the default branch: pull requests with approval, no force push.
- **Secrets scoped to the repository**, not to the organization, and only the release
  workflow uses them. Review every change to `.forgejo/workflows/`.
- **Runners**: only trusted runners may pick up the release job; registering a runner for
  the repository is a privileged act. Use a dedicated label.
- **Release tags from the default branch only**: add a step before the build that checks
  that the tag's commit is on the default branch, as in
  [ci/github.md](github.md#repository-protections).
- **Never move or reuse a tag.** The upload refuses a release that is already published.

## Rotating the key

1. `cosign generate-key-pair` for the new pair.
2. Add the new `cosign.pub` to `trust.key.publicKeyFiles` on every host (up to 5 keys) and
   recreate the sidecar.
3. Replace `COSIGN_KEY` and `COSIGN_PASSWORD` with the new ones.
4. Remove the old public key from the hosts once no release you still want to install
   depends on it.

If the key leaked, remove the old public key at once: releases signed with it are accepted
until then.

## Verify a release by hand

```sh
cosign verify --key cosign.pub --insecure-ignore-tlog=true git.example.com/acme/notes:1.4.0
cosign verify-blob --key cosign.pub --insecure-ignore-tlog=true \
  --bundle release.json.sigstore.json release.json
```

(leave out `--insecure-ignore-tlog=true` if the release side uploads to the transparency
log), and on a host: `docker compose --profile updater exec updater cicd-updater verify 1.4.0`.

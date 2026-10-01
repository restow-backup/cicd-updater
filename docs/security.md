# Security

This page describes the security model of cicd-updater, what it verifies and what it does
not, how it handles secrets, and a hardening checklist for operators. The adversaries and
residual risks are in [threat-model.md](threat-model.md). How to report a vulnerability is
in `SECURITY.md` of the repository.

Status: the mechanisms below are implemented and unit-tested with fakes. Their behaviour
against real Docker, real registries and Sigstore is to be verified in the end-to-end run
([compatibility.md](compatibility.md)).

## The premise: the Docker socket is root on the host

The sidecar replaces the app's containers, so it needs the Docker socket. Whoever controls
a process with the Docker socket controls the host: it can start any container with any
mount. Everything else follows from that.

- **Opt-in.** The sidecar is a Compose service in its own profile (`updater`). It does
  nothing until the operator starts it with `docker compose --profile updater up -d`.
  Updating by hand stays fully supported; the sidecar is a convenience, not a
  requirement.
- **Small surface.** The API can schedule **signed releases from the configured feed** and
  nothing else. No endpoint runs a command, chooses an image, a repository, a hook or a
  file. Hooks (backup, migration probe, migration, health, smoke) come only from
  `updater.yaml`, which only the host operator writes.
- **Internal network only.** The sidecar listens on the internal Compose network
  (`server.listen`, default `0.0.0.0:8090` inside the container). A published host port
  is the blocker `api_exposed` unless `server.allowPublishedPort: true`. The browser never
  talks to the authenticated API; an edge may forward only `/public/v1/status` and the
  maintenance page assets ([maintenance-page.md](maintenance-page.md)).
- **Bearer token.** Everything under `/v1` requires `Authorization: Bearer <token>`,
  compared in constant time. The generated token (64 hex characters) is written to
  `/shared/token` with mode `0640`, owner root, group `auth.tokenGroupId`, and is mounted
  read-only into the app only. It never appears in a response or a log.
- **Pinned and never self-updated.** The operator pins the sidecar image, by digest
  (warning `updater_image_not_digest_pinned` otherwise). A run refuses to start while the
  sidecar's own service would take its image from a key the sidecar rewrites (blocker
  `updater_image_unpinned`), so the container that holds the socket never runs an image the
  sidecar installed. Updating the sidecar is an operator action
  ([upgrading-the-updater.md](upgrading-the-updater.md)).
- **No application credentials.** The sidecar has no `env_file` and no database password
  in its environment. It reads the env file only to edit the writable keys and to register
  credential-looking values for redaction. Built-in backup and probe commands run inside
  the database container with that container's own environment.
- **No shell.** Every Docker operation is an argument vector for the `docker` binary;
  values from outside (image references, service names, file names) are validated against
  strict patterns first.
- **Root inside the container, on purpose.** With the Docker socket, a non-root user in
  the socket's group has the same power, and the sidecar must replace the env file with
  its original owner and mode. Running it as non-root would only pretend to reduce what it
  can do.

### Verification in an isolated container

cosign parses responses from registries and the transparency log. It runs in a
short-lived sibling container of the sidecar's own image (resolved by image ID), not in
the sidecar process:

```
docker run --rm --label io.github.restow-backup.cicd-updater.managed=true \
  --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  --user 65534:65534 --tmpfs /tmp:rw,size=64m --env HOME=/tmp \
  --volume <verify volume>:/verify:ro [--env DOCKER_CONFIG=<per-verification dir>] \
  --entrypoint cosign <own image ID> verify ...
```

No Docker socket, no capabilities, a read-only root file system, an unprivileged user,
and only the verification volume, read-only, which holds the document, the bundle, the
public keys or trusted root, and a per-verification registry credential file. The
container has network access, because cosign must reach the registry and Sigstore.

`trust.verifier.isolate: false` runs cosign as a subprocess of the sidecar instead, for
environments that cannot start sibling containers. That is weaker: cosign then runs as
root next to the Docker socket. With `isolate: true`, a missing own image or verification
volume is the blocker `verifier_unavailable`.

## What is verified and what is not

| Verified (image mode, `keyless` or `key`) | Not verified |
| --- | --- |
| `release.json` was signed by the release identity or key, before any of its fields is used; version, tag, channel, digests, minimum version, manual steps and requirements are taken as signed | that the code in the release is free of bugs or of malicious changes made through the legitimate release workflow |
| the stored document is verified again at the start of the run, with the same SHA-256 as at scheduling (and as the admin saw, with `expect.releaseSha256`) | who wrote the commits; signed Git tags; reviews |
| each image digest carries a signature of the same identity at the same tag (`keyless`) or by one of the keys (`key`) | the base images and dependencies inside the images (SBOM attestations are produced but not evaluated) |
| the pulled image is known locally by exactly the verified digest; its `org.opencontainers.image.version` label, if present, equals the target version | freshness: a feed that withholds new releases (a freeze attack) is not detected |
| the target is strictly newer than the running version and not below `minimumFromVersion`; no manual steps required; `requires.updater`, `requires.env` and the host platform are satisfied | that the app's health endpoint tells the truth |
| after the update, the app reports the target version through the health check | the release list itself (`GET /v1/releases` is unverified metadata, marked `verified: false`) |

In `none` mode the left column shrinks to: digests are mandatory and checked after the
pull, and the refusals apply. Nothing about signatures is checked
([trust-modes.md](trust-modes.md#none)).

## Source mode: unsigned by nature

Source mode builds the images on the host from the tag's source archive. Whoever controls
that repository's tag controls the code that then runs with the app's data. Therefore:

- it is off by default, and on only when `source.allowlist` is non-empty **and** the
  configured feed repository matches an entry. Use `host/owner/repo` entries; a bare host
  allows every repository on it, and `github.com` alone allows all of GitHub. Static and
  file feeds have no repository and cannot use source mode;
- a request can only select `mode: "source"`; the repository always comes from
  `updater.yaml`, so an app or API caller cannot point the build elsewhere;
- the archive is fetched over https with the feed's address rules; the token goes as a
  header to the archive's origin only and is dropped on a redirect to another origin; at
  most 3 redirects; size cap `source.maxArchiveMb`;
- extraction refuses absolute paths, `..` segments, links that point outside the tree,
  hard links and device files, never keeps owners or set-id bits, and stops past a size
  and entry limit; the tree is removed afterwards;
- runs record `mode: "source"` and `verification.signatures: "not_applicable"`, and the
  capabilities carry the warning `source_mode_enabled`;
- a `release.json`, when the release has one, is still honoured for `upgrade` and
  `requires`, unsigned.

Builds on the production host also compete with the app for CPU and memory. Prefer image
mode with builds in CI.

## Secrets

| Secret | Where | Rules |
| --- | --- | --- |
| Shared token | generated in `/shared/token`, or an operator file (`auth.tokenFile`) | `0640`, owner root, group `auth.tokenGroupId`; mounted read-only into the app only; never logged or returned |
| Feed and source tokens | `release.feed.tokenFile`, `source.tokenFile` | read when needed; sent as a header to the feed's own origin only, dropped on a redirect to another origin; registered with the redactor |
| Registry credentials | `docker.registryAuthFile` | `auths` only (`credsStore`/`credHelpers` refused); Docker commands use the file in place through `DOCKER_CONFIG`; the verifier gets a per-verification file with the one entry it needs, mode `0400`, deleted afterwards ([registries.md](registries.md)) |
| Env file values | the project's env file | read for editing; values of keys matching `env.redactKeyPattern` registered with the redactor; never copied, except the keys a `command` backup lists in `envKeys`, which reach the backup container through a temporary env file with mode `0600` |
| Backup encryption | `age` public recipients only | the private key is never on the host |
| Signing key (release side) | CI secret or KMS | never in the repository; the password is a separate secret; the actions write a PEM key with `umask 077` and remove it in a step that always runs |

Rules for every secret:

- **Never in a command-line argument** (visible in process lists).
- **Never in a child's environment.** The sidecar's child processes (`docker`, `cosign`,
  `age`, `tar`) get an environment filtered down to `PATH`, `HOME`, `DOCKER_HOST`,
  `DOCKER_CONTEXT`, `DOCKER_CERT_PATH`, `DOCKER_TLS_VERIFY`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `TZ` and fixed, non-secret values (such as `DOCKER_CONFIG`, a path).
  The one exception is the MySQL password, which is set inside the database container's
  own shell from that container's own environment.
- **Files with secrets are `0600`** (or `0400` for the verifier copy): `status.json`, the
  state lock, backups and their metadata, the temporary env file of a `command` backup, the release
  smoke env file on the CI runner. The state directory is `0700`. The project's env file
  keeps its own owner and mode when the sidecar rewrites it.
- **Redaction.** Every log line, failure detail, `status.json` entry and problem detail
  passes the redactor. It removes registered values by exact match (the shared token, feed
  and source tokens, credential-looking env values) and patterns that carry credentials
  (`Authorization` and `PRIVATE-TOKEN` headers, `Bearer` and `token` values,
  `scheme://user:pass@host`, `password=...` and similar pairs, well-known token prefixes
  of GitHub, GitLab and npm, `age` secret keys), plus up to 32 operator patterns in
  `logging.redactPatterns`. Patterns can miss token formats they do not know; add yours.

## Hardening checklist

For operators. [threat-model.md](threat-model.md) explains why each point matters.

**The sidecar**

- [ ] Verify the sidecar image with cosign before you use it, and pin it by digest
      ([upgrading-the-updater.md](upgrading-the-updater.md)):

      ```sh
      cosign verify ghcr.io/restow-backup/cicd-updater:1.0.0 \
        --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
        --certificate-oidc-issuer https://token.actions.githubusercontent.com \
        --certificate-github-workflow-repository restow-backup/cicd-updater \
        --certificate-github-workflow-ref refs/tags/v1.0.0 \
        --certificate-github-workflow-trigger push
      ```

- [ ] Never take the sidecar's image from a variable the sidecar rewrites.
- [ ] No `ports:` on the sidecar; leave `server.allowPublishedPort` at `false`. Put it only
      on the internal network.
- [ ] Set `security_opt: ["no-new-privileges:true"]` and `stop_grace_period: 30s`, and the
      label `io.github.restow-backup.cicd-updater.role: sidecar` (it enables the
      `multiple_updaters` check).
- [ ] Keep `trust.verifier.isolate: true` and mount the `/verify` volume.
- [ ] Run `docker compose --profile updater exec updater cicd-updater doctor` after every
      change.

**Trust**

- [ ] Use `keyless` or `key` mode. Use `none` only for test installations.
- [ ] In `key` mode, keep the private key in a CI secret or KMS, rotate with several public
      keys, and remove a leaked key at once ([trust-modes.md](trust-modes.md)).
- [ ] Protect the release pipeline: protected release tags, protected default branch,
      pinned actions, signing secrets and OIDC tokens only in the job that signs
      ([ci/github.md](ci/github.md), [ci/gitlab.md](ci/gitlab.md),
      [ci/forgejo.md](ci/forgejo.md)).
- [ ] When the app shows release details to an admin, pass `expect.releaseSha256` when
      scheduling.

**Files and tokens**

- [ ] `updater.yaml`, the Compose files, public keys, the feed token file and the registry
      auth file are owned by root and not writable by the app. The app has no write access
      to the project directory.
- [ ] Mount the shared token volume read-only, and only into the service that calls the
      sidecar; set `auth.tokenGroupId` to the app's group when the app runs as non-root.
- [ ] Feed and registry tokens are read-only. Registry credentials are an `auths`-only
      file.
- [ ] Add your own token formats to `logging.redactPatterns`.

**Data**

- [ ] Configure a backup, and encrypt it with `hooks.backup.encryption.ageRecipients`; keep
      the private key off the host ([backups-and-recovery.md](backups-and-recovery.md)).
- [ ] Keep retention (`retention.keep`, `retention.maxAgeDays`) as small as your recovery
      needs allow; backups are plaintext copies of all data unless encrypted.

**Exposure**

- [ ] Leave source mode off (empty `source.allowlist`). If you need it, list
      `host/owner/repo`, never a bare host.
- [ ] Forward only `/public/v1/status` and the maintenance page assets through the edge;
      leave `publicStatus.showVersions` at `false`.
- [ ] Leave `release.feed.allowPrivateNetwork` at `false` unless the feed host is on your
      private network.
- [ ] Ingest the journal into the app's audit log and require a recent strong sign-in for
      scheduling ([app-integration.md](app-integration.md)).

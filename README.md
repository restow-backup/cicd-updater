# cicd-updater

Signed, self-service updates for apps run with Docker Compose: from a button in the app
or a command on the host.

cicd-updater has three parts. Composite GitHub/Forgejo Actions (and a CLI for any other CI)
build your images, smoke-test them, sign them and publish a signed `release.json`. A sidecar
container next to your app reads that document, verifies the signatures, backs up the
database, installs exactly the published digests and checks that the new version is healthy.
Your app (any language) asks the sidecar over a small HTTP API, or the operator uses the CLI.

It was extracted from the opt-in updater of [Restow](https://github.com/restow-backup/restow)
and made generic.

## Why

Manual updates are error-prone, and ad-hoc update scripts guess: they pull a moving tag,
skip the backup when they are in a hurry, and "roll back" by starting an old image against
a database the new version already migrated. cicd-updater:

- **verifies what it installs**: images and `release.json` are signed in CI (Sigstore keyless
  or a cosign key) and checked on the host against an exact identity. It pulls by digest and
  writes `repo:tag@sha256:...`, so a moved tag can never change what runs.
- **backs up first** (PostgreSQL, MySQL/MariaDB, Docker volumes, a custom command), verifies
  the backup and can encrypt it with age.
- **rolls back only when it is certain**: when the app has no persistent schema, or when a
  migration probe proves the schema is unchanged. Otherwise it stops, keeps the backup and
  tells you exactly what to do (`needs_attention` with recovery commands).
- **publishes only what starts**: the release actions push by digest, start the release from
  your production Compose file and `.env.example`, optionally upgrade from the previous
  release through the sidecar itself, and only then tag, sign and publish.

## How it works

```
 RELEASE SIDE (CI)                       REGISTRY
 build -> smoke -> publish ----------->  multi-arch images and signatures, by digest
       -> release-json                        ^
       |                                      | verify signature, pull by digest
       | release.json + signature bundle      |
       v                                      |
 RELEASE HOST  <---- feed ----  HOST: one Compose project, internal network
 GitHub, Forgejo, GitLab        +-------------+  bearer token   +--------------------+
 releases, or a static index    | app backend | --------------> | updater sidecar    |
                                | (SDK, HTTP) | <-------------- | docker.sock, .env  |
                                +-------------+  health with    | status.json,       |
                                +-------------+  version        | backups            |
                                | edge/proxy  | <-------------- +--------------------+
                                +-------------+  public status (read-only)
                                      ^
                                      | users, maintenance page
```

A run goes through fixed steps: verify, fetch, backup, stop, apply, start, health, smoke.
The point of no return is the start of the stop step: before it, a run can be cancelled and
nothing has changed. After it, a failure ends in `rolled_back` (only when that is provably
safe) or in `needs_attention`. The steps, every failure code and the exact rollback rule
are in [docs/state-machine.md](docs/state-machine.md).

## Quick start

The full walk-through is [docs/getting-started.md](docs/getting-started.md); the
[examples](examples/) are complete projects.

1. **Release workflow.** Copy [templates/github/release.yml](templates/github/release.yml)
   (or the [Forgejo](templates/forgejo/release.yml) or [GitLab](templates/gitlab/.gitlab-ci.yml)
   template) into your repository, adjust the image names, and push a tag `v1.0.0`.
2. **Sidecar.** Add the `updater` service (Compose profile `updater`) and an `updater.yaml`
   to your project, as in [examples/node-postgres](examples/node-postgres/):

   ```yaml
   services:
     updater:
       profiles: ["updater"]
       image: ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>
       restart: unless-stopped
       labels:
         io.github.restow-backup.cicd-updater.role: sidecar
       environment:
         CICD_UPDATER_CONFIG: ${PROJECT_DIR}/updater.yaml
         CICD_UPDATER_COMPOSE__PROJECT_DIR: ${PROJECT_DIR}
       volumes:
         - /var/run/docker.sock:/var/run/docker.sock
         - ${PROJECT_DIR}:${PROJECT_DIR}
         - updater-state:/state
         - updater-shared:/shared
         - updater-verify:/verify
       networks: [internal]
       security_opt: ["no-new-privileges:true"]
   ```

3. **Verify the sidecar image** before you run it, and pin it by digest:

   ```sh
   cosign verify ghcr.io/restow-backup/cicd-updater:1.0.0 \
     --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com \
     --certificate-github-workflow-repository restow-backup/cicd-updater \
     --certificate-github-workflow-ref refs/tags/v1.0.0 \
     --certificate-github-workflow-trigger push
   ```

4. **Start and check:**

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   ```

5. **Update** after your next release:

   ```sh
   docker compose exec updater cicd-updater releases
   docker compose exec updater cicd-updater schedule 1.1.0 --in 15m
   docker compose exec updater cicd-updater status
   ```

Without the `updater` profile nothing changes: your app runs as before and can always be
updated by hand.

## Security note

**The sidecar holds the Docker socket, which is root on the host.** Treat it like root:

- It is opt-in (a Compose profile), listens only on an internal network and must not
  publish a port; a published port is a blocker and no update runs.
- Its own image is pinned by digest and changed only by the operator. It never updates
  itself and refuses to run while its own service would follow an env key it rewrites.
- It installs only releases whose `release.json` and images carry valid signatures of the
  exact identity you configured (`trust.mode: keyless` or `key`). Mode `none` exists for
  private setups; it must be acknowledged explicitly and is shown on every run.
- Hooks (backup, probe, health, smoke) come only from `updater.yaml`, never from an API request.

Read [docs/security.md](docs/security.md), [docs/trust-modes.md](docs/trust-modes.md) and
[docs/threat-model.md](docs/threat-model.md) before you deploy it.

## Integration levels

| Level | App changes | How updates are started |
| --- | --- | --- |
| 1. No app changes | none (a health endpoint helps) | `docker compose exec updater cicd-updater ...` |
| 2. Any language | the backend calls the HTTP API ([OpenAPI](openapi/updater-api.v1.yaml)) | the app's own admin UI |
| 3. TypeScript | the app uses the SDK `@restow-backup/cicd-updater` and optionally its React components | the app's own admin UI, with less code |

## Compatibility

| | 1.0 |
| --- | --- |
| Hosts | Linux, Docker Engine 24 or newer (API 1.43), amd64 and arm64. The sidecar brings its own Compose and buildx. Rootless Docker and the containerd image store: to verify |
| Apps | anything that runs with Docker Compose and takes its images from variables in the env file |
| CI and signing | GitHub Actions (keyless, key, none), Forgejo/Gitea Actions (key, none), GitLab CI and other CI through the `release` CLI |
| Registries | GHCR, Docker Hub, GitLab, Harbor, distribution, Forgejo/Gitea and others, see [docs/registries.md](docs/registries.md) |
| Release feeds | GitHub, Forgejo/Gitea and GitLab releases, a static index, a local directory |
| SDK | Node.js 22 and newer for the server parts; protocol, semver and messages run anywhere; React 18 and newer |

Every entry carries a status of **Tested**, **Expected** or **To verify** in
[docs/compatibility.md](docs/compatibility.md). 1.0 is implemented and covered by unit tests
with fakes; the results of the end-to-end tests against real Docker, registries and Sigstore
are recorded there.

## Documentation

- [Documentation index](docs/index.md): getting started, concepts, configuration reference,
  hooks, state machine, troubleshooting, backups and recovery
- Release side: [actions and templates](docs/release-side.md), [release.json](docs/release-json.md),
  [feeds](docs/feeds.md), [trust modes](docs/trust-modes.md), [registries](docs/registries.md)
- App side: [HTTP API](docs/http-api.md), [SDK](docs/sdk.md), [React components](docs/react.md),
  [app integration](docs/app-integration.md)
- [CLI](docs/cli.md), [maintenance page](docs/maintenance-page.md),
  [upgrading the updater](docs/upgrading-the-updater.md), [versioning](docs/versioning.md),
  [FAQ](docs/faq.md), [design specification](docs/design.md)
- [Examples](examples/), [SECURITY.md](SECURITY.md), [CONTRIBUTING.md](CONTRIBUTING.md),
  [CHANGELOG.md](CHANGELOG.md)

## License

Apache License 2.0, see [LICENSE](LICENSE) and [NOTICE](NOTICE).
Copyright IT Systeme Flores UG (haftungsbeschränkt).
Third-party components: [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES).

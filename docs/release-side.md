# Release side

The release side is the CI of the app. It builds the app's images, tests that they start,
signs them and publishes a machine-readable `release.json` next to them. The sidecar on
the host installs only what that document and the signatures allow
([release-json.md](release-json.md), [trust-modes.md](trust-modes.md)).

cicd-updater ships the release side in two forms with the same code:

| Form | Where | Use it on |
| --- | --- | --- |
| Composite actions under `actions/` (`build`, `smoke`, `publish`, `release-json`, and `release` for everything in one job) | this repository | GitHub Actions, Forgejo and Gitea Actions |
| The `release` CLI (`cicd-updater release <command>`) | the sidecar image `ghcr.io/restow-backup/cicd-updater` | GitLab CI and any other CI |

Copyable workflows are under `templates/` (`github/release.yml`, `forgejo/release.yml`,
`gitlab/.gitlab-ci.yml`). The step-by-step guides are [ci/github.md](ci/github.md),
[ci/gitlab.md](ci/gitlab.md) and [ci/forgejo.md](ci/forgejo.md).

Status: the actions and the CLI are implemented and unit-tested with fakes. They have not
yet run against real registries, Sigstore or CI runners; that is recorded in
[compatibility.md](compatibility.md) after the end-to-end run.

## The pipeline

```
 ┌────────────┐   ┌──────────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
 │ verify tag │──▶│ build per    │──▶│ smoke        │──▶│ publish        │──▶│ release-json │
 │ (version   │   │ arch, push   │   │ (digests,    │   │ index, tag,    │   │ create, sign │
 │ from tag)  │   │ by digest,   │   │ .env.example,│   │ sign, SBOM     │   │ verify, up-  │
 └────────────┘   │ untagged     │   │ upgrade-from)│   │                │   │ load, publish│
                  └──────────────┘   └──────────────┘   └────────────────┘   └──────────────┘
   nothing is tagged in the registry and no release is public before the smoke passed
```

1. **Verify the tag.** Every action derives the plain version from the pushed Git tag
   through `tag-pattern` (default `v{version}`). A tag that does not render from a plain
   SemVer version (`MAJOR.MINOR.PATCH[-pre]`, no build metadata) fails the job. The
   project's own release workflow also checks that the tag is annotated and on `main`, that
   `CHANGELOG.md` has a dated section for the version and that every `package.json` carries
   it (`release check-tag`); adopters can copy that job from `.github/workflows/release.yml`.
2. **Build per architecture, push by digest.** Each image is built with
   `docker buildx build` for `linux/amd64` and/or `linux/arm64` and pushed **by digest,
   without a tag**. Provenance and SBOM attestations are switched off at this point, so a
   platform digest is a plain image manifest.
3. **Smoke.** The pushed digests are started from the app's own Compose files with an env
   file derived from `.env.example`, health and version are checked, and optionally the
   upgrade from the previous release is tested (through the sidecar itself, if configured).
   See [The smoke test](#the-smoke-test).
4. **Publish.** One multi-arch index per image is created from the platform digests and
   tagged with the plain version. Each index digest is signed (`keyless`, `key` or `none`)
   and an SPDX SBOM is generated per platform image and attached as an attestation.
5. **release-json.** `release.json` is generated from the index digests the publish step
   reported (never typed by hand) and the release policy file, validated, signed into
   `release.json.sigstore.json`, verified once the way the sidecar will verify it, uploaded
   to a draft release, and the release is published last.

The rule behind the order: **what does not start is not published.** A run that fails
before the publish step leaves only untagged digests in the registry. A run that fails
inside `publish` can leave a tagged index that is not signed yet; no release lists it. A
run that fails inside `release-json` can leave a draft release on GitHub, Forgejo or
Gitea, or uploaded files without a release on GitLab; nothing is public. Re-running the
same tag continues from there (see [Immutability](#immutability)).

### Labels on every image

The build sets these OCI labels on every image:

| Label | Value |
| --- | --- |
| `org.opencontainers.image.version` | the plain version, without `v` |
| `org.opencontainers.image.revision` | the commit (`github.sha`, or `GITHUB_SHA` / `CI_COMMIT_SHA` in the CLI) |
| `org.opencontainers.image.source` | the repository URL (`$GITHUB_SERVER_URL/$GITHUB_REPOSITORY`, or `CI_PROJECT_URL`) |
| `org.opencontainers.image.created` | the commit time (`git log -1 --format=%cI`); without `git`, `CI_COMMIT_TIMESTAMP` (GitLab), else the current time |

The sidecar compares `org.opencontainers.image.version` with the target version after the
pull (`fetch.version_label_mismatch`) and uses it to detect the running version.

### Data between the steps

| Produced by | Shape | Consumed by |
| --- | --- | --- |
| `build` action, output `digest` | one digest per image and build | the workflow collects them per image |
| collected by the workflow | `{"<key>": {"repository": "...", "digests": ["sha256:...", ...]}}` | `publish` (`images`), CLI `index` |
| collected by the workflow | `{"<key>": {"repository": "...", "digest": "sha256:..."}}` | `smoke` (`images`) |
| `publish` action, output `images` | `{"<key>": {"repository", "tag", "digest", "platforms"}}` with the index digests | `release-json` (`images`), CLI `sign-images`, `sbom`, `json create` |

`<key>` is the image key of `release.json` (`^[a-z][a-z0-9-]{0,31}$`), the name that
`updater.yaml` maps services to (`services[].image`).

## The actions

All actions are composite actions. Every third-party action they use is pinned to a full
commit SHA. They set up Node.js 22 when the runner has no Node.js 22 or newer, and run the
release tools bundled as `actions/lib/release-tools.mjs` (the same code as the CLI).

The templates and examples reference the actions by tag, for example
`restow-backup/cicd-updater/actions/build@v1.0.0`. Pin the commit SHA of the release you
reviewed instead and keep the tag as a comment; Dependabot or Renovate update the pin.

Signing mode and release host: when the input `signing` (or `release-host`) is empty, the
action uses `keyless` (or `github`) on `https://github.com` and fails everywhere else. On
Forgejo, Gitea and GitHub Enterprise Server set both inputs explicitly.

### `build`

Builds one image and pushes it by digest, untagged, with the labels above.

| Input | Default | Meaning |
| --- | --- | --- |
| `image` | required | Repository to push to, lowercase, without tag or digest (for example `ghcr.io/acme/notes`). Validated. |
| `context` | `.` | Build context. |
| `file` | empty | Dockerfile path; empty means `<context>/Dockerfile`. |
| `target` | empty | Dockerfile target stage. |
| `platforms` | `linux/amd64,linux/arm64` | Comma-separated; only `linux/amd64` and `linux/arm64` are accepted. QEMU is set up when a platform differs from the runner's. |
| `build-args` | empty | Build arguments, one `KEY=VALUE` per line. |
| `version-build-arg` | `VERSION` | Name of a build argument that receives the plain version; empty passes none. |
| `version` | empty | Plain version; empty means derived from the pushed tag through `tag-pattern`. |
| `tag-pattern` | `v{version}` | How a version maps to a Git tag; must match `release.tagPattern` of the sidecar. |
| `registry` | empty | Registry to log in to; empty means the host of `image` (`docker.io` when the first path segment is not a host). |
| `username` | empty | Registry user; empty means the workflow's actor. |
| `password` | empty | Registry password or token; empty skips the login (log in before the action). |
| `cache` | `gha` | `gha` (GitHub Actions cache, scoped per image and platform list) or `none`. |

| Output | Meaning |
| --- | --- |
| `digest` | The pushed digest: an image manifest for one platform, an index for several. |
| `metadata` | The build metadata JSON of `docker/build-push-action`. |
| `version` | The plain version the image was labelled with. |

Build one image per job and platform on native runners (as the GitHub template does), or
all platforms in one job with QEMU (as the Forgejo template does). In the second case the
output `digest` is an index; `publish` accepts both.

### `smoke`

Starts the release from its Compose files with the pushed digests and tears it down again.
[The smoke test](#the-smoke-test) describes each step.

| Input | Default | Meaning |
| --- | --- | --- |
| `compose-files` | required | Comma- or newline-separated Compose files, relative to `working-directory`. |
| `env-example` | `.env.example` | The documented env file. Every `${VAR}` the Compose files use must appear in it. |
| `images` | required | JSON `{"<key>": {"repository": "...", "digest": "sha256:..."}}` of the images to test. |
| `image-vars` | required | JSON `{"<key>": "<ENV_VAR>"}`: the env key each image is set through. |
| `health-url` | required | URL the runner polls until the app is healthy. Publish the port in a smoke Compose override. |
| `health-version-path` | empty | Path of the version in the health JSON (`$.version`); empty skips the version check. The runner sends no token: set it only when the health endpoint shows the version to anyone. An app that reveals the version only to the sidecar's token (recommended) leaves it empty; the sidecar checks the version on the host. |
| `expect-version` | empty | Version the health answer must report; empty means the version of the pushed tag (when the run is for a tag). |
| `tag-pattern` | `v{version}` | Used to derive `expect-version` from the tag. |
| `upgrade-from` | `none` | `none`, `previous` (the newest earlier release) or a version. |
| `feed-type` | empty | Feed of earlier releases for `upgrade-from`: `github`, `gitea`, `gitlab` or `static`; empty means this GitHub repository. |
| `feed-url` | empty | Feed URL for `upgrade-from`; empty means this GitHub repository. |
| `token` | `${{ github.token }}` | Token for reading earlier releases; sent only to the feed origin. |
| `feed-allow-private-host` | empty | A feed host that may resolve to a private or loopback address for `upgrade-from` (an internal Forgejo); empty means public addresses only. |
| `env` | empty | Throwaway values for the smoke, one `KEY=VALUE` per line (for example a scratch database password). They override the lines of `.env.example`. |
| `updater-config` | empty | `updater.yaml` of the project; when set, the upgrade runs through the sidecar. |
| `updater-image` | empty | The sidecar image, pinned by digest; required with `updater-config`. |
| `timeout-seconds` | `600` | Time limit for each wait (start, health, the upgrade through the sidecar). |
| `working-directory` | `.` | Directory with the Compose files. |
| `registry` | empty | Registry to log in to for pulling; empty skips the login. |
| `username` | empty | Registry user; empty means the workflow's actor. |
| `password` | empty | Registry password or token. |

| Output | Meaning |
| --- | --- |
| `report` | Path of the Markdown report. The report is also appended to the job summary, on failure too. |

### `publish`

After the smoke passed: creates and tags one index per image, signs each index and attaches
SBOMs.

| Input | Default | Meaning |
| --- | --- | --- |
| `images` | required | JSON `{"<key>": {"repository": "...", "digests": ["sha256:...", ...]}}`: the platform digests of the build (1 to 8 per image; an index digest is accepted too). |
| `version` | empty | Plain version, used as the image tag; empty means derived from the pushed tag through `tag-pattern`. |
| `tag-pattern` | `v{version}` | How a version maps to a Git tag. |
| `extra-tags` | empty | Comma-separated moving tags such as `1,latest`. Never checked for immutability. |
| `signing` | empty | `keyless`, `key` or `none`. Empty means `keyless` on github.com and is an error elsewhere. |
| `cosign-key` | empty | `key` mode: the PEM private key (from a secret) or a KMS URI cosign supports. |
| `cosign-password` | empty | `key` mode: the password of the private key. |
| `transparency-log` | `false` | `key` mode: also upload the signatures to the public transparency log. |
| `sbom` | `true` | Generate an SPDX SBOM per platform image with syft and attach it as an attestation. |
| `refuse-existing` | `true` | Refuse when the version tag already exists with other content. |
| `cosign-version` | `v3.1.3` | cosign release to install; keep it on the cosign minor version of the sidecar image. |
| `registry` | empty | Registry to log in to; empty skips the login. |
| `username` | empty | Registry user; empty means the workflow's actor. |
| `password` | empty | Registry password or token. |

| Output | Meaning |
| --- | --- |
| `images` | JSON `{"<key>": {"repository", "tag", "digest", "platforms"}}` with the index digests; the input of `release-json`. |
| `signing` | The signing mode used. |
| `sbom-files` | Newline-separated paths of the SBOM files (attach them with `release-json` `extra-files` if you want them as release assets). |

What it runs:

- `release index`: `docker buildx imagetools create` per image with the tag `<version>` (and
  the extra tags), then reads back the index digest and the platforms it lists.
- `release sign-images`: `cosign sign --yes [--key <key> --use-signing-config=false --tlog-upload=false] <repository>@<index digest>`.
  Only the index digest is signed; that is the digest `release.json` names and the sidecar
  verifies.
- `release sbom`: `syft scan <repository>@<platform digest> --output spdx-json=<file>` per
  platform image, then, unless `signing` is `none`,
  `cosign attest --yes [--key ...] --type spdxjson --predicate <file> <repository>@<platform digest>`.
  The sidecar does not evaluate SBOMs.

In `key` mode a PEM key is written to a file under `$RUNNER_TEMP` with `umask 077` and
removed in a step that always runs. The password reaches cosign only as `COSIGN_PASSWORD`
in its environment, never in its arguments.

### `release-json`

Writes, validates, signs, verifies and uploads `release.json`, then publishes the release.

| Input | Default | Meaning |
| --- | --- | --- |
| `images` | required | The `images` output of `publish`. |
| `version` | empty | Plain version; empty means derived from the tag through `tag-pattern`. When both are given they must agree. |
| `tag` | empty | Git tag of the release; empty means rendered from `version`, or the pushed tag. |
| `tag-pattern` | `v{version}` | How a version maps to a Git tag. |
| `policy-file` | `.cicd-updater/release-policy.yaml` | The [release policy](#the-release-policy-file). A missing file gives the defaults (with a notice). |
| `notes-url` | empty | Release notes URL (https); empty means the release page on github.com, none elsewhere. |
| `signing` | empty | `keyless`, `key` or `none`. Empty means `keyless` on github.com and is an error elsewhere. |
| `cosign-key` | empty | `key` mode: the PEM private key or a KMS URI. |
| `cosign-password` | empty | `key` mode: the password of the private key. |
| `transparency-log` | `false` | `key` mode: also upload the signature to the public transparency log. |
| `cosign-version` | `v3.1.3` | cosign release to install. |
| `release-host` | empty | `github`, `gitea` (also Forgejo), `gitlab` or `none` (upload nothing). Empty means `github` on github.com and is an error elsewhere. |
| `api-url` | empty | Server URL or API base of the release host (see the note below). Empty means GitHub's API. |
| `repository` | empty | `owner/repo` (GitLab: `group/project`) on the release host; empty means this repository. |
| `token` | `${{ github.token }}` | Token with write access to the releases of the repository. |
| `publish-release` | `true` | Publish the release after the upload; `false` leaves a draft. |
| `release-name` | empty | Title of the release; empty means the tag. |
| `notes-file` | empty | Markdown file with the release text. |
| `extra-files` | empty | More files to attach, one path per line (SBOMs, archives). |
| `checksums` | `false` | Also write `SHA256SUMS` over every asset and sign it like `release.json` (`SHA256SUMS.sigstore.json`). |
| `workflow` | empty | `keyless` self-check: the workflow file that signs (`.github/workflows/release.yml`); empty means the running workflow. |

| Output | Meaning |
| --- | --- |
| `path` | Path of `release.json`. |
| `sha256` | SHA-256 of `release.json`, the value an admin compares before scheduling (`expect.releaseSha256`). |
| `url` | URL of the release. |

`api-url` accepts the server URL or the API base. For Forgejo, Gitea and GitLab the
release tools append `/api/v1` or `/api/v4` when it is missing:

| Release host | `api-url` |
| --- | --- |
| `github` | empty (uses `GITHUB_API_URL` or `https://api.github.com`) |
| `gitea` | `https://<host>[/<prefix>]`, for example `${{ github.server_url }}`, or the API base `https://<host>[/<prefix>]/api/v1` |
| `gitlab` | `https://<host>` (`CI_SERVER_URL`), or the API base `https://<host>/api/v4` (`CI_API_V4_URL`) |

What it runs, in order:

1. Mode, host, tag and version checks (as described above).
2. `release json create` and `release json validate --tag <tag>` (schema and the additional
   rules of [release-json.md](release-json.md)).
3. In `keyless` and `key` mode: `release json sign` (`cosign sign-blob --yes [--key ...]
   --bundle release.json.sigstore.json release.json`), then one verification the way the
   sidecar verifies:
   - `key`: the public key is derived with `cosign public-key --key <key>` and the bundle is
     verified against it;
   - `keyless` on github.com: the bundle is verified for the identity of the running
     workflow at the tag, including the GitHub workflow repository, ref and trigger checks
     ([trust-modes.md](trust-modes.md));
   - `keyless` elsewhere: skipped with a notice; verify with the sidecar's identity before
     you announce the release.
4. With `checksums: true`: `SHA256SUMS` over all assets, signed.
5. `release upload`: a draft release is created (or the existing draft reused), the files
   are uploaded, and the release is published last (unless `publish-release: false`).
   GitHub and Forgejo/Gitea pre-releases are marked as such from the version.

### `release`

The whole release in one job for simple projects: builds every image for all platforms
with QEMU, pushes by digest, smoke-tests, then tags and signs the indexes, attaches SBOMs,
writes and signs `release.json` and publishes the release.

| Input | Default | Meaning |
| --- | --- | --- |
| `images` | required | JSON `{"<key>": {"repository": "...", "context": ".", "file": null, "target": null, "buildArgs": {}}}`. `file` is relative to the repository root (null: `<context>/Dockerfile`); `{version}` in a build argument value is replaced by the version. |
| `platforms` | `linux/amd64,linux/arm64` | Platforms of every image. |
| `version`, `tag-pattern` | empty, `v{version}` | As in `build`. |
| `registry`, `username`, `password` | empty | Registry login (skipped when `registry` or `password` is empty). |
| `smoke` | `true` | Run the smoke test; needs `compose-files`, `image-vars` and `health-url`. |
| `compose-files`, `env-example`, `image-vars`, `health-url`, `health-version-path` | empty, `.env.example`, empty, empty, empty | As in `smoke`. |
| `upgrade-from` | `none` | As in `smoke`. |
| `feed-type`, `feed-url` | empty | As in `smoke`: the feed of earlier releases; empty means this GitHub repository. |
| `smoke-env` | empty | As `env` in `smoke`: throwaway values, one `KEY=VALUE` per line. |
| `updater-config`, `updater-image` | empty | As in `smoke`. |
| `timeout-seconds` | `600` | As in `smoke`. |
| `extra-tags`, `signing`, `cosign-key`, `cosign-password`, `transparency-log`, `cosign-version`, `sbom`, `refuse-existing` | as in `publish` | |
| `policy-file`, `notes-url`, `release-host`, `api-url`, `token`, `publish-release` | as in `release-json` | |

| Output | Meaning |
| --- | --- |
| `images` | The published images JSON (index digests). |
| `sha256` | SHA-256 of `release.json`. |

The `release` action uploads `release.json`, its bundle, the smoke report and the SBOM files
to the release of `$GITHUB_REPOSITORY`. With QEMU the smoke test runs only the runner's own
architecture; the other architecture is built but not started.

## The release policy file

`.cicd-updater/release-policy.yaml` is committed in the app repository. It is part of the
tagged source, so changes to upgrade constraints are reviewed with the code they belong to.

```yaml
# Upgrade constraints of the next release.
minimumFromVersion: 1.2.0     # or null: any running version may update
requiresUpdater: ">=1.0.0"    # or null
requiresEnv: [NOTES_SEARCH_URL]
manualSteps:
  required: false
  summary: null
  url: null
```

| Key | Default | Validation | Becomes in `release.json` |
| --- | --- | --- | --- |
| `minimumFromVersion` | `null` | plain SemVer; must be lower than the release version | `upgrade.minimumFromVersion` |
| `requiresUpdater` | `">=1.0.0"` | `X.Y.Z`, `>=X.Y.Z` or `^X.Y.Z`, or `null` | `requires.updater` (omitted when null) |
| `requiresEnv` | `[]` | up to 64 names `^[A-Za-z_][A-Za-z0-9_]{0,127}$` | `requires.env` (omitted when empty) |
| `manualSteps.required` | `false` | boolean | `upgrade.manualSteps.required` |
| `manualSteps.summary` | `null` | plain text, at most 2000 characters | `upgrade.manualSteps.summary` |
| `manualSteps.url` | `null` | `https://` URL, at most 2000 characters | `upgrade.manualSteps.url` |

The file is YAML 1.2 without aliases. Unknown keys are an error. A missing file means the
defaults; a file named explicitly with `--policy-file` that cannot be read is an error.

What the sidecar does with these fields: [release-json.md](release-json.md). In short, it
refuses a release when the running version is below `minimumFromVersion`, when
`manualSteps.required` is true, when its own version does not satisfy `requiresUpdater`, or
when a key of `requiresEnv` is missing or empty in the env file.

## The smoke test

The smoke test answers one question before anything is tagged or published: does this
release start with the production Compose files and the env file an operator gets from
`.env.example`?

Each run uses its own Compose project name `cicd-updater-smoke-<random>` and these steps:

1. **env-check.** Every variable a Compose file references (`${VAR}`, `$VAR`,
   `${VAR:-default}`, `${VAR:?error}` and the other forms; `$$` is an escaped dollar;
   comment lines are skipped) must appear in `env-example`, either assigned (`VAR=...`,
   `export VAR=...`) or commented out (`# VAR=...`). Optional variables are documented
   commented out. A missing variable fails the smoke.
2. **The env file, as written.** The smoke env file contains every assigned line of
   `.env.example` exactly as written (empty optional values stay empty, because that is what
   production gets), leaves commented lines out, and appends the image variables as
   `<VAR>=<repository>@<digest>` and the throwaway values of the `env` input (`--env`),
   which replace lines of `.env.example` with the same key. It is written with mode `0600`.
3. **No restart policies.** `docker compose config --services` lists the services; an
   extra override sets `restart: "no"` on every service, so a crash stays visible instead of
   looping.
4. **Start.** `docker compose -p <project> -f <files...> -f <override> --env-file <file>
   up -d --no-build --pull missing`.
5. **Health and version.** The runner polls `health-url` every 2 seconds (5 seconds per
   request) until it answers 2xx and, with `health-version-path`, the value at that path
   equals the expected version. A container that exited with a non-zero code fails the
   smoke at once, with the last 40 log lines. Otherwise the wait ends after
   `timeout-seconds`.
6. **Upgrade from the previous release** (optional, below).
7. **Teardown.** `docker compose down -v --remove-orphans --timeout 10`, also after a
   failure.

The report is a Markdown table (step, result, seconds, detail) in the job summary and in
the `report` output.

Practical points:

- **The health URL is polled from the runner.** Publish the port on the loopback in a
  smoke-only Compose override that you list in `compose-files`:

  ```yaml
  # docker-compose.smoke.yml: used only by the release smoke test
  services:
    api:
      ports:
        - "127.0.0.1:3000:3000"
  ```

- **The env file decides.** Compose prefers variables of its own environment to
  `--env-file`, so the smoke runs every Compose command without the runner's environment
  variables whose names are keys of the smoke env file. A CI variable named like an image
  variable (for example `APP_IMAGE`) cannot replace the pushed digest. The templates keep
  the repositories in variables with other names (`APP_REPOSITORY`) to avoid confusion.
- **Values the operator provides in production.** A variable that is empty in
  `.env.example` is empty in the smoke. When a Compose file requires it (`${VAR:?}`), give
  the smoke a throwaway value with the `env` input (`--env KEY=VALUE` in the CLI), for
  example `POSTGRES_PASSWORD=smoke-${{ github.run_id }}`. These values are in the smoke env
  file, so the sidecar sees them too in the upgrade through the sidecar.
- **One architecture per runner.** The smoke starts the images of the runner's own
  platform. Build on native runners per architecture (GitHub template) to start both; a
  single QEMU job (Forgejo template, `release` action) starts only one.

### Upgrade from the previous release

With `upgrade-from` set, the smoke starts the earlier release first and updates it:

| `upgrade-from` | Release that is started first |
| --- | --- |
| `none` (default) | none; no upgrade test |
| `previous` | the newest release in the feed that has a `release.json` and is older than the expected version |
| a version, for example `1.3.2` | that version |

The earlier release is found in a feed (`feed-type`, `feed-url`; on GitHub the default is
the repository itself) and read with `token`, which is sent only to the feed origin. Its
`release.json` is parsed for the image digests but not signature-verified: it only decides
what the smoke starts. The feed is read through the same address guard as the sidecar
([feeds.md](feeds.md)): only public addresses. A release host on a private network (an
internal Forgejo) must be named with `feed-allow-private-host` (`--feed-allow-private-host`
in the CLI, repeatable); that exact host may then resolve to a private or loopback
address.

When there is nothing to upgrade from, the upgrade test is skipped with a note: the feed
has no release at all (the first release of a project), or none that has a `release.json`
and qualifies.

**Without `updater-config`**, the smoke starts the earlier images, waits for health with the
earlier version, rewrites the env file with the new digests, recreates the services with
`docker compose up -d --no-build --pull missing` and waits for health with the new version.

**With `updater-config` and `updater-image`**, the update runs through the sidecar itself,
which is the closest thing to what operators will do:

1. The earlier release is started and healthy, as above.
2. A file feed is generated in a temporary directory: `index.json` and a `release.json`
   for the new digests, with `signing.mode: "none"`, the runner's platform and the tag
   `v<version>`.
3. A copy of `updater.yaml` is changed for the smoke: `trust.mode: none` with
   `none.acknowledgeUnsigned: true` and `verifier.isolate: false`; `release.feed` is the
   `file` feed at `/smoke-feed` with `tagPattern: v{version}`; `compose.projectDir` is the
   working directory, `compose.projectName` the smoke project, `compose.envFile` the smoke
   env file (written as `.cicd-updater-smoke.env` in the working directory and removed
   afterwards); `state.dir` is `/state`.
4. The sidecar image runs as service `updater` (profile `updater`, no restart policy, label
   `io.github.restow-backup.cicd-updater.role=sidecar`). Its environment and volumes from
   the project's Compose file are **replaced**, not merged (Compose `!override`, which
   needs Docker Compose 2.24 or newer on the runner), so production-only settings such as
   the `PROJECT_DIR` mount or a registry auth file do not reach the smoke. The environment
   is `CICD_UPDATER_CONFIG` (the changed copy) and `CICD_UPDATER_COMPOSE__PROJECT_DIR`
   (the checkout); the volumes are the Docker socket, the working directory at the same
   path, the feed and the config read-only, and fresh state and shared volumes.
5. The smoke waits until `cicd-updater status --json` answers, runs
   `cicd-updater schedule <version> --yes`, and waits until the run has finished. The
   outcome must be `succeeded`; otherwise the run log is shown and the smoke fails.
6. Health is checked again with the new version.

Trust mode `none` is used here because the images are signed only after the smoke passed;
it applies to the throwaway sidecar on the CI runner, never to an installation. This path
needs `expect-version` (the actions set it from the tag).

## Immutability

A published release never changes. A correction gets a new version number.

| Where | Rule |
| --- | --- |
| Registry, version tag | `release index` refuses when `<repository>:<version>` already exists and lists other platform images than the ones being published. A tag that already lists exactly these platform images is accepted, so a publish job that failed after tagging can be re-run. `refuse-existing: false` (`--allow-existing`) switches the check off; do not use it for releases. |
| Registry, extra tags | Moving tags such as `latest` are retagged freely; the sidecar never uses them. |
| Registry, digests | Images are pushed and referenced by digest, so what a digest names cannot change. |
| GitHub, Forgejo, Gitea | A **published** release for the tag is refused. A **draft** for the tag is reused and assets with the same name are replaced, so a failed `release-json` run can be repeated. |
| GitLab | GitLab has no draft releases. An existing release for the tag is refused. The files are uploaded to the generic package registry (package `release-assets`, version = tag) first, and the release with its asset links is created last. |
| Git | Never move or reuse a tag. Protect release tags ([ci/github.md](ci/github.md), [ci/gitlab.md](ci/gitlab.md), [ci/forgejo.md](ci/forgejo.md)). |

## How `release.json` is created

`release json create` fills the document from the CI and the inputs:

| Field | Source |
| --- | --- |
| `project` | `--project`, else `GITHUB_SERVER_URL` + `GITHUB_REPOSITORY` (Forgejo and Gitea set these too; a path prefix of the server is kept), else `CI_SERVER_URL` + `CI_PROJECT_PATH` on GitLab; lowercase |
| `version`, `tag` | `--version`, `--tag` |
| `channel` | `beta` for a pre-release version, else `stable` |
| `commit` | `--commit`, else `GITHUB_SHA`, else `CI_COMMIT_SHA` |
| `createdAt` | the current time in UTC, without fractional seconds |
| `notesUrl` | `--notes-url` (the actions default to the release page on github.com) |
| `images` | the published images JSON |
| `upgrade`, `requires` | the release policy file |
| `signing` | `--signing`; `tool: "cosign"`; `toolVersion` from `cosign version --json` when the mode is not `none` |

The document is validated before it is written, serialized as pretty JSON with a final
newline (UTF-8, no byte order mark), and its SHA-256 is printed as output `sha256`.

## The `release` CLI for other CI systems

The sidecar image contains the release tools:

```sh
docker run --rm ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest> release --help
```

or, as the job image of a CI (with the entrypoint cleared), `cicd-updater release <command>`.
Pin the image by digest after verifying it ([upgrading-the-updater.md](upgrading-the-updater.md)).

| Command | Purpose |
| --- | --- |
| `env-check --compose-files a.yml,b.yml [--env-example .env.example]` | Smoke step 1 on its own. |
| `build --images <json\|@file> --version V [--platforms linux/amd64,linux/arm64] [--no-push] [--cache-from X] [--cache-to Y]` | `docker buildx build` per image, labels as above, provenance and SBOM off, pushed by digest without a tag. Images: `{key: {repository, context, file, target, buildArgs}}`. Prints `images` (for `index`) and `smoke-images` (for `smoke`). |
| `smoke --compose-files a.yml --images <json> --image-vars <json> --health-url U [--env-example F] [--health-version-path P] [--expect-version V] [--upgrade-from previous\|none\|V --feed-type T --feed-url U [--feed-allow-private-host H]] [--updater-config F --updater-image I] [--env KEY=VALUE ...] [--timeout-seconds 600] [--report report.md]` | The smoke test. `--env` and `--feed-allow-private-host` may be repeated. |
| `index --images <json\|@file> --version V [--extra-tags a,b] [--allow-existing]` | Create and tag the multi-arch indexes from the platform digests, after the smoke. Prints `images` (the published images JSON). |
| `sign-images --images <json\|@file> --signing keyless\|key\|none [--key K] [--transparency-log]` | Sign each index digest. |
| `sbom --images <json\|@file> --signing keyless\|key\|none [--key K] [--transparency-log] [--out-dir sbom]` | syft per platform image; attested unless the signing mode is `none`. Prints `files`. |
| `json create --images <json\|@file> --version V --tag T [--policy-file F] [--notes-url U] [--signing ...] [--project host/owner/repo] [--commit SHA] [--out release.json] [--tag-pattern v{version}]` | Write `release.json`. Prints `path` and `sha256`. |
| `json validate --file release.json [--tag T]` | Schema and additional rules; with `--tag`, the document's tag must equal the Git tag. |
| `json sign --file release.json [--bundle release.json.sigstore.json] --signing ... [--key K] [--transparency-log]` | `cosign sign-blob --bundle`. |
| `json verify --file release.json [--bundle B] (--github-repository R --workflow W \| --public-key P) [--transparency-log]` | Verify a bundle for the GitHub identity at the document's tag, or against a public key. |
| `upload --host github\|gitea\|gitlab --api-url U --repository R --tag T --files a,b [--name N] [--notes-file F] [--prerelease] [--draft]` | Create or reuse the draft, upload, publish (see [Immutability](#immutability)). |
| `check-tag --tag vX.Y.Z [--changelog CHANGELOG.md] [--package package.json ...]` | The tag is `v<version>`, the changelog has a dated section, the package versions agree. |
| `version --tag T [--tag-pattern v{version}]` | Print `version`, `prerelease` and `channel` of a tag. |

Every command accepts `--github-output <file>`: outputs are printed as `key=value` on
standard output and appended to that file (or to `$GITHUB_OUTPUT` when it is set). `@file`
reads a JSON argument from a file.

Environment variables the CLI reads:

| Variable | Used by | Meaning |
| --- | --- | --- |
| `GITHUB_ACTIONS`, `GITHUB_SERVER_URL`, `GITLAB_CI` | signing commands | `--signing` defaults to `keyless` on GitHub Actions on github.com (`GITHUB_ACTIONS=true` and `GITHUB_SERVER_URL=https://github.com`) and on GitLab CI (`GITLAB_CI=true`); everywhere else it is required. Forgejo and Gitea runners set `GITHUB_ACTIONS` too, so they need `--signing`. |
| `COSIGN_PASSWORD` | signing commands | Password of the private key; handed to cosign in its environment only. |
| `RELEASE_TOKEN`, `GITHUB_TOKEN`, `CI_JOB_TOKEN` | `upload` | The first one set is used. GitHub: `Authorization: Bearer`; Forgejo/Gitea: `Authorization: token`; GitLab: `PRIVATE-TOKEN`, or `JOB-TOKEN` when only `CI_JOB_TOKEN` is set. |
| `RELEASE_TOKEN`, `GITHUB_TOKEN` | `smoke` | Token for reading earlier releases (`upgrade-from`). |
| `GITHUB_API_URL` | `upload` | GitHub API base (default `https://api.github.com`). |
| `GITHUB_SERVER_URL`, `GITHUB_REPOSITORY`, `GITHUB_SHA`, `CI_SERVER_URL`, `CI_PROJECT_PATH`, `CI_PROJECT_URL`, `CI_COMMIT_SHA`, `CI_COMMIT_TIMESTAMP` | `json create`, `build`, `smoke` | Defaults for project, commit, the source and created labels, and the `upgrade-from` feed. |
| `RUNNER_TEMP` | `build` | Directory for buildx metadata files (a temporary directory otherwise). |

Exit codes: `0` success, `1` failed (the reason on standard error), `2` usage error.

Tools: the sidecar image contains the Docker CLI with the Buildx and Compose plugins and
cosign. It contains neither `syft` (so `release sbom` needs another image or step) nor
`git` (so the `created` label comes from `CI_COMMIT_TIMESTAMP` on GitLab, else from the
current time).

A minimal sequence for any CI, here with a cosign key pair and a Forgejo release host
(`cicd-updater release` stands for the CLI inside the image; `COSIGN_PASSWORD` and
`RELEASE_TOKEN` come from CI secrets):

```sh
cicd-updater release build --images '{"app": {"repository": "registry.example.com/acme/notes"}}' \
  --version 1.4.0 --github-output build.env      # writes images=... and smoke-images=...
cicd-updater release smoke --compose-files docker-compose.yml,docker-compose.smoke.yml \
  --images "$SMOKE_IMAGES" --image-vars '{"app": "APP_IMAGE"}' \
  --health-url http://127.0.0.1:3000/healthz --expect-version 1.4.0
cicd-updater release index --images "$BUILT_IMAGES" --version 1.4.0 --github-output index.env
cicd-updater release sign-images --images "$PUBLISHED" --signing key --key cosign.key
cicd-updater release json create --images "$PUBLISHED" --version 1.4.0 --tag v1.4.0 \
  --signing key --project git.example.com/acme/notes --out release.json
cicd-updater release json validate --file release.json --tag v1.4.0
cicd-updater release json sign --file release.json --signing key --key cosign.key
cicd-updater release json verify --file release.json --public-key cosign.pub
cicd-updater release upload --host gitea --api-url https://git.example.com \
  --repository acme/notes --tag v1.4.0 --files release.json,release.json.sigstore.json
```

`BUILT_IMAGES`, `SMOKE_IMAGES` and `PUBLISHED` are the `images`, `smoke-images` and
`images` lines of `build.env` and `index.env`. `--project` is the source repository
(`host/owner/repo`), not the registry.

The [GitLab guide](ci/gitlab.md) shows the same sequence as a pipeline.

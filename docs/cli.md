# CLI

`cicd-updater` is the command line inside the sidecar image. It runs the sidecar (`serve`),
lets the operator check and drive updates on the host (integration level 1), and carries the
release-side tools for CI systems without composite actions (`release ...`). Commands, flags
and exit codes are part of the 1.x stability promise (see [versioning](versioning.md)).

## Running it

| Where | How |
| --- | --- |
| in the running sidecar | `docker compose exec updater cicd-updater <command> [flags]` |
| in a one-off container of the sidecar service (when the sidecar cannot run) | `docker compose run --rm --no-deps updater <command> [flags]` |
| in CI (release tools) | `docker run --rm -v "$PWD:/work" -w /work ghcr.io/restow-backup/cicd-updater:<version>@sha256:<digest> release <command> [flags]`, or the image as the job image with `entrypoint: [""]` and `cicd-updater release ...` (as in the GitLab template) |

The image's entrypoint runs the program directly, so a one-off container takes the command
without the `cicd-updater` prefix.

Use `-T` with `docker compose exec` or `run` when the output is binary (`backups cat`) or when
no terminal is attached (scripts, cron). Commands that ask a question (`schedule`,
`recover restore-env`) then need `--yes`.

```
Usage: cicd-updater <command> [flags]

  serve                              run the sidecar (default)
  version                            sidecar, API and bundled tool versions
  config check [--file F]            validate offline, print the effective configuration and its hash
  doctor                             check every prerequisite, read-only
  healthcheck                        exit 0 when the running sidecar answers /healthz (image HEALTHCHECK)
  status                             phase, run, progress, outcome, running version
  releases [--refresh]               newer releases with refusals
  verify <version>                   dry-run verification (no pull)
  schedule <version> [--in 15m | --at <RFC3339>] [--source] [--yes] [--label TEXT]
  reschedule (--in 15m | --at <RFC3339>)
  cancel                             cancel the scheduled run or abort before the point of no return
  ack                                acknowledge the finished run
  logs [<runId>]                     redacted run log
  backups list | backups cat <file>  list backups, stream one to stdout
  recover show [<runId>]             recovery facts and commands of a needs_attention run
  recover restore-env <runId> [--yes] write the captured previous lines of the writable keys back
  maintenance-page export --out <dir> static maintenance page for edges that serve files
  release <subcommand>               release-side tools for any CI (cicd-updater release --help)

Global flags: --json (machine-readable output), --help
```

## Global flags

| Flag | Effect |
| --- | --- |
| `--json` | machine-readable output (one JSON document) for `version`, `config check`, `doctor`, `status`, `releases`, `verify`, `schedule`, `reschedule`, `cancel`, `ack`, `logs`, `backups list`, `recover show`, and for problems returned by the API |
| `--help`, `-h`, `help` | print the usage and exit 0 (only as the first argument) |
| `--file <path>` | read this configuration file instead of `CICD_UPDATER_CONFIG` (every command that reads the configuration; `serve` always uses `CICD_UPDATER_CONFIG`) |

Unknown flags are a usage error (exit code 2).

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | success |
| `1` | refused or failed (a problem from the API, a refused release, a failed check, nothing to act on, a question answered with no) |
| `2` | usage error (unknown command or flag, missing argument, both `--in` and `--at`) |
| `3` | the sidecar is unreachable or refused the token |
| `64` | invalid configuration |
| `75` | the state directory is locked by another sidecar (`serve`) |

## How the CLI talks to the sidecar

`status`, `releases`, `verify`, `schedule`, `reschedule`, `cancel`, `ack`, `logs`,
`backups list` and `recover show` use the sidecar's HTTP API:

- the token is read from `auth.tokenFile`, or from `<auth.sharedDir>/token` (default
  `/shared/token`);
- the address is `server.listen`, with `0.0.0.0` (or `::`) replaced by the loopback address;
- every request carries `x-cicd-updater-client: cli`. Requests from a loopback address with
  that header are recorded as `via: "cli"` in the run and the journal;
- reads time out after 30 seconds, writes after 10 minutes (scheduling verifies the release
  first).

If the token file cannot be read, the server does not answer, or the token is refused, the
command prints why and exits with **3**.

The other commands work without the HTTP server: `serve`, `version`, `config check`,
`doctor`, `healthcheck` (asks `/healthz` only), `backups cat`, `recover restore-env`,
`maintenance-page export` and `release`.

## Commands

### `serve`

Runs the sidecar: loads the configuration from `CICD_UPDATER_CONFIG` (exit 64 when invalid),
takes the state lock (exit 75 when another sidecar holds it), loads the token (exit 64 when
`auth.tokenFile` is unusable), resolves an interrupted run, and starts the HTTP server. It is
the image's default command. On SIGTERM or SIGINT it stops within 8 seconds and exits 0.

### `version`

Prints one line per component: `cicdUpdater` (the sidecar version), `api` (`1.0`), `node`,
the first output line of the bundled `docker`, `docker compose`, `docker buildx` and `age`,
and cosign's `gitVersion` (from `cosign version --json`); `not available` for a tool that does
not run. Needs no configuration. `--json` prints an object with the same keys.

### `config check [--file F]`

Validates the configuration offline (no Docker, no network) and prints `<file>: valid`, the
`configHash`, the applied environment overrides and the effective configuration. Exit 0, or
64 with one line per problem. `--json`: `{ ok, file, configHash, overrides, config }` or
`{ ok: false, file, problems }`. See [configuration](configuration.md#validation).

### `doctor`

Checks every prerequisite separately and read-only and names the file and key for each:
Docker socket and Engine version, Compose files and the Compose probe, env file, state volume,
disk space, the container's own labels, image pin, ports and project directory, the verifier
volume, the release feed and its token, registry access per managed image, Sigstore (keyless)
or the public keys (key). Output and fixes: [reading doctor output](troubleshooting.md#reading-doctor-output).

Exit codes: 0 when no check failed, 1 when a check failed, 64 when the configuration is
invalid (the checks do not run). Code 2 is defined for "nothing could be checked".

### `healthcheck`

Asks `GET /healthz` of the running sidecar on the configured listen address (4-second
timeout). Exit 0 when it answers with a success status, 1 when it answers with another
status, 3 when it does not answer, 64 when the configuration is invalid. The image's
`HEALTHCHECK` runs it every 30 seconds (timeout 5 seconds, start period 20 seconds, 3
retries).

### `status`

```
phase: running (Update in progress)
running: 1.3.0 (from health)
trust: keyless https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v<version>
ready: yes
Run r-1793642651000-3fa2: 1.3.0 -> 1.4.0 (image, trust keyless)
  starts at 2026-11-02T18:30:00.000Z, started 2026-11-02T18:30:00.412Z
  progress 43 %, step backup
  Creating the backup.
  verification: signatures verified, digests verified
```

Shows the phase, the running version and where it came from, the trust mode and identity,
whether the sidecar is ready, every blocker and warning with its text, and the current run:
versions, times, progress, step, outcome, message, failure code with its text and detail,
and the verification results. `--json` prints the full `GET /v1/state` view (including
`updater.latestAvailable`, see [upgrading the updater](upgrading-the-updater.md#the-selfcheck-notice)).

### `releases [--refresh]`

```
channel stable, running 1.3.0, next installable 1.4.0
  1.5.0            refused: below_minimum_version
  1.4.0            installable
```

Lists the newer releases of the configured channel (at most 10, newest first) with their
refusals, and the newest installable one. The release documents are read but not
signature-verified here. `--refresh` bypasses the release list cache (`release.cacheSeconds`).

### `verify <version>`

```
release.json verified, sha256 3b9f...
  app: ghcr.io/acme/notes@sha256:0f1e... signature verified, exists true
  web: ghcr.io/acme/notes-web@sha256:1a2b... signature verified, exists true
installable
```

A dry run of what scheduling checks: fetches and verifies `release.json`, verifies every image
signature in the registry and checks that every image exists, without pulling. Exit 0 when
the release is installable and no image failed; 1 otherwise. Results are cached for 10
minutes per version; scheduling always verifies again.

### `schedule <version> [--in D | --at T] [--source] [--yes] [--label TEXT]`

Schedules an update to `<version>` (plain SemVer, as in `release.json`).

| Flag | Meaning |
| --- | --- |
| `--in D` | lead time: `90s`, `15m`, `2h`, `1d`, or plain seconds (`300`) |
| `--at T` | start time, RFC 3339 (`2026-11-02T22:00:00+01:00`); stored in UTC |
| (neither) | start now |
| `--source` | build from the tagged source archive (source mode must be enabled, see [configuration](configuration.md)) |
| `--yes` | do not ask for confirmation |
| `--label TEXT` | the requester label in the run and the journal (default `cli`) |

Without `--yes` the command asks `Schedule the update to 1.4.0 in 900 s? [y/N]`. Without a
terminal it cannot ask: it prints "Nothing was scheduled (use --yes to skip the question)."
and exits 1. Before the sidecar accepts the run it verifies the release document and every
image signature; refusals, blockers and verification failures are printed and the command
exits 1. The lead time must not exceed `schedule.maxLeadSeconds`.

### `reschedule (--in D | --at T)`

Moves the scheduled run (only in phase `scheduled`; otherwise refused with
`not_scheduled`). A time that has already passed starts the run now.

### `cancel`

Acts on the current run, without a question:

- phase `scheduled`: cancels it (`Run <id> cancelled.`);
- phase `running` before the point of no return: requests an abort
  (`Abort of run <id> requested; it stops at its next check point.`); the run ends
  `unchanged` with the code `aborted`;
- after the point of no return: refused with `point_of_no_return` (exit 1).

### `ack`

Acknowledges the finished run (phase `succeeded` or `failed`): the phase returns to `idle`
and the run stays in the history. Refused with `not_finished` while a run is scheduled or
running. Read `logs` before: a run in the history has no log.

### `logs [<runId>]`

Prints the redacted run log (at most 200 lines) of the current run, or of the named run.
Runs in the history keep no log, so for them the output is empty; the sidecar's process log
(`docker compose logs updater`) has every line too.

### `backups list`

Lists the backups, newest first: name, size, `verified` or `unverified`, `encrypted`,
`protected`. `--json` adds SHA-256, creation time, run id and versions.

### `backups cat <file>`

Streams one backup to standard output. Use it with `-T`:

```sh
docker compose exec -T updater cicd-updater backups cat <file> > <file>
```

Only names of this sidecar's backups are accepted (`<file> is not a backup of this sidecar.`,
exit 1). Encrypted backups are streamed as they are; decrypting is the operator's job. Reads
the backup directory directly; the HTTP server is not needed.

### `recover show [<runId>]`

Prints the recovery information of a run that ended in `needs_attention` (the current run, or
a run from the history): failure code, `schemaChanged`, the previous version, the backup with
size and SHA-256, the previous image of every managed service, and the rendered commands.
`--json` prints the recovery object. A run without recovery information exits 1. See the
[runbook](backups-and-recovery.md#runbook-a-run-ended-in-needs_attention).

### `recover restore-env <runId> [--yes]`

Writes the captured previous lines of the writable keys back into the env file, byte for
byte, and removes keys that were absent before. Only keys that are writable keys of the
current configuration are touched. It prints each line (`restore: ...` or `remove: ...`) and
asks for confirmation unless `--yes` is given. Without a terminal and without `--yes` it
writes nothing and exits 1.

It reads `status.json` directly and works without the HTTP server, also in a one-off
container. The commands that `recover show` renders call it with `exec` without `-T`, so the
question works in a terminal; in a script use `exec -T ... --yes`.

### `maintenance-page export --out <dir> [--status-url URL] [--home-url URL] [--asset-base URL]`

Writes the static maintenance page (`index.html`, `maintenance.css`, `maintenance.js`, and
the logo if the branding file names one) into `<dir>`, for edges that serve files
themselves.

| Flag | Default | Meaning |
| --- | --- | --- |
| `--out <dir>` | required | target directory, created if needed (a path inside the container; the project directory is mounted at the same path) |
| `--status-url URL` | `/public/v1/status` | where the page reads the public status |
| `--home-url URL` | `/` | where the page goes when the update is over |
| `--asset-base URL` | empty | prefix of the stylesheet, script and logo URLs. Empty means relative URLs, for files served next to each other; set an absolute path (for example `/maintenance/`) when the edge serves the page in place of any address. The built-in page the sidecar serves uses `/public/v1/maintenance/`. |

See [maintenance page](maintenance-page.md).

### `release <subcommand>`

The release-side functions for any CI. The composite actions under `actions/` run the same
code. `cicd-updater release --help` prints:

```
Usage: cicd-updater release <command> [flags]

  env-check   --compose-files a.yml,b.yml [--env-example .env.example]
  json create --images <json|@file> --version V --tag T [--policy-file F] [--notes-url U]
              [--signing keyless|key|none] [--project host/owner/repo] [--commit SHA] [--out release.json]
              [--tag-pattern v{version}]
  json validate --file release.json [--tag T]
  json sign   --file release.json [--bundle release.json.sigstore.json] --signing keyless|key|none
              [--key K] [--transparency-log]   (password: COSIGN_PASSWORD)
  json verify --file release.json [--bundle B] (--github-repository R --workflow W | --public-key P)
  sign-images --images <json|@file> --signing keyless|key|none [--key K] [--transparency-log]
  sbom        --images <json|@file> --signing keyless|key|none [--key K] [--transparency-log]
              [--out-dir sbom]   (syft per platform image; attested unless signing is none)
  upload      --host github|gitea|gitlab --api-url U --repository R --tag T --files a,b
              [--name N] [--notes-file F] [--prerelease] [--draft]   (token: RELEASE_TOKEN or GITHUB_TOKEN)
  smoke       --compose-files a.yml --images <json> --image-vars <json> --health-url U
              [--env-example .env.example] [--health-version-path P] [--expect-version V]
              [--upgrade-from previous|none|V --feed-type T --feed-url U] [--updater-config F --updater-image I]
              [--timeout-seconds 600] [--report report.md]
  check-tag   --tag vX.Y.Z [--changelog CHANGELOG.md] [--package package.json ...]
  build       --images <json|@file> --version V [--platforms linux/amd64,linux/arm64] [--no-push]
              [--cache-from X] [--cache-to Y]
              (images: {key: {repository, context, file, target, buildArgs}}; pushes by digest,
              untagged; prints images for index and smoke-images for smoke)
  version     --tag T [--tag-pattern v{version}]      (version, prerelease, channel of a tag)
  index       --images <json|@file> --version V [--extra-tags a,b] [--allow-existing]
              (images: {key: {repository, digests: [per-platform digests]}}; prints the
              published images JSON for json create and sign-images)

Flags for every command: --github-output <file> (write outputs for GitHub/Forgejo Actions)
```

Outputs are printed as `key=value` lines and also appended to the file of `--github-output`
or, when that is not given, `$GITHUB_OUTPUT` (multi-line values in heredoc form). Exit codes
of the release tools: 0 success, 1 failed, 2 usage error. `cicd-updater release` without a
subcommand prints the usage and exits 2.

| Command | What it does | Outputs |
| --- | --- | --- |
| `env-check` | every `${VAR}` referenced in the Compose files appears in the env example (commented lines count); exit 1 lists the missing ones | |
| `json create` | writes `release.json` from the published images (the `index` output), the version, the tag and the release policy file (default `.cicd-updater/release-policy.yaml`; when the default file is missing, defaults apply; a named file must exist). `--project` defaults to the CI's repository (`GITHUB_SERVER_URL`/`GITHUB_REPOSITORY` or `CI_SERVER_URL`/`CI_PROJECT_PATH`), `--commit` to `GITHUB_SHA` or `CI_COMMIT_SHA`. Records the cosign version unless signing is `none` | `path`, `sha256` |
| `json validate` | validates a document against the schema and the extra rules; with `--tag`, checks the tag | |
| `json sign` | `cosign sign-blob` with a Sigstore bundle (default `<file>.sigstore.json`); nothing with `none` | `bundle` |
| `json verify` | `cosign verify-blob` with the exact GitHub identity (`--workflow` defaults to `.github/workflows/release.yml`) at the document's tag, or with a public key | |
| `sign-images` | `cosign sign` of every `repository@digest` | |
| `sbom` | an SBOM per platform image with syft, attested unless signing is `none` | `files` |
| `upload` | GitHub and Forgejo/Gitea: creates a draft release (or reuses the draft), uploads the files, then publishes it unless `--draft`. GitLab: uploads the files to the generic package registry, then creates the release with asset links. An already published release is never changed: the command fails (a correction is a new version). Token from `RELEASE_TOKEN`, `GITHUB_TOKEN` or `CI_JOB_TOKEN`; `--api-url` defaults to `GITHUB_API_URL` or `https://api.github.com` for GitHub and is required otherwise (`https://<host>/api/v1`, `https://<host>/api/v4`); `--name` defaults to the tag | `url`, `uploaded` |
| `smoke` | starts the project from the Compose files with an env file derived from the env example plus the image variables, waits for the health URL (and version), optionally upgrades from an earlier release (through the sidecar with `--updater-config` and `--updater-image`), tears everything down; exit 1 when it fails. `--upgrade-from` needs `--feed-type` and `--feed-url` outside GitHub Actions. The report file defaults to `smoke-report.md` | `report` |
| `check-tag` | the tag is a release tag, `CHANGELOG.md` has a dated section for it, and each `--package` file (repeatable) has the same version | `version`, `prerelease`, `channel` |
| `build` | builds every image for the platforms with Buildx and the OCI labels, pushes by digest without a tag (`--no-push` to skip) | `images`, `smoke-images` |
| `version` | the version, pre-release flag and channel of a tag; exit 1 when the tag does not match the pattern | `version`, `prerelease`, `channel` |
| `index` | creates and tags the multi-arch index of every image; refuses when the tag exists with another digest unless `--allow-existing` | `images` |

`--signing` has no default outside GitHub Actions and GitLab CI; there it defaults to
`keyless`. The cosign key password comes from `COSIGN_PASSWORD`. See
[release side](release-side.md) and [GitLab CI](ci/gitlab.md).

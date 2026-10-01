# HTTP API

The sidecar serves a small JSON API. Your app's backend uses it to read the update state,
schedule, move, cancel and acknowledge runs, and copy the journal into its audit log. The
CLI inside the sidecar container uses the same API. Browsers never call the authenticated
API; they talk to your app, and during an update to the public status through your edge.

- TypeScript apps can use the [SDK](sdk.md), which wraps every endpoint below.
- Apps in other languages call the API directly ([app integration](app-integration.md) has
  Python examples).
- The machine-readable contract is the [OpenAPI document](#openapi-document).

## Contents

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Errors](#errors)
- [Versioning](#versioning)
- [Endpoints](#endpoints)
- [Shared types](#shared-types)
- [Journal ingestion (exactly once)](#journal-ingestion-exactly-once)
- [OpenAPI document](#openapi-document)

## Conventions

| Topic | Rule |
| --- | --- |
| Address | The sidecar listens on `server.listen` (default `0.0.0.0:8090`) on the internal Compose network. From the app container the base URL is usually `http://updater:8090`. The sidecar has no published port; a published port is the blocker `api_exposed`. |
| Paths | Authenticated endpoints live under `/v1`. Public endpoints live under `/public/v1`. Liveness is `/healthz`. |
| Bodies | JSON in and out. A request body is at most 64 KiB (`413 payload_too_large`). A non-empty body must be sent as `Content-Type: application/json` (`415 unsupported_media_type`). A body that is not JSON is `422 invalid_request`. |
| Headers | Every response carries `Cache-Control: no-store` and `X-Content-Type-Options: nosniff`. |
| Times | RFC 3339 with offset. The sidecar answers in UTC. `StateView` and `PublicStatus` carry `serverTime`, so clients can compute the clock offset for countdowns. |
| Unknown data | Clients must ignore unknown fields and render unknown codes generically. Blocker, warning, failure, message and refusal codes are plain strings in the response schemas for this reason. |
| Run ids | `r-<epoch ms>-<4 hex>`, for example `r-1793644200412-9c1e`. |
| Event ids | `<epoch ms, 15 digits>-<counter, 6 digits>`, for example `001793644200412-000017`. They sort as strings in creation order. |

## Authentication

Everything under `/v1` requires a bearer token:

```http
GET /v1/state HTTP/1.1
Host: updater:8090
Authorization: Bearer 3c9e0f...
```

Where the token comes from:

- By default the sidecar generates it into `<auth.sharedDir>/token` (default
  `/shared/token`): 64 hex characters and a newline, mode `0640`, owner root, group
  `auth.tokenGroupId`. Mount the shared volume read-only into the app container, for
  example at `/run/cicd-updater`, and read `/run/cicd-updater/token`. Set
  `auth.tokenGroupId` to the app's group id when the app runs as non-root.
- Alternatively the operator provides a token file (`auth.tokenFile`, for example a Compose
  secret) with 32 to 512 characters from `[A-Za-z0-9._~+/=-]`.
- Trim the file content before use. Re-read the file after a `401`: a reset volume gives
  the sidecar a new token.

The sidecar hashes both tokens with SHA-256 and compares the hashes in constant time. A
missing or wrong token is `401` with `WWW-Authenticate: Bearer` and the problem
`unauthorized`. This also applies to unknown paths under `/v1`. The token never appears in
a response or a log line. Mount the token only into the app: every container that can read
it can schedule updates.

Unauthenticated endpoints: `GET /healthz`, `GET /public/v1/status` and the maintenance page
under `/public/v1/maintenance/`.

### Who requested an action

Runs and journal events record an actor `{ id, label, via }`:

- `id` and `label` come from `requestedBy` in the request body. `POST /v1/runs` requires
  it. `PATCH /v1/runs/{runId}`, `.../cancel` and `.../acknowledge` accept it optionally;
  without it the label is `api` (or `cli`).
- `via` is set by the sidecar, never by the client body. A request counts as `cli` only
  when it comes from a loopback peer address **and** carries the header
  `x-cicd-updater-client: cli`. Everything else is `api`. The header alone, sent over the
  network, changes nothing.
- The journal schema also allows `via: "system"`. Accept it in your ingestion code even
  though the 1.0 sidecar does not emit it: the `update.started`, `update.succeeded` and
  `update.failed` events carry the actor who scheduled the run.

## Errors

Errors are RFC 9457 problem documents with `Content-Type: application/problem+json`:

```json
{
  "type": "urn:cicd-updater:problem:blocked",
  "title": "The updater cannot start an update now",
  "status": 409,
  "code": "blocked",
  "detail": "The updater cannot start an update now.",
  "blockers": [{ "code": "docker_unreachable", "detail": "connect ENOENT /var/run/docker.sock" }]
}
```

| Field | Meaning |
| --- | --- |
| `type` | `urn:cicd-updater:problem:<code>` |
| `title` | a fixed English sentence per code |
| `status` | the HTTP status |
| `code` | the machine-readable code; branch on this field |
| `detail` | optional English detail for logs; do not parse it |
| extensions | depend on the code (table below) |

Show users a translated text for `code` (the [`messages` catalogs](sdk.md#messages) have
one for every problem code), not `detail`.

| `code` | Status | When | Extension |
| --- | --- | --- | --- |
| `unauthorized` | 401 | missing or wrong bearer token | none |
| `not_found` | 404 | unknown path, unknown run id, a run id that is not the current run (reschedule, cancel, acknowledge), or the public status or maintenance page is disabled | none |
| `payload_too_large` | 413 | body larger than 64 KiB | none |
| `unsupported_media_type` | 415 | non-empty body that is not `application/json` | none |
| `invalid_request` | 422 | body, path or query fails validation; a `startsAt` or `leadSeconds` outside the allowed window | `errors`: up to 10 `{ path, message }` |
| `release_not_found` | 404 | the version is not in the feed, or the release has no `release.json` (image mode) | none |
| `release_unverifiable` | 422 | `release.json` does not verify or is invalid, or an image signature fails or the image does not exist | `checks`: a [`VerificationResult`](#post-v1releasesversionverification) when an image failed |
| `release_refused` | 409 | the release cannot be installed now | `reasons`: refusal codes |
| `release_mismatch` | 409 | `expect.releaseSha256` differs from the release document the sidecar fetched | none |
| `source_not_allowed` | 409 | `mode: "source"` but source mode is off or the feed repository is not allowlisted | none |
| `busy` | 409 | a run is already scheduled or running | none |
| `blocked` | 409 | preflight blockers | `blockers`: `{ code, detail }[]` |
| `not_scheduled` | 409 | reschedule of a run that is not scheduled; cancel of a run that is neither scheduled nor running | none |
| `point_of_no_return` | 409 | cancel after the run reached the point of no return (the start of the `stop` step) | none |
| `not_finished` | 409 | acknowledge while the run is scheduled or running | none |
| `feed_unavailable` | 502 | the release host failed | `feedError`: a feed error code (`rate_limited`, `unauthorized`, `forbidden`, `not_found`, `server_error`, `network`, `timeout`, `invalid_response`, `no_release`, `redirect`) |
| `internal` | 500 | unexpected error; details only in the sidecar log | none |

Refusal codes (`reasons`, and `refusals` in other views): `not_newer`,
`below_minimum_version`, `manual_steps_required`, `updater_too_old`, `env_missing`,
`platform_unsupported`, `image_missing`, `running_version_unknown`, and in release lists
`no_release_document`.

Blocker codes: `docker_unreachable`, `docker_too_old`, `compose_missing`,
`compose_invalid`, `compose_unsupported`, `project_mismatch`, `env_unwritable`,
`state_unwritable`, `disk_space`, `updater_image_unpinned`, `multiple_updaters`,
`api_exposed`, `verifier_unavailable`. [Troubleshooting](troubleshooting.md) explains each.

## Versioning

- The path prefix is the major version. This document describes `/v1`.
- `StateView.api.version` is `1.<minor>` (it matches `^1\.\d+$`); the 1.0 sidecar sends
  `"1.0"`. Any 1.x client can talk to any 1.x sidecar.
- `StateView.api.features` lists optional capabilities. Use it to adapt a UI to an older
  or differently configured sidecar:

| Feature | Present when |
| --- | --- |
| `abort` | always in 1.0: cancel aborts a running run before the point of no return |
| `reschedule` | always in 1.0 |
| `verification` | always in 1.0 |
| `events` | always in 1.0 |
| `backups` | always in 1.0 |
| `public_status` | `publicStatus.enabled` |
| `maintenance_page` | `maintenancePage.enabled` |
| `source_mode` | source mode is allowed for the configured feed repository |
| `encryption` | `hooks.backup.encryption.ageRecipients` is set |

Within `/v1` the API only grows:

- new endpoints;
- new optional request fields;
- new response fields;
- new codes (problem, failure, blocker, warning, message, refusal, feed error) and new
  feature names.

Codes, outcomes and phases are never removed or renamed in 1.x. A breaking change gets
`/v2`, and a 2.x sidecar keeps serving `/v1` for at least one major version. A client that
cannot parse a `StateView` should report that the sidecar speaks another major version
(the SDK raises `UpdaterUnavailableError("incompatible")`). [Versioning](versioning.md)
has the full stability promise.

## Endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| [`GET /healthz`](#get-healthz) | none | liveness |
| [`GET /public/v1/status`](#get-publicv1status) | none | public status for maintenance pages |
| [`GET /public/v1/maintenance/`](#get-publicv1maintenance) | none | built-in maintenance page and its assets |
| [`GET /v1/state`](#get-v1state) | token | everything a UI needs |
| [`GET /v1/capabilities`](#get-v1capabilities) | token | preflight result |
| [`GET /v1/releases`](#get-v1releases) | token | releases from the feed with refusals |
| [`POST /v1/releases/{version}/verification`](#post-v1releasesversionverification) | token | dry-run verification |
| [`POST /v1/runs`](#post-v1runs) | token | schedule a run |
| [`GET /v1/runs`](#get-v1runs) | token | history |
| [`GET /v1/runs/{runId}`](#get-v1runsrunid) | token | one run with its log |
| [`PATCH /v1/runs/{runId}`](#patch-v1runsrunid) | token | reschedule |
| [`POST /v1/runs/{runId}/cancel`](#post-v1runsrunidcancel) | token | cancel or abort |
| [`POST /v1/runs/{runId}/acknowledge`](#post-v1runsrunidacknowledge) | token | clear a finished run |
| [`GET /v1/events`](#get-v1events) | token | journal events after a cursor |
| [`GET /v1/backups`](#get-v1backups) | token | backup metadata |
| [`GET /v1/config`](#get-v1config) | token | effective configuration, redacted |
| [`GET /v1/openapi.json`](#get-v1openapijson) | token | the OpenAPI document |

The examples use `curl` from inside the app container:

```sh
TOKEN="$(cat /run/cicd-updater/token)"
curl -s -H "Authorization: Bearer $TOKEN" http://updater:8090/v1/state
```

### `GET /healthz`

Liveness of the sidecar process, for the container healthcheck. No token. It says nothing
about Docker, the feed or the app.

```json
{ "status": "ok" }
```

### `GET /public/v1/status`

What an anonymous visitor may see. No token. Your edge may forward exactly this path
read-only, so the maintenance page can poll it while the app is down
([maintenance page](maintenance-page.md)).

It contains no user, no image, no log, no path and no versions. With
`publicStatus.showVersions: true` it adds `targetVersion` and `fromVersion`, and run
messages keep their `version` parameter. With `publicStatus.enabled: false` the endpoint
answers `404 not_found`.

```ts
interface PublicStatus {
  phase: "idle" | "scheduled" | "running" | "succeeded" | "failed";
  runId: string | null;
  outcome: "succeeded" | "unchanged" | "rolled_back" | "needs_attention" | null;
  startsAt: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  step: StepId | null;
  steps: { id: StepId; status: StepStatus }[];
  progress: number;                       // 0..100
  message: { code: string; params: Record<string, string | number> } | null;
  failureCode: string | null;
  targetVersion?: string;                 // only with publicStatus.showVersions
  fromVersion?: string | null;            // only with publicStatus.showVersions
  serverTime: string;
}
```

Example during the backup step:

```json
{
  "phase": "running",
  "runId": "r-1793644200412-9c1e",
  "outcome": null,
  "startsAt": "2026-11-02T18:35:00.412Z",
  "startedAt": "2026-11-02T18:35:00.530Z",
  "finishedAt": null,
  "step": "backup",
  "steps": [
    { "id": "prepare", "status": "done" },
    { "id": "fetch", "status": "done" },
    { "id": "backup", "status": "running" },
    { "id": "stop", "status": "pending" },
    { "id": "migrate", "status": "pending" },
    { "id": "start", "status": "pending" },
    { "id": "health", "status": "pending" },
    { "id": "smoke", "status": "pending" },
    { "id": "finish", "status": "pending" }
  ],
  "progress": 43,
  "message": { "code": "step.backup.creating", "params": {} },
  "failureCode": null,
  "serverTime": "2026-11-02T18:36:12.004Z"
}
```

While nothing is announced, the document has `phase: "idle"`, `null` everywhere, an empty
`steps` list and `progress: 0`.

### `GET /public/v1/maintenance/`

The built-in maintenance page, served only with `maintenancePage.enabled: true` (otherwise
`404 not_found`). No token. `GET /public/v1/maintenance` redirects (`308`) to the path with
the trailing slash. Files:

| Path | Content |
| --- | --- |
| `/public/v1/maintenance/` | `index.html` |
| `/public/v1/maintenance/maintenance.css` | stylesheet |
| `/public/v1/maintenance/maintenance.js` | the script that polls `../status` |
| `/public/v1/maintenance/logo.png` or `logo.svg` | the logo from `maintenancePage.brandingFile`, when set |

The files are served with a strict `Content-Security-Policy` (`default-src 'none'`; scripts,
images and connections only from the same origin; styles from the same origin plus inline
styles for the accent colour; no framing, no form targets) and
`Referrer-Policy: no-referrer`. [Maintenance page](maintenance-page.md) covers branding,
templates and edge configuration.

### `GET /v1/state`

Everything a UI needs in one call. Query: `refresh=true` (or `1`) recomputes the
capabilities (otherwise cached for 30 seconds) and detects the running version again.

```ts
interface StateView {
  api: { version: string; features: string[] };            // version matches ^1\.\d+$
  updater: { version: string; configHash: string; latestAvailable: string | null };
  phase: "idle" | "scheduled" | "running" | "succeeded" | "failed";
  run: Run | null;                                         // the current run
  history: RunSummary[];                                   // newest first
  running: { version: string | null; source: "health" | "label" | "state" | "env" | null };
  trust: { mode: "keyless" | "key" | "none"; identity: string | null; keys: number | null };
  sourceMode: { enabled: boolean; allowlist: string[] };
  capabilities: Capabilities;
  serverTime: string;
}
```

| Field | Meaning |
| --- | --- |
| `updater.latestAvailable` | a newer sidecar release, only when `selfCheck.enabled`; the sidecar never installs it |
| `run` | the current run while the phase is not `idle`. A finished run stays here (phase `succeeded` or `failed`) until it is acknowledged |
| `running.source` | how the running version was found: the app's health check, the image's OCI label, the last succeeded run, or `env.versionVar` (lowest trust) |
| `trust.identity` | keyless mode: the expected certificate identity with `<version>` as placeholder; `null` otherwise |
| `trust.keys` | key mode: number of configured public keys; `null` otherwise |

Example (abbreviated):

```json
{
  "api": { "version": "1.0", "features": ["abort", "reschedule", "verification", "events", "backups", "public_status", "maintenance_page"] },
  "updater": { "version": "1.0.0", "configHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "latestAvailable": null },
  "phase": "scheduled",
  "run": { "id": "r-1793644200412-9c1e", "targetVersion": "1.4.0", "startsAt": "2026-11-02T18:35:00.412Z", "...": "see Run" },
  "history": [],
  "running": { "version": "1.3.2", "source": "health" },
  "trust": {
    "mode": "keyless",
    "identity": "https://github.com/example/notes/.github/workflows/release.yml@refs/tags/v<version>",
    "keys": null
  },
  "sourceMode": { "enabled": false, "allowlist": [] },
  "capabilities": {
    "ready": true,
    "blockers": [],
    "warnings": [],
    "docker": { "serverVersion": "28.3.0", "apiVersion": "1.51", "architecture": "linux/amd64", "imageStore": "classic" },
    "compose": { "projectName": "notes", "projectDir": "/opt/notes", "files": [], "envFile": ".env" },
    "backups": [],
    "checkedAt": "2026-11-02T18:30:00.100Z"
  },
  "serverTime": "2026-11-02T18:30:01.204Z"
}
```

### `GET /v1/capabilities`

The preflight result only (`Capabilities`, see [shared types](#capabilities)). Query:
`refresh=true` recomputes it. The sidecar caches the result for 30 seconds and recomputes
it at scheduling and at the start of a run anyway.

### `GET /v1/releases`

The releases of the configured feed and channel, with what refuses each. The metadata is
**not** signature-verified (`verified: false`); the sidecar verifies when you call the
verification endpoint or schedule. Query: `refresh=true` bypasses the release list cache
(`release.cacheSeconds`).

```ts
interface ReleasesView {
  channel: "stable" | "beta";
  running: string | null;
  releases: {
    version: string;
    tag: string;
    channel: "stable" | "beta";
    publishedAt: string | null;
    notesUrl: string | null;
    releaseSha256: string | null;           // pass as expect.releaseSha256 when scheduling
    minimumFromVersion: string | null;
    manualStepsRequired: boolean;
    refusals: string[];                     // empty: installable
    verified: false;
  }[];                                      // newest first, at most 10
  nextInstallable: string | null;           // newest release without refusals
  checkedAt: string;
}
```

The list holds the 10 newest releases of the channel. Releases that are not newer than the
running version are included with the refusal `not_newer`; a release without a usable
`release.json` has `no_release_document`. Errors: `502 feed_unavailable`.

### `POST /v1/releases/{version}/verification`

A dry run of what scheduling checks, without pulling anything: fetch `release.json` and its
bundle, verify the document in the configured trust mode, validate it, compute the
refusals, and check each image's signature and existence in the registry. No body. The
result is cached for 10 minutes per version (scheduling never uses the cache).

`{version}` is a plain version such as `1.4.0` (no `v`, no build metadata), otherwise
`422 invalid_request`.

```ts
interface VerificationResult {
  version: string;
  release: {
    sha256: string | null;                  // SHA-256 of the release.json bytes
    document: "verified" | "not_checked";   // not_checked in trust mode none
    channel: "stable" | "beta";
    notesUrl: string | null;
    manualSteps: { required: boolean; summary: string | null; url: string | null };
    minimumFromVersion: string | null;
  };
  refusals: string[];                       // empty: installable
  images: {
    key: string;                            // image key of release.json
    ref: string;                            // repository@sha256:... (mirror applied)
    signature: "verified" | "failed" | "not_checked";
    exists: boolean | null;                 // null: unknown (registry unreachable or unauthorized)
    error: string | null;                   // a fetch.* failure code
  }[];
  checkedAt: string;
}
```

A failed image signature or refusals still give `200`; inspect `images` and `refusals`.
Problems: `404 release_not_found`, `422 release_unverifiable` (the document itself does not
verify or is invalid), `502 feed_unavailable`.

```json
{
  "version": "1.4.0",
  "release": {
    "sha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881",
    "document": "verified",
    "channel": "stable",
    "notesUrl": "https://github.com/example/notes/releases/tag/v1.4.0",
    "manualSteps": { "required": false, "summary": null, "url": null },
    "minimumFromVersion": "1.2.0"
  },
  "refusals": [],
  "images": [
    {
      "key": "app",
      "ref": "ghcr.io/example/notes@sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      "signature": "verified",
      "exists": true,
      "error": null
    }
  ],
  "checkedAt": "2026-11-02T18:29:40.902Z"
}
```

### `POST /v1/runs`

Schedule a run. Before it accepts the request, the sidecar performs the full verification
again (nothing unverifiable is ever announced) and stores the verified `release.json`.

```ts
interface ScheduleRequest {
  version: string;                          // plain SemVer, as in release.json
  mode?: "image" | "source";                // default "image"
  leadSeconds?: number;                     // integer >= 0, at most schedule.maxLeadSeconds
  startsAt?: string;                        // RFC 3339 with offset; exclusive with leadSeconds
  requestedBy: { id?: string | null; label: string };  // id <= 200, label 1..200 characters
  expect?: { releaseSha256?: string };      // 64 lowercase hex
}
```

- Without `leadSeconds` and `startsAt` the run starts at once (lead 0).
- `startsAt` may lie up to 60 seconds in the past (clock skew) and at most
  `schedule.maxLeadSeconds` (default 14 days) in the future.
- Send `expect.releaseSha256` with the hash the admin was shown (`releaseSha256` from
  `GET /v1/releases`, `release.sha256` from the verification, or `documentSha256` from the
  SDK's feed check). If the document changed in between, the request fails with
  `release_mismatch`, so what the admin read is what gets installed.
- `requestedBy.label` is shown in the UI and the journal. Use something an auditor
  recognises, such as the user's email address.
- Scheduling while a finished run is still current acknowledges it implicitly (journal
  event `update.acknowledged` with `details.implicit: true`).

The checks run in this order, and the first failure answers: request validation (`422`),
`source_not_allowed`, `busy`, `blocked`, `release_not_found` or `feed_unavailable`,
`release_unverifiable` (document), `release_mismatch`, `release_unverifiable` (images, with
`checks`), `release_refused`.

Success: `202 Accepted` with a `StateView`. The phase is `scheduled`, or `running` when the
run starts at once.

```sh
curl -s -X POST http://updater:8090/v1/runs \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{
        "version": "1.4.0",
        "leadSeconds": 300,
        "requestedBy": { "id": "user-42", "label": "admin@example.com" },
        "expect": { "releaseSha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881" }
      }'
```

A refused release:

```json
{
  "type": "urn:cicd-updater:problem:release_refused",
  "title": "The release cannot be installed now",
  "status": 409,
  "code": "release_refused",
  "detail": "The release cannot be installed now.",
  "reasons": ["below_minimum_version"]
}
```

### `GET /v1/runs`

The history of finished and cancelled runs (summaries without logs), newest first. Query: `limit` 1 to
100, default 20. The sidecar keeps `state.historyLimit` runs (default 20).

```json
{ "runs": [ { "id": "r-1793644200412-9c1e", "outcome": "succeeded", "...": "see RunSummary" } ] }
```

### `GET /v1/runs/{runId}`

One run. For the current run the response includes its log (at most 200 redacted lines).
For a run from the history the response has the same shape with `log: []`; the history
does not keep logs. Unknown id: `404 not_found`.

### `PATCH /v1/runs/{runId}`

Move a scheduled run. Body: exactly one of `leadSeconds` and `startsAt` (validated as on
scheduling), plus an optional `requestedBy`.

```json
{ "startsAt": "2026-11-02T22:00:00Z", "requestedBy": { "id": "user-42", "label": "admin@example.com" } }
```

Success: `200` with a `StateView`. A new start time at or before now starts the run at
once. Problems: `404 not_found` (not the current run), `409 not_scheduled`,
`422 invalid_request`.

### `POST /v1/runs/{runId}/cancel`

Cancel a scheduled run, or abort a running one before the point of no return. The body is
optional: `{ "requestedBy": { "id": "...", "label": "..." } }`, or no body at all.

| Phase | Result |
| --- | --- |
| `scheduled` | `200` with a `StateView`: the run moves to the history with `cancelled: true`, the phase becomes `idle` |
| `running`, before the point of no return | `202` with a `StateView`: `run.abortRequestedAt` is set and the run stops at its next check point; it ends with outcome `unchanged` and failure code `aborted`. Repeating the request is harmless |
| `running`, at or after the point of no return | `409 point_of_no_return` |
| `succeeded`, `failed` | `409 not_scheduled` |

MySQL, volume and command backups cannot be interrupted safely; an abort during them
takes effect when the backup step ends. Unknown or non-current run id: `404 not_found`.

### `POST /v1/runs/{runId}/acknowledge`

Clear a finished run so the phase returns to `idle`; the run stays in the history. Body
optional, as for cancel. Success: `200` with a `StateView`. Problems: `409 not_finished`
while scheduled or running, `404 not_found` when the id is not the current run.

### `GET /v1/events`

Journal events after a cursor, oldest first. Query:

| Parameter | Rule |
| --- | --- |
| `after` | an event id; omitted or empty: from the oldest retained event |
| `limit` | 1 to 500, default 100 |

```ts
interface EventsView {
  events: JournalEvent[];
  next: string | null;     // id of the last returned event; null when none was returned
  gap: boolean;            // `after` is older than the oldest retained event: events were lost
}
```

```json
{
  "events": [
    {
      "id": "001793644200412-000017",
      "at": "2026-11-02T18:30:00.412Z",
      "action": "update.scheduled",
      "runId": "r-1793644200412-9c1e",
      "actor": { "id": "user-42", "label": "admin@example.com", "via": "api" },
      "target": "1.4.0",
      "details": {
        "mode": "image",
        "fromVersion": "1.3.2",
        "startsAt": "2026-11-02T18:35:00.412Z",
        "trustMode": "keyless",
        "releaseSha256": "2d711642b726b04401627ca9fbac32f5c8530fb1903cc4db02258717921a4881"
      }
    }
  ],
  "next": "001793644200412-000017",
  "gap": false
}
```

When no event is returned, `next` is `null`: keep your cursor. The sidecar keeps the newest
`state.eventLimit` events (default 500). See [journal ingestion](#journal-ingestion-exactly-once).

### `GET /v1/backups`

Metadata of the backups in the state volume, never their content.

```json
{
  "backups": [
    {
      "file": "notes-20261102-183512Z-1.3.2-to-1.4.0.pgdump",
      "bytes": 48213377,
      "sha256": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      "type": "postgres",
      "createdAt": "2026-11-02T18:35:12.000Z",
      "runId": "r-1793644200412-9c1e",
      "fromVersion": "1.3.2",
      "toVersion": "1.4.0",
      "verified": true,
      "encrypted": false,
      "protected": false
    }
  ]
}
```

`protected: true` marks the backup referenced by the newest `needs_attention` run;
retention never deletes it.

### `GET /v1/config`

The effective configuration with secret-bearing values redacted, and its hash. The same
hash is in `StateView.updater.configHash`, in every run (`configHash`) and in the output of
`cicd-updater config check`.

```json
{ "configHash": "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08", "config": { "version": 1, "...": "..." } }
```

### `GET /v1/openapi.json`

The OpenAPI 3.1 document of the running build, as JSON. It requires the token like
everything under `/v1`.

## Shared types

The [OpenAPI document](#openapi-document) is the exact reference; the shapes below are a
readable summary.

```ts
type StepId = "prepare" | "fetch" | "backup" | "stop" | "migrate" | "start" | "health" | "smoke" | "finish";
type StepStatus = "pending" | "running" | "done" | "failed" | "skipped";

interface Run {
  id: string;                              // r-<epoch ms>-<4 hex>
  mode: "image" | "source";
  fromVersion: string | null;
  targetVersion: string;
  targetTag: string;
  notesUrl: string | null;
  release: { sha256: string | null; channel: "stable" | "beta"; document: "verified" | "not_checked" };
  trustMode: "keyless" | "key" | "none";
  verification: {
    signatures: "verified" | "failed" | "not_checked" | "not_applicable" | null;  // not_applicable: source mode
    digests: "verified" | "failed" | "not_applicable" | null;
  };
  requestedBy: { id: string | null; label: string; via: "api" | "cli" | "system" };
  scheduledAt: string;
  startsAt: string;
  leadSeconds: number | null;              // null when scheduled with startsAt
  startedAt: string | null;
  finishedAt: string | null;
  cancelled: boolean;
  cancelledAt: string | null;
  abortRequestedAt: string | null;
  outcome: "succeeded" | "unchanged" | "rolled_back" | "needs_attention" | null;
  step: StepId | null;
  steps: { id: StepId; status: StepStatus; startedAt: string | null; finishedAt: string | null;
           detail: Record<string, string | number | boolean | null> }[];   // in execution order
  progress: number;                        // 0..100, never decreasing
  message: { code: string; params: Record<string, string | number> } | null;
  failure: { code: string; step: StepId | null; detail: string; schemaChanged: boolean | null } | null;
  recovery: Recovery | null;               // set when the outcome is needs_attention
  images: Record<string, string>;          // service -> image reference written
  configHash: string;
  log: string[];                           // <= 200 redacted lines "<ISO time> <text>"
}

type RunSummary = Omit<Run, "log">;

interface Recovery {
  backup: { file: string; bytes: number; sha256: string; type: string; encrypted: boolean } | null;
  fromVersion: string | null;
  previousImages: Record<string, string | null>;
  previousEnv: Record<string, { present: boolean; line: string | null }>;
  commands: string[];                      // rendered restore commands, for display
}

interface JournalEvent {
  id: string;                              // <15 digits>-<6 digits>, sortable
  at: string;
  action: "update.scheduled" | "update.rescheduled" | "update.cancelled" | "update.abort_requested"
        | "update.started" | "update.succeeded" | "update.failed" | "update.acknowledged";
  runId: string;
  actor: { id: string | null; label: string; via: "api" | "cli" | "system" };
  target: string;                          // the target version
  details: Record<string, unknown>;
}
```

`details` per action:

| Action | `details` |
| --- | --- |
| `update.scheduled` | `mode`, `fromVersion`, `startsAt`, `trustMode`, `releaseSha256` |
| `update.rescheduled` | `startsAt` |
| `update.cancelled` | none |
| `update.abort_requested` | `step` |
| `update.started` | `mode`, `fromVersion`, `trustMode`, `configHash` |
| `update.succeeded`, `update.failed` | `mode`, `outcome`, `failureCode`, `schemaChanged`, `fromVersion`, `targetVersion`, `trustMode`, `verification`, `backupFile`, `steps` (`{ id, status, durationMs }[]`) |
| `update.acknowledged` | none, or `implicit: true` when a new schedule acknowledged the run |

Treat `details` as open: new keys may appear in 1.x.

### Capabilities

```ts
interface Capabilities {
  ready: boolean;                          // no blockers
  blockers: { code: string; detail: string | null }[];
  warnings: { code: string; detail: string | null }[];
  docker: {
    serverVersion: string | null;
    apiVersion: string | null;
    architecture: "linux/amd64" | "linux/arm64" | null;
    imageStore: "classic" | "containerd" | null;
  };
  compose: { projectName: string; projectDir: string; files: string[]; envFile: string };
  backups: BackupInfo[];
  checkedAt: string;
}
```

Warning codes: `trust_mode_none`, `updater_image_not_digest_pinned`, `self_label_missing`,
`health_without_app_check`, `backup_none_with_probe`, `source_mode_enabled`. Show
`trust_mode_none` prominently: signatures are not checked on that installation.

[State machine](state-machine.md) lists every failure and message code;
[messages](sdk.md#messages) has their English and German texts.

## Journal ingestion (exactly once)

The sidecar records every action (scheduled, rescheduled, cancelled, abort requested,
started, succeeded, failed, acknowledged) as a journal event. Your app copies these events
into its own audit log. Do it with a cursor, so every event lands exactly once, even when
the app restarts in the middle of an update.

1. Store the id of the last event you wrote (the cursor) in your database. It starts empty.
2. Periodically call `GET /v1/events?after=<cursor>`: every 30 seconds while idle, every
   3 seconds while a run is scheduled or running.
3. For each returned event, in order, open **one** database transaction that writes the
   event into the audit log **and** sets the cursor to `event.id`. Commit.
4. Skip events whose id is not greater than the cursor (string comparison).
5. When a call returns `limit` events, call again right away; stop when it returns fewer.
6. When `gap` is `true`, events were lost (more than `state.eventLimit` events happened
   since the cursor, or the sidecar's state was reset). Record the gap in the audit log and
   continue with the returned events.

Because the audit entry and the cursor commit together, a crash between two events loses
nothing and duplicates nothing. Events recorded while your app was down (for example while
it was being replaced) are ingested when it is back. Event ids stay sortable and unique
across sidecar restarts, also when the clock steps back.

A unique index on the event id in the audit table adds a second safety net:

```sql
CREATE TABLE updater_journal_cursor (id int PRIMARY KEY, last_id text NOT NULL);
-- audit_log has UNIQUE (source, event_id); insert with ON CONFLICT DO NOTHING
```

The SDK implements this loop as [`syncJournal`](sdk.md#syncjournal);
[app integration](app-integration.md#2-audit-via-the-journal) has complete TypeScript and
Python code.

## OpenAPI document

- `openapi/updater-api.v1.yaml` in the repository is generated from the zod schemas in
  `packages/protocol` (the single source of truth). CI fails when the committed file differs
  from the generated one. Every GitHub release also ships it as an asset, covered by
  `SHA256SUMS`.
- `GET /v1/openapi.json` returns the same document of the running build.

Use it to generate a client in your language. Keep the generated client tolerant: accept
unknown fields and unknown enum values in responses. The document describes every endpoint
on this page except the maintenance page files, including the optional `requestedBy` of
reschedule, cancel and acknowledge (schemas `RescheduleRequest` and `RunActionRequest`).

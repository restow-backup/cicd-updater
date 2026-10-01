# SDK reference

`@restow-backup/cicd-updater` is the TypeScript package for the app's side of
cicd-updater. It contains:

- a client for the sidecar's [HTTP API](http-api.md) and exactly-once journal ingestion;
- a release feed check that cannot be turned into a tool for probing your internal network;
- a token verifier for your app's health endpoint;
- the protocol schemas and codes, SemVer helpers, and English and German texts for every
  code and for an admin "Updates" page;
- the maintenance banner's polling logic without a framework (`/maintenance`), and
  optional [React components](react.md) built on it.

Apps in other languages call the HTTP API directly; [app integration](app-integration.md)
shows both ways.

## Contents

- [Install](#install)
- [Entry points](#entry-points)
- [Client (`@restow-backup/cicd-updater`)](#client)
- [Feed check (`/feed`)](#feed-check)
- [Token verifier (`/auth`)](#token-verifier)
- [Protocol (`/protocol`)](#protocol)
- [SemVer (`/semver`)](#semver)
- [Messages (`/messages`)](#messages)
- [Maintenance polling (`/maintenance`)](#maintenance-polling)
- [Error handling](#error-handling)
- [Runtime requirements](#runtime-requirements)

## Install

The package is attached to every GitHub release of cicd-updater as a tarball. Install it
from there:

```sh
npm install https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/restow-backup-cicd-updater-1.0.0.tgz
```

The release also contains `SHA256SUMS` and its Sigstore bundle, which cover the
tarball.

Once the package is published to npm, install it by name:

```sh
npm install @restow-backup/cicd-updater@1.0.0
```

The package name inside the tarball is the npm name, so switching from the tarball to npm
changes only the install source, not a single import.

Package facts:

- ESM only, TypeScript declarations included.
- One runtime dependency: `zod`. All internal code of the repository is bundled.
- `react` (18 or newer) is an optional peer dependency, needed only for `/react`.
- `engines`: Node.js 22.12 or newer.

## Entry points

| Import | Runtime | Content |
| --- | --- | --- |
| `@restow-backup/cicd-updater` | Node.js | `createUpdaterClient`, `syncJournal`, `maintenanceViewOf`, `DEFAULT_LEAD_TIMES`, errors, API types |
| `@restow-backup/cicd-updater/feed` | Node.js | `checkFeed`, `FeedError` and the feed types |
| `@restow-backup/cicd-updater/auth` | Node.js | `createTokenVerifier` |
| `@restow-backup/cicd-updater/protocol` | any | zod schemas and types of every document, all codes, `progressOf`, `publicStatusOf`, catalogs |
| `@restow-backup/cicd-updater/semver` | any | `parseVersion`, `compareVersions`, `isNewer`, `channelAllows`, `satisfiesRange` and more |
| `@restow-backup/cicd-updater/messages` | any | `en` and `de` catalogs, `messagesFor`, `formatMessage`, `describeCode`, `interpolate`; the admin page texts `adminEn`, `adminDe`, `adminMessagesFor`, `formatLeadTime` |
| `@restow-backup/cicd-updater/maintenance` | any | `pollMaintenance`, `MaintenanceTracker`, `countdownOf`, `formatCountdown`, without React |
| `@restow-backup/cicd-updater/react` | browser | hooks and components, see [React](react.md) |

The server-side entry points (main, `/feed`, `/auth`) use `node:` modules and run only in
Node.js. The browser parts never talk to the sidecar.

## Client

```ts
import {
  createUpdaterClient,
  syncJournal,
  maintenanceViewOf,
  DEFAULT_LEAD_TIMES,
  UpdaterProblemError,
  UpdaterUnavailableError,
  type UpdaterClient,
  type UpdaterClientOptions,
  type UnavailableReason,
  type MaintenanceView,
  // API types: StateView, Run, RunSummary, Capabilities, ReleasesView, VerificationResult,
  // ScheduleRequest, EventsView, JournalEvent, BackupInfo, PublicStatus, Problem
} from "@restow-backup/cicd-updater";
```

### `createUpdaterClient`

```ts
function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient;

interface UpdaterClientOptions {
  url: string;
  token?: string;
  tokenFile?: string;
  timeoutMs?: number;
  stateTtlMs?: number;
  unavailableTtlMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  readFile?: (path: string) => Promise<string>;
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `url` | required | Base URL of the sidecar, for example `http://updater:8090`. A trailing slash is fine. An empty string disables the client: `state()` resolves `null`, every other method throws `UpdaterUnavailableError("disabled")`. |
| `token` | none | The token itself. Takes precedence over `tokenFile`. |
| `tokenFile` | none | Path of the shared token file, for example `/run/cicd-updater/token`. The content is trimmed, reused for 30 seconds, and re-read after a `401` (a reset volume gives a new token). |
| `timeoutMs` | `5000` | Request timeout. `releases()`, `verifyRelease()` and `schedule()` use the larger of this value and 120000. |
| `stateTtlMs` | `2000` | A successful `state()` result is reused for this long; concurrent calls share one request. |
| `unavailableTtlMs` | `8000` | "No sidecar answers" is remembered this long, so a page full of callers does not hammer a missing sidecar. |
| `fetch` | global `fetch` | Replacement transport, for tests. |
| `now`, `readFile` | none | Clock and file reader, for tests. |

Behaviour that is always on:

- The token is sent only to `url` and never follows a redirect (`redirect: "error"`).
- After a `401` with a `tokenFile`, the client re-reads the file and retries once. A second
  `401` throws `UpdaterUnavailableError("no_token")`.
- Every response is parsed with the protocol schemas. A response that does not match is
  `UpdaterUnavailableError("incompatible")`. The schemas accept unknown fields and treat
  codes as strings, so a newer 1.x sidecar parses fine.

### `UpdaterClient`

```ts
interface UpdaterClient {
  state(options?: { fresh?: boolean; refreshCapabilities?: boolean }): Promise<StateView | null>;
  capabilities(options?: { refresh?: boolean }): Promise<Capabilities>;
  releases(options?: { refresh?: boolean }): Promise<ReleasesView>;
  verifyRelease(version: string): Promise<VerificationResult>;
  schedule(request: ScheduleRequest): Promise<StateView>;
  reschedule(
    runId: string,
    when: { leadSeconds: number } | { startsAt: string | Date },
    requestedBy?: { id?: string | null; label: string },
  ): Promise<StateView>;
  cancel(runId: string, requestedBy?: { id?: string | null; label: string }): Promise<StateView>;
  acknowledge(runId: string, requestedBy?: { id?: string | null; label: string }): Promise<StateView>;
  run(runId: string): Promise<Run>;
  history(limit?: number): Promise<RunSummary[]>;
  events(after: string | null, limit?: number): Promise<EventsView>;
  backups(): Promise<BackupInfo[]>;
  publicStatus(): Promise<PublicStatus>;
}
```

| Method | HTTP call | Notes |
| --- | --- | --- |
| `state()` | `GET /v1/state` | Resolves `null` when no sidecar answers (see below). `fresh: true` skips the short cache. `refreshCapabilities: true` adds `?refresh=true` (recompute preflight and running version). |
| `capabilities()` | `GET /v1/capabilities` | `refresh: true` recomputes. |
| `releases()` | `GET /v1/releases` | `refresh: true` bypasses the sidecar's list cache. Long timeout. |
| `verifyRelease(version)` | `POST /v1/releases/{version}/verification` | Dry run, no pull. Long timeout. |
| `schedule(request)` | `POST /v1/runs` | Returns the new state. Long timeout. |
| `reschedule(runId, when, requestedBy?)` | `PATCH /v1/runs/{runId}` | `startsAt` may be a `Date`. |
| `cancel(runId, requestedBy?)` | `POST /v1/runs/{runId}/cancel` | Cancels a scheduled run or requests an abort. Tell them apart in the returned state: phase `idle` means cancelled, `run.abortRequestedAt` set means abort requested. |
| `acknowledge(runId, requestedBy?)` | `POST /v1/runs/{runId}/acknowledge` | Clears a finished run. |
| `run(runId)` | `GET /v1/runs/{runId}` | A history entry comes back with `log: []`. |
| `history(limit = 20)` | `GET /v1/runs?limit=` | `limit` 1 to 100. |
| `events(after, limit = 100)` | `GET /v1/events` | `limit` 1 to 500. Use `syncJournal` instead of calling this yourself. |
| `backups()` | `GET /v1/backups` | Metadata only. |
| `publicStatus()` | `GET /public/v1/status` | Public: sent without the token, works without one. |

`schedule`, `reschedule`, `cancel` and `acknowledge` also refresh the client's cached state.

`requestedBy` is recorded in the run and the journal. `id` is up to 200 characters (your
user id), `label` 1 to 200 characters (shown to people). Always pass it for actions a
person triggered; without it the sidecar records the label `api`.

#### What `state()` returns and throws

| Situation | Result |
| --- | --- |
| The sidecar answers with a valid state | the `StateView` |
| `url` is empty, no token, `401` after the re-read, connection refused, DNS failure, timeout, an error status without a problem document (for example `502` from a proxy) | `null` (remembered for `unavailableTtlMs`) |
| The answer does not parse, or `404` without a problem document | throws `UpdaterUnavailableError("incompatible")` (also remembered) |
| The sidecar answers with a problem document (for example `500 internal`) | throws `UpdaterProblemError` |

"No sidecar" is a normal result because the sidecar is opt-in. Treat `null` as "updates
through the app are not available here" and show manual update instructions.

### Errors

```ts
class UpdaterUnavailableError extends Error {
  readonly reason: "disabled" | "no_token" | "unreachable" | "timeout" | "incompatible";
}

class UpdaterProblemError extends Error {
  readonly status: number;     // HTTP status
  readonly code: string;       // problem code, e.g. "blocked"
  readonly problem: Problem;   // the full problem document with its extensions
}
```

| `reason` | Cause |
| --- | --- |
| `disabled` | `url` is empty |
| `no_token` | no `token` given and the token file is missing, empty or unreadable; or the sidecar answered `401` (after one re-read of the file) |
| `unreachable` | the connection failed, a redirect was refused, or the sidecar answered an error status without a problem document (other than `404`) |
| `timeout` | no answer within the timeout |
| `incompatible` | the response does not match the 1.x schemas, or `404` without a problem document: the sidecar speaks another major version of the API. Align the versions of SDK and sidecar |

`UpdaterProblemError.message` is the problem's `detail` (or its `title`). Branch on `code`
and read the extensions from `problem`: `problem.blockers`, `problem.reasons`,
`problem.checks`, `problem.feedError`, `problem.errors`. The [HTTP API](http-api.md#errors)
lists every code. `401` never becomes an `UpdaterProblemError`; it is `no_token`.

### `syncJournal`

Exactly-once ingestion of the sidecar's journal into your audit log
([how it works](http-api.md#journal-ingestion-exactly-once)).

```ts
function syncJournal(options: {
  client: UpdaterClient;
  loadCursor(): Promise<string | null>;
  /** Write the event to the audit log AND store event.id as the cursor, in one transaction. */
  ingest(event: JournalEvent): Promise<void>;
  /** Events older than the sidecar keeps were lost (state.eventLimit). */
  onGap?(info: { after: string | null }): Promise<void>;
  /** Events per request, 1 to 500 (default 100). */
  batchSize?: number;
}): Promise<{ ingested: number; gap: boolean }>;
```

Each round calls `loadCursor()`, fetches the events after it, calls `onGap` once if the
sidecar reports a gap, and calls `ingest` for every event whose id is greater than the
cursor, in order. It stops when a round returns fewer than `batchSize` events (and after at
most 1000 rounds per call). An error from the client or from `ingest` rejects the promise;
the cursor stays at the last committed event, so the next call resumes there.

Call it every 30 seconds while idle and every 3 seconds while a run is scheduled or running.
It throws `UpdaterUnavailableError` like every client method when no sidecar answers, so
check `await client.state()` first or catch the error. A complete example is in
[app integration](app-integration.md#2-audit-via-the-journal).

### `maintenanceViewOf`

```ts
type MaintenanceView = PublicStatus;
function maintenanceViewOf(state: StateView | null, now?: Date): MaintenanceView;
```

Builds the document your app's own maintenance endpoint returns to every signed-in user:
the shape of the [public status](http-api.md#get-publicv1status) plus `targetVersion` and
`fromVersion`, and run messages with their `version` parameter. With `state === null` (no
sidecar) it returns the idle document. The [React hook](react.md) consumes it.

```ts
// GET /api/maintenance, readable by every signed-in user
const view = maintenanceViewOf(await updater.state().catch(() => null));
```

### `DEFAULT_LEAD_TIMES`

```ts
const DEFAULT_LEAD_TIMES: readonly number[]; // [0, 60, 300, 900, 1800, 3600] seconds
```

Suggested lead times for a schedule form: now, 1, 5, 15, 30 and 60 minutes.

## Feed check

```ts
import {
  checkFeed,
  FeedError,
  type FeedCheckOptions,
  type FeedCheckResult,
  type FeedRelease,
  type FeedRefusal,
} from "@restow-backup/cicd-updater/feed";
```

Your app can tell admins that an update exists even when no sidecar runs. Because the feed
URL may come from an admin, `checkFeed` reads it over a guarded connection: it refuses to
contact private, loopback and link-local addresses, so it cannot be used to probe your
internal network. The sidecar does not need this function; it reads its own feed.

```ts
function checkFeed(options: FeedCheckOptions): Promise<FeedCheckResult>;

interface FeedCheckOptions {
  feed: { type: "github" | "gitea" | "gitlab" | "static"; url: string };
  token?: string | null;
  channel: "stable" | "beta";
  running: string | null;
  tagPattern?: string;
  allowPrivateHosts?: string[];
  resolveDocuments?: number;
  timeoutMs?: number;
  now?: () => Date;
}
```

| Option | Default | Meaning |
| --- | --- | --- |
| `feed.type`, `feed.url` | required | `github`: `https://github.com/<owner>/<repo>`. `gitea` (Forgejo and Gitea): `https://<host>[/<prefix>]/<owner>/<repo>`. `gitlab`: `https://<host>/<group>[/<subgroup>...]/<project>`. `static`: the URL of a feed index. The `file` feed of the sidecar is not available here. [Feeds](feeds.md) describes each provider. |
| `token` | `null` | Token for a private repository. Sent only as a header to the feed's own origin (`Authorization: token <t>` for Forgejo/Gitea, `Bearer <t>` otherwise; for GitHub the origin is `https://api.github.com`). Dropped for good at the first redirect to another origin. |
| `channel` | required | `stable` offers releases only, `beta` also pre-releases. |
| `running` | required | Your app's own version, or `null`. A string that is not a version counts as `null`. |
| `tagPattern` | `v{version}` | How tags are made from versions; must match the release side. |
| `allowPrivateHosts` | `[]` | Host names (exact, lowercase) that may resolve to private or loopback addresses, for an internal Forgejo for example. An operator decision, not an admin input. |
| `resolveDocuments` | `10` | For how many of the newest newer releases `release.json` is downloaded (0 to 10). |
| `timeoutMs` | `10000` | Timeout of the release list request. Each asset has 15000. |
| `now` | `() => new Date()` | Clock, for `checkedAt` and `retryAt`. |

```ts
type FeedCheckResult =
  | { ok: true; checkedAt: string; releases: FeedRelease[]; latest: FeedRelease | null;
      updateAvailable: boolean | null; nextInstallable: FeedRelease | null }
  | { ok: false; checkedAt: string; error: FeedError };

interface FeedRelease {
  version: string;
  tag: string;
  channel: "stable" | "beta";
  publishedAt: string | null;
  notesUrl: string | null;
  document: ReleaseDocument | null;   // parsed release.json, NOT signature-verified
  documentSha256: string | null;      // pass as expect.releaseSha256 when scheduling
  refusals: FeedRefusal[];
}

type FeedRefusal = "no_release_document" | "below_minimum_version" | "manual_steps_required" | "not_newer";
```

`checkFeed` does not throw; failures come back as `{ ok: false, error }`.

How the result is built:

1. The release list is read. Drafts and tags that do not render from a version through
   `tagPattern` are dropped. An empty feed is the error `no_release`.
2. With `channel: "stable"`, releases flagged as pre-release by the provider (or with a
   pre-release version) are dropped. The newest 10 remain, newest first.
3. Releases not newer than `running` get the refusal `not_newer` and no document.
4. For the newest newer releases (up to `resolveDocuments`), `release.json` is downloaded
   (at most 64 KiB) and validated. A missing, invalid or mismatching document gives
   `no_release_document`. A valid document decides the channel; a pre-release document on
   the stable channel drops the release. Then `below_minimum_version` (running is below
   `upgrade.minimumFromVersion`) and `manual_steps_required` are added.
5. `latest` is the first release of the list (it may carry `not_newer`).
   `updateAvailable` is `null` when `running` is unknown, otherwise whether any release is
   newer. `nextInstallable` is the newest release with a document and no refusal.

A download error of a `release.json` (for example a `404` from the release host) fails the
whole check with that error.

If the newest release is refused with `below_minimum_version`, show the path: install
`nextInstallable` first, then the newest.

The documents are parsed but **not** signature-verified. Use them to inform admins. The
sidecar verifies before it installs anything, and `documentSha256` passed as
`expect.releaseSha256` makes sure it installs exactly the document the admin saw.

### `FeedError`

```ts
class FeedError extends Error {
  readonly code: FeedErrorCode;
  readonly status: number | null;     // HTTP status when there was one
  readonly retryAt: string | null;    // rate_limited: from Retry-After or X-RateLimit-Reset
  readonly detail: string | null;
}
```

| `code` | Meaning |
| --- | --- |
| `rate_limited` | `429`, or `403` with `X-RateLimit-Remaining: 0`; respect `retryAt` |
| `unauthorized` | `401`: the token was refused |
| `forbidden` | `403` |
| `not_found` | `404`; for a private repository this usually means the token has no access |
| `server_error` | `5xx` |
| `network` | connection, DNS or refused address; deliberately without detail, except for TLS errors of a host that answered (`detail` such as `CERT_HAS_EXPIRED`) |
| `timeout` | no answer in time |
| `invalid_response` | `detail`: `not_json`, `too_large`, `schema`, `status` (unexpected status), or the reason a feed URL does not fit its provider |
| `no_release` | the feed lists no release |
| `redirect` | a redirect that is not allowed (another origin for the list, more than 3, not https) |

### Network rules

These hold for every request `checkFeed` makes:

1. **https only.** The feed URL must not contain credentials. The token travels only as a
   header.
2. **Public addresses only.** The host name is resolved inside the socket's own lookup, and
   the connection is refused unless every resolved address is public. The checked address
   is the connected address, which defeats DNS rebinding. There is no connection pooling.
   - Refused IPv4: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`,
     `192.0.0/24`, `192.0.2/24`, `192.88.99/24`, `192.168/16`, `198.18/15`,
     `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`.
   - Refused IPv6: `::`, `::1`, link-local `fe80::/10`, unique local `fc00::/7`, site-local
     `fec0::/10`, multicast `ff00::/8`, `2001::/32`, `2001:db8::/32`, and everything outside
     `2000::/3`. IPv4-mapped, IPv4-compatible, NAT64 (`64:ff9b::/96`) and 6to4 (`2002::/16`)
     addresses are judged by their embedded IPv4 address.
   - Names that only exist locally are refused without asking DNS: `localhost`, single-label
     names, and names ending in `.localhost`, `.local`, `.internal`, `.intranet`, `.lan`,
     `.home`, `.home.arpa` or `.localdomain`.
   - Hosts in `allowPrivateHosts` may resolve to private and loopback addresses, never to
     link-local (cloud metadata), multicast or reserved ones.
3. **Redirects by hand.** At most 3, https only. The release list follows only redirects to
   the same origin. Asset downloads may follow a redirect to another origin (GitHub serves
   assets from a CDN), but the `Authorization` header is dropped at the first origin change
   and never added again. Every new host passes rule 2.
4. **Size caps.** Bodies are read as streams and abandoned past the cap: 8 MiB for the
   release list, 64 KiB for `release.json`. A larger declared `Content-Length` is refused at
   once.
5. **No information leak.** A refused address, a DNS failure and a failed connection all
   yield `network` without detail, so the result does not tell what exists behind a name.
6. **Nothing about the installation is sent.** No version in the URL, and a fixed
   `User-Agent: cicd-updater-feed/1`.

## Token verifier

```ts
import { createTokenVerifier } from "@restow-backup/cicd-updater/auth";

function createTokenVerifier(options: {
  tokenFile: string;          // the shared token file, mounted read-only into the app
  ttlMs?: number;             // how long the file content is reused (default 30000)
}): {
  isUpdater(authorizationHeader: string | null | undefined): Promise<boolean>;
};
```

`isUpdater` checks whether a request carries `Authorization: Bearer <token>` with the
sidecar's token. Both values are hashed with SHA-256 and compared in constant time. A
missing or unreadable token file makes every check `false`.

Use it in your health endpoint: always answer readiness, and add the version only for the
sidecar. A public version number tells an attacker which known vulnerability is still open.

```ts
const verifier = createTokenVerifier({ tokenFile: "/run/cicd-updater/token" });

// GET /healthz
const body: Record<string, unknown> = { status: "ok" };
if (await verifier.isUpdater(request.headers.authorization)) {
  body.version = APP_VERSION;
}
```

Configure the sidecar to send the token and read the version
(`hooks.health.http.sendToken: true`, `versionJsonPath: $.version`; see [hooks](hooks.md)).

## Protocol

```ts
import { stateViewSchema, PROBLEM_STATUS, type StateView } from "@restow-backup/cicd-updater/protocol";
```

Everything the repository's protocol package exports, in any runtime:

| Group | Exports (selection) |
| --- | --- |
| API schemas and types | `stateViewSchema`, `capabilitiesSchema`, `releasesViewSchema`, `verificationResultSchema`, `eventsViewSchema`, `runsViewSchema`, `backupsViewSchema`, `configViewSchema`, `publicStatusSchema`, `problemSchema`, `scheduleRequestSchema`, `rescheduleRequestSchema`, `runActionRequestSchema`, `requestedBySchema`, and the matching types |
| Runs and journal | `runSchema`, `runSummarySchema`, `journalEventSchema`, `messageSchema`, `stepSchema`, `failureSchema`, `recoverySchema`, `Run`, `RunSummary`, `JournalEvent` |
| Codes | `STEP_IDS`, `STEP_WEIGHTS`, `PHASES`, `OUTCOMES`, `FAILURE_CODES`, `BLOCKER_CODES`, `WARNING_CODES`, `MESSAGE_CODES`, `REFUSAL_CODES`, `JOURNAL_ACTIONS`, `FEED_ERROR_CODES`, `PROBLEM_STATUS`, `PROBLEM_CODES`, `problemType(code)`, `API_FEATURES`, `API_VERSION`, `DEFAULT_LEAD_TIMES`, `isFailureCode`, `stepOfFailure` |
| Progress and public view | `progressOf(steps)`, `stepOrder(quiesce)`, `publicStatusOf(phase, run, now, showVersions)`, `idlePublicStatus(now)` |
| Release documents | `releaseDocumentSchema`, `ReleaseDocument`, `parseReleaseDocument(bytes, options)`, `RELEASE_DOCUMENT_NAME`, `RELEASE_BUNDLE_NAME`, size limits, `releaseJsonSchema` |
| Feed index | `feedIndexSchema`, `FeedIndex` |
| Configuration | `configSchema`, `validateConfig`, `UpdaterConfig`, `applyEnvOverrides`, `envNameOf` |
| Tags and identities | `DEFAULT_TAG_PATTERN`, `renderTag`, `versionFromTag`, `keylessIdentity`, `describeKeyless` |
| Generators | `jsonSchemas()`, `openApiDocument()` |

The SemVer and message exports below are also part of `/protocol`.

`API_VERSION` is the version this build speaks (`"1.0"`). Do not compare it for equality
with `StateView.api.version`: any `1.x` sidecar is compatible; use `api.features` to detect
optional capabilities.

## SemVer

```ts
import { compareVersions, isNewer, satisfiesRange } from "@restow-backup/cicd-updater/semver";
```

SemVer 2.0.0 precedence. Input may carry a leading `v` and build metadata; both are ignored
for comparison. A target version (what `release.json` names and what you schedule) is a
plain version: no `v`, no build metadata.

| Function | Meaning |
| --- | --- |
| `parseVersion(value): SemVer \| null` | `{ major, minor, patch, prerelease: string[] }` or `null` |
| `compareVersions(a, b): number` | negative when `a` is older; throws `TypeError` for non-versions |
| `isNewer(running, candidate): boolean \| null` | strictly newer; `null` when either is not a version |
| `sameVersion(a, b): boolean` | same precedence (`v1.2.3` equals `1.2.3+build`) |
| `normalizeVersion(value): string \| null` | plain form (`v1.2.3+meta` to `1.2.3`) |
| `isPlainVersion(value): boolean` | valid target version |
| `isPrerelease(value): boolean` | has a pre-release part |
| `channelOf(version): "stable" \| "beta"` | `beta` exactly when it has a pre-release part |
| `channelAllows(channel, version): boolean` | `stable` offers releases only, `beta` both |
| `satisfiesRange(version, range): boolean` | `>=X.Y.Z`, `^X.Y.Z` (below the next major; for `0.y` below the next minor) or exact `X.Y.Z` |
| `sortVersionsDescending(versions): string[]` | newest first, duplicates and non-versions removed |

## Messages

```ts
import { messagesFor, formatMessage, describeCode, en, de } from "@restow-backup/cicd-updater/messages";
```

The sidecar never sends prose to clients, only codes with parameters. These catalogs turn
codes into English and German text.

| Export | Meaning |
| --- | --- |
| `en`, `de` | catalogs of type `Messages` |
| `catalogs` | `{ en, de }` |
| `messagesFor(locale)` | the catalog for a locale (`de-DE` gives `de`), English when there is none |
| `formatMessage(messages, message)` | text of a run message `{ code, params }`; `""` for `null` |
| `describeCode(messages, kind, code)` | text of a code; `kind` is `failures`, `blockers`, `warnings`, `refusals`, `problems`, `feedErrors`, `steps`, `outcomes` or `phases` |
| `interpolate(template, params)` | replaces `{name}` placeholders; unknown placeholders stay as they are |

`Messages` has the tables `phases`, `outcomes`, `steps`, `messages`, `failures`,
`blockers`, `warnings`, `refusals`, `problems`, `feedErrors` and the UI strings in `ui`
(see [React](react.md#internationalisation)). Unknown codes never throw: they render as
`ui.unknownCode` (`Status code {code}`), because a newer sidecar may send codes this catalog
does not know.

```ts
const t = messagesFor(user.locale); // "de", "de-DE", "en", ...
describeCode(t, "blockers", "docker_unreachable"); // "Docker is not reachable."
describeCode(t, "failures", "fetch.some_new_code"); // "Status code fetch.some_new_code"
formatMessage(t, { code: "run.scheduled", params: { version: "1.4.0", startsAt: "2026-11-02T18:35:00Z" } });
```

`messagesFor` takes the first language of a plain tag. For a full `Accept-Language` header,
pick the language first.

### Texts of an admin "Updates" page

```ts
import { adminMessagesFor, formatLeadTime, interpolate } from "@restow-backup/cicd-updater/messages";
```

The sentences an admin page needs besides the codes: headings, buttons, the
`needs_attention` guidance, the schedule form and its lead times. The page of the
[web app template](../templates/web-app/frontend/react/UpdatesPage.tsx) and its
[vanilla widget](../templates/web-app/frontend/vanilla/updates-widget.js) use them.

| Export | Meaning |
| --- | --- |
| `adminEn`, `adminDe` | texts of type `AdminMessages` |
| `adminCatalogs` | `{ en: adminEn, de: adminDe }` |
| `adminMessagesFor(locale)` | as `messagesFor`, for the admin texts |
| `formatLeadTime(texts, seconds)` | `0` gives "now", `300` "in 5 minutes", `3600` "in 1 hour" |

Texts with parameters use `{name}` placeholders: `versions` (`{from}`, `{to}`),
`requestedBy` (`{label}`), `attentionBackup` (`{file}`), `releaseDigest` (`{sha}`),
`scheduled` (`{version}`), `leadTimeMinutes` and `leadTimeHours` (`{count}`). Fill them with
`interpolate`:

```ts
const texts = adminMessagesFor(user.locale);
interpolate(texts.versions, { from: run.fromVersion ?? texts.unknownVersion, to: run.targetVersion });
```

For another language, write an object of type `AdminMessages` (start from a copy of
`adminEn`). New texts may be added in 1.x minor releases; a custom object then fails to
type-check until it has them, which is the reminder to translate them.

## Maintenance polling

```ts
import { pollMaintenance, formatCountdown } from "@restow-backup/cicd-updater/maintenance";
```

The maintenance banner's logic without React, for Vue, Svelte, plain DOM or any runtime with
`fetch` and timers. [React](react.md) builds its hook on it, and `/react` re-exports
everything listed here.

```ts
const stop = pollMaintenance({
  fetchMaintenance: () => fetch("/api/maintenance").then((r) => {
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  }),
  // While the app is down for the update: the sidecar's public status through your edge.
  fetchPublicStatus: () => fetch("/public/v1/status").then((r) => (r.ok ? r.json() : null)),
  onChange: (snapshot) => render(snapshot), // phase, view, countdownSeconds, offsetMs, apiReachable
});
// later: stop();
```

| Option | Default | Meaning |
| --- | --- | --- |
| `fetchMaintenance` | required | the app's own maintenance endpoint; a rejection means "the app does not answer" |
| `fetchPublicStatus` | none | used while `fetchMaintenance` fails |
| `onChange(snapshot)` | required | called after every poll |
| `idlePollMs`, `activePollMs` | `30000`, `2000` | interval while idle, and while a run is scheduled or running or the app is down |
| `onReload` | `location.reload()` | called 2.5 seconds after a run this page saw running succeeded, once |

The function returns `stop()`, which ends polling and drops a pending reload.
`MaintenanceTracker`, `countdownOf` and `formatCountdown` are the same as in
[React](react.md#maintenancetracker). A countdown that ticks every second belongs outside any
`aria-live` region; announce only phase changes.

## Error handling

### No sidecar is a normal state

```ts
const state = await updater.state();
if (state === null) {
  return { updates: "manual" }; // show the manual update steps
}
```

### Branch on problem codes

```ts
import { UpdaterProblemError, UpdaterUnavailableError } from "@restow-backup/cicd-updater";
import { describeCode, messagesFor } from "@restow-backup/cicd-updater/messages";

try {
  await updater.schedule({
    version,
    leadSeconds: 300,
    requestedBy: { id: user.id, label: user.email },
    expect: { releaseSha256 },
  });
} catch (error) {
  if (error instanceof UpdaterProblemError) {
    const t = messagesFor(user.locale);
    switch (error.code) {
      case "blocked":
        return conflict(error.problem.blockers?.map((b) => describeCode(t, "blockers", b.code)));
      case "release_refused":
        return conflict(error.problem.reasons?.map((r) => describeCode(t, "refusals", r)));
      case "release_mismatch":
        return conflict("The release changed since you looked at it. Reload and check again.");
      case "busy":
        return conflict(describeCode(t, "problems", "busy"));
      default:
        return conflict(describeCode(t, "problems", error.code)); // also unknown codes
    }
  }
  if (error instanceof UpdaterUnavailableError) {
    return unavailable(error.reason); // e.g. 503 to your admin UI
  }
  throw error;
}
```

Keep the sidecar's status when you pass a problem on to your own UI (`409` stays `409`),
and map `UpdaterUnavailableError` to `503`.

### Incompatible versions

`UpdaterUnavailableError("incompatible")` means SDK and sidecar do not speak the same major
API version. Log it for the operator and tell admins to align the versions
([upgrading the updater](upgrading-the-updater.md)).

### Feed errors

```ts
const result = await checkFeed({ feed, token, channel: "stable", running: APP_VERSION });
if (!result.ok) {
  const retryAt = result.error.retryAt ? Date.parse(result.error.retryAt) : 0;
  nextCheck = Math.max(Date.now() + 3600_000, retryAt); // retry after one hour at the earliest
}
```

For `not_found` on a private repository, tell the admin that the token probably has no
access to the repository.

## Runtime requirements

| Entry point | Node.js 22, 24 | Bun, Deno | Browsers |
| --- | --- | --- | --- |
| main (`createUpdaterClient`, `syncJournal`, `maintenanceViewOf`) | Tested | untested | no |
| `/feed` | Tested | unsupported: needs Node's `net` lookup hook | no |
| `/auth` | Tested | untested | no |
| `/protocol`, `/semver`, `/messages` | Tested | Expected | yes |
| `/react` | not applicable | not applicable | yes, React 18 or newer |

The server-side parts need Node.js 22 or newer (`engines`: `>=22.12`). See
[compatibility](compatibility.md) for the tested matrix.

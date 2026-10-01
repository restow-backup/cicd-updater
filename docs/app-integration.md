# App integration

The sidecar installs signed releases, backs up, rolls back when it is certain, and reports.
It cannot know your users, your roles or your audit log. This page covers what stays your
app's job and how to do it, with code for TypeScript (using the [SDK](sdk.md)) and for
Python (calling the [HTTP API](http-api.md) with `httpx`). The code follows the two
examples in the repository: `examples/node-postgres` (TypeScript) and
`examples/python-postgres` (Python, FastAPI).

If you cannot change the app at all, you can still use the CLI and the sidecar's own
maintenance page ([getting started](getting-started.md), integration level 1).

## Contents

- [The app's jobs](#the-apps-jobs)
- [Wiring](#wiring)
- [Client code](#client-code)
- [1. Authorization and step-up](#1-authorization-and-step-up)
- [2. Audit via the journal](#2-audit-via-the-journal)
- [3. Feed settings and token storage](#3-feed-settings-and-token-storage)
- [4. Update notification](#4-update-notification)
- [5. Maintenance banner endpoint](#5-maintenance-banner-endpoint)
- [6. Health with version for the updater only](#6-health-with-version-for-the-updater-only)
- [7. Demo and read-only installations](#7-demo-and-read-only-installations)
- [8. Manual updates stay possible](#8-manual-updates-stay-possible)
- [Checklist](#checklist)

## The app's jobs

| Job | Why the app | Pattern |
| --- | --- | --- |
| Authorization | only the app knows users and roles | only an installation-level admin may schedule, reschedule, cancel and acknowledge; reading the update state may be broader |
| Step-up | scheduling decides what code runs next to the Docker socket | require a sign-in younger than 10 minutes with a strong method (passkey, password plus TOTP, OIDC) for scheduling and for changing the feed or its token; impersonated sessions never count |
| Audit log | the sidecar has no database | ingest the sidecar's journal exactly once; audit feed checks and settings changes yourself |
| Feed settings and token storage | secrets belong in the app's secret store | store a private feed token encrypted and bound to its origin; changing the origin deletes the token; never return it |
| Update notification | user-facing | check once a day; notify once per version, with a claim written in the same transaction as the notification |
| Maintenance banner | user-facing | an endpoint every signed-in user may read; the browser polls it and falls back to the public status while the app is down |
| Health with version | only the app knows its version | answer readiness to everyone, add the version only for the sidecar's token |
| Demo or read-only installations | product policy | do not configure a sidecar; show the manual update steps |

## Wiring

The sidecar writes a token into its shared volume. Mount that volume **read-only** into
your app's backend service, and only there:

```yaml
services:
  api:
    image: ${APP_IMAGE:?set APP_IMAGE in .env}
    environment:
      UPDATER_URL: ${UPDATER_URL-http://updater:8090} # set empty in .env (UPDATER_URL=): in-app updates off
      UPDATER_TOKEN_FILE: /run/cicd-updater/token
    volumes:
      - updater-shared:/run/cicd-updater:ro   # the shared token, read-only
    networks: [internal]

  updater:
    profiles: ["updater"]                      # opt-in
    volumes:
      - updater-shared:/shared
      # ... see getting-started.md for the complete service
```

- The generated token file is mode `0640`, owner root, group `auth.tokenGroupId` (default
  `0`). If your app runs as a non-root user, set `auth.tokenGroupId` in `updater.yaml` to
  the group id of that user, and give the user a fixed group id in your Dockerfile (for
  example `groupadd --gid 10001 app && useradd --uid 10001 --gid 10001 app`). Otherwise the
  app cannot read the token and every call reports "no sidecar".
- Every container that can read the token can schedule updates. Do not mount it into
  workers, the edge or other services.
- The app must not have write access to the project directory: `updater.yaml` and its
  hooks are the operator's, and they run next to the Docker socket.
- The app must keep working when the sidecar is not running and the token file does not
  exist. The sidecar is opt-in.

In `updater.yaml`, let the health check send the token and read the version:

```yaml
hooks:
  health:
    type: http
    http:
      url: http://api:3000/healthz
      sendToken: true          # the default
      versionJsonPath: $.version
```

## Client code

The later sections use these helpers. Names that this page does not define (`Session`,
`current_session`, `audit`, `loadFeedSettings`, `encryptSecret`, `pool`, `engine` and
similar) stand for your app's own code.

TypeScript (`@restow-backup/cicd-updater`):

```ts
import { createUpdaterClient, UpdaterProblemError, UpdaterUnavailableError } from "@restow-backup/cicd-updater";

export const updater = createUpdaterClient({
  url: process.env.UPDATER_URL ?? "",          // empty: no sidecar on this installation
  tokenFile: process.env.UPDATER_TOKEN_FILE ?? "/run/cicd-updater/token",
});

/** Pass sidecar problems on with their status and code; "no sidecar" is 503. */
export function updaterErrorResponse(error: unknown): { status: number; body: unknown } {
  if (error instanceof UpdaterProblemError) {
    return { status: error.status, body: { code: error.code, problem: error.problem } };
  }
  if (error instanceof UpdaterUnavailableError) {
    return { status: 503, body: { code: "updater_unavailable", reason: error.reason } };
  }
  throw error;
}
```

Python (`httpx`):

```python
import os
from pathlib import Path

import httpx

UPDATER_URL = os.environ.get("UPDATER_URL", "").rstrip("/")
TOKEN_FILE = Path(os.environ.get("UPDATER_TOKEN_FILE", "/run/cicd-updater/token"))


class UpdaterUnavailable(Exception):
    """No sidecar answered: not configured, no token, unreachable, or the token was refused."""


class UpdaterProblem(Exception):
    """The sidecar answered with an RFC 9457 problem document."""

    def __init__(self, status: int, problem: dict):
        super().__init__(problem.get("detail") or problem.get("title") or str(status))
        self.status = status
        self.code = problem.get("code", "unknown")
        self.problem = problem


def updater_token() -> str | None:
    # Read on every call: a reset volume gives the sidecar a new token.
    try:
        return TOKEN_FILE.read_text().strip() or None
    except OSError:
        return None


async def sidecar(method: str, path: str, body: dict | None = None, timeout: float = 5) -> dict:
    token = updater_token()
    if not UPDATER_URL or not token:
        raise UpdaterUnavailable()
    try:
        # The token never follows a redirect.
        async with httpx.AsyncClient(timeout=timeout, follow_redirects=False) as client:
            response = await client.request(
                method, f"{UPDATER_URL}{path}", json=body,
                headers={"authorization": f"Bearer {token}"},
            )
    except httpx.HTTPError as error:
        raise UpdaterUnavailable() from error
    if response.is_success:
        return response.json()
    if response.status_code != 401 and response.headers.get("content-type", "").startswith(
        "application/problem+json"
    ):
        raise UpdaterProblem(response.status_code, response.json())
    raise UpdaterUnavailable()
```

Use a timeout of 120 seconds for scheduling, verification and the release list: the sidecar
contacts the release host, the registry and, in keyless mode, Sigstore before it answers.

## 1. Authorization and step-up

The sidecar trusts whoever holds the token, so your app is the only place that decides who
may act. Recommended rules:

| Action | Who | Step-up |
| --- | --- | --- |
| read the update state, releases, history | admins (the banner endpoint in section 5 is for everyone) | no |
| verify a release (dry run) | installation admin | no |
| schedule | installation admin | yes: strong sign-in younger than 10 minutes |
| reschedule, cancel, acknowledge | installation admin | no |
| change the feed, the channel or the feed token | installation admin | yes |

- Use an installation-level admin role, not a tenant or project admin, if your app has
  tenants: an update affects everyone.
- An impersonated session (support staff acting as a user) never counts, neither for the
  role nor for step-up.
- When step-up is missing, answer with a problem your UI turns into a "confirm it is you"
  dialog, then retry the request.
- Pass the acting user as `requestedBy` on every action. The sidecar records it in the run
  and the journal, so your audit log shows who did what.
- Send `expect.releaseSha256` with the hash the admin was shown, so the sidecar refuses if
  the release document changed in between (`409 release_mismatch`).

TypeScript (framework-neutral; `Session` and the role names are your app's):

```ts
import { updater, updaterErrorResponse } from "./updater.js";

const STEP_UP_MS = 10 * 60_000;

class Forbidden extends Error {
  constructor(readonly code: "forbidden" | "step_up_required") { super(code); }
}

function assertUpdateAdmin(session: Session, options: { stepUp: boolean }): void {
  if (session.impersonatorId !== null || !session.user.roles.includes("installation_admin")) {
    throw new Forbidden("forbidden");
  }
  if (options.stepUp) {
    const at = session.strongAuthenticatedAt?.getTime() ?? 0;   // passkey, password + TOTP, OIDC
    if (Date.now() - at > STEP_UP_MS) throw new Forbidden("step_up_required");
  }
}

const actorOf = (session: Session) => ({ id: session.user.id, label: session.user.email });

// GET /api/admin/updates
export async function getUpdates(session: Session) {
  assertUpdateAdmin(session, { stepUp: false });
  const state = await updater.state({ fresh: true });
  const releases = state ? await updater.releases().catch(() => null) : null;
  return { state, releases };   // state === null: no sidecar, show manual steps
}

// POST /api/admin/releases/:version/verification
export async function verifyUpdate(session: Session, version: string) {
  assertUpdateAdmin(session, { stepUp: false });
  return await updater.verifyRelease(version);   // show release.sha256, manualSteps, images
}

// POST /api/admin/updates  { version, leadSeconds | startsAt, releaseSha256 }
export async function scheduleUpdate(
  session: Session,
  input: { version: string; leadSeconds?: number; startsAt?: string; releaseSha256: string },
) {
  assertUpdateAdmin(session, { stepUp: true });
  return await updater.schedule({
    version: input.version,
    ...(input.startsAt ? { startsAt: input.startsAt } : { leadSeconds: input.leadSeconds ?? 300 }),
    requestedBy: actorOf(session),
    expect: { releaseSha256: input.releaseSha256 },   // what the admin saw is what gets installed
  });
}

// PATCH /api/admin/updates/:runId, POST .../cancel, POST .../acknowledge
export async function rescheduleUpdate(session: Session, runId: string, leadSeconds: number) {
  assertUpdateAdmin(session, { stepUp: false });
  return await updater.reschedule(runId, { leadSeconds }, actorOf(session));
}
export async function cancelUpdate(session: Session, runId: string) {
  assertUpdateAdmin(session, { stepUp: false });
  return await updater.cancel(runId, actorOf(session));   // abort before the point of no return
}
export async function acknowledgeUpdate(session: Session, runId: string) {
  assertUpdateAdmin(session, { stepUp: false });
  return await updater.acknowledge(runId, actorOf(session));
}
```

In your HTTP layer, map `Forbidden` to `403` with its code, and every other error through
`updaterErrorResponse` (a `409 blocked` from the sidecar stays a `409` with its
`blockers`). [SDK error handling](sdk.md#error-handling) shows how to turn codes into text.

Python (FastAPI; `current_session` and the session fields are your app's):

```python
from datetime import datetime, timedelta, timezone

from fastapi import Depends, FastAPI, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel

app = FastAPI()
STEP_UP = timedelta(minutes=10)


def update_admin(session=Depends(current_session)):
    if session.impersonator_id is not None or "installation_admin" not in session.user.roles:
        raise HTTPException(status_code=403, detail="forbidden")
    return session


def update_admin_with_step_up(session=Depends(update_admin)):
    at = session.strong_authenticated_at   # passkey, password + TOTP, OIDC
    if at is None or datetime.now(timezone.utc) - at > STEP_UP:
        raise HTTPException(status_code=403, detail="step_up_required")
    return session


def actor(session) -> dict:
    return {"id": str(session.user.id), "label": session.user.email}


@app.exception_handler(UpdaterProblem)
async def updater_problem(_, error: UpdaterProblem):
    return JSONResponse(status_code=error.status, content={"code": error.code, "problem": error.problem})


@app.exception_handler(UpdaterUnavailable)
async def updater_unavailable(_, __):
    return JSONResponse(status_code=503, content={"code": "updater_unavailable"})


class Schedule(BaseModel):
    version: str
    leadSeconds: int = 300
    releaseSha256: str


@app.get("/admin/updates")
async def update_state(session=Depends(update_admin)) -> dict:
    return await sidecar("GET", "/v1/state")


@app.post("/admin/releases/{version}/verification")
async def verify_update(version: str, session=Depends(update_admin)) -> dict:
    return await sidecar("POST", f"/v1/releases/{version}/verification", timeout=120)


@app.post("/admin/updates", status_code=202)
async def schedule_update(request: Schedule, session=Depends(update_admin_with_step_up)) -> dict:
    return await sidecar("POST", "/v1/runs", {
        "version": request.version,
        "leadSeconds": request.leadSeconds,
        "requestedBy": actor(session),
        "expect": {"releaseSha256": request.releaseSha256},
    }, timeout=120)


@app.post("/admin/updates/{run_id}/{action}")
async def act_on_run(run_id: str, action: str, session=Depends(update_admin)) -> dict:
    if action not in ("cancel", "acknowledge"):
        raise HTTPException(status_code=404, detail="not_found")
    return await sidecar("POST", f"/v1/runs/{run_id}/{action}", {"requestedBy": actor(session)})
```

The sidecar validates the version and the run id itself (`422 invalid_request`,
`404 not_found`). Reschedule works the same way with
`PATCH /v1/runs/{run_id}` and `{"leadSeconds": ..., "requestedBy": ...}`.

## 2. Audit via the journal

The sidecar journals every action: scheduled, rescheduled, cancelled, abort requested,
started, succeeded, failed, acknowledged. Copy these events into your audit log with a
cursor, so each lands exactly once, also across your app's restart in the middle of an
update ([how it works](http-api.md#journal-ingestion-exactly-once)). Because the sidecar
journals schedule and cancel itself, do not write your own audit entries for them; audit
what only your app sees (feed checks, settings changes, denied requests).

Tables (PostgreSQL; the examples create them in their first migration):

```sql
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  source     text NOT NULL,
  event_id   text NOT NULL,
  action     text NOT NULL,
  actor      text,
  detail     jsonb,
  created_at timestamptz NOT NULL,
  UNIQUE (source, event_id)
);

CREATE TABLE updater_journal_cursor (
  id      integer PRIMARY KEY,   -- always 1
  last_id text NOT NULL
);
```

Poll every 30 seconds while idle and every 3 seconds while a run is scheduled or running.

TypeScript with `syncJournal` (`pool` is a `pg.Pool`):

```ts
import { syncJournal } from "@restow-backup/cicd-updater";
import { updater } from "./updater.js";

async function ingestJournal(): Promise<"active" | "idle"> {
  const state = await updater.state();
  if (!state) return "idle";                       // no sidecar on this installation
  await syncJournal({
    client: updater,
    loadCursor: async () =>
      (await pool.query<{ last_id: string }>("SELECT last_id FROM updater_journal_cursor WHERE id = 1"))
        .rows[0]?.last_id ?? null,
    ingest: async (event) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(
          `INSERT INTO audit_log (source, event_id, action, actor, detail, created_at)
           VALUES ('updater', $1, $2, $3, $4, $5) ON CONFLICT (source, event_id) DO NOTHING`,
          [event.id, event.action, event.actor.label, JSON.stringify(event), event.at],
        );
        await client.query(
          `INSERT INTO updater_journal_cursor (id, last_id) VALUES (1, $1)
           ON CONFLICT (id) DO UPDATE SET last_id = $1`,
          [event.id],
        );
        await client.query("COMMIT");          // the audit entry and the cursor, together
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      } finally {
        client.release();
      }
    },
    onGap: async ({ after }) => {
      await pool.query(
        `INSERT INTO audit_log (source, event_id, action, detail, created_at)
         VALUES ('updater', $1, 'journal_gap', $2, now())`,
        [`gap-${Date.now()}`, JSON.stringify({ after })],
      );
    },
  });
  return state.phase === "scheduled" || state.phase === "running" ? "active" : "idle";
}

async function journalLoop(): Promise<void> {
  let delay = 30_000;
  try {
    delay = (await ingestJournal()) === "active" ? 3_000 : 30_000;
  } catch (error) {
    console.error(`journal sync: ${(error as Error).message}`);
  }
  setTimeout(journalLoop, delay).unref();
}
void journalLoop();
```

Python (synchronous `httpx` in a thread, SQLAlchemy `engine`):

```python
import asyncio
import json

import httpx
from sqlalchemy import text


def ingest_journal_once() -> str:
    """Copy new journal events; returns "active" while a run is scheduled or running."""
    token = updater_token()
    if not UPDATER_URL or not token:
        return "idle"
    headers = {"authorization": f"Bearer {token}"}
    with httpx.Client(timeout=30, follow_redirects=False) as client:
        while True:
            with engine.connect() as connection:
                cursor = connection.execute(
                    text("SELECT last_id FROM updater_journal_cursor WHERE id = 1")
                ).scalar()
            params = {"limit": 100, **({"after": cursor} if cursor else {})}
            response = client.get(f"{UPDATER_URL}/v1/events", params=params, headers=headers)
            response.raise_for_status()
            view = response.json()
            if view["gap"]:
                with engine.begin() as connection:
                    connection.execute(
                        text("INSERT INTO audit_log (source, event_id, action, detail, created_at) "
                             "VALUES ('updater', :id, 'journal_gap', CAST(:detail AS json), now()) "
                             "ON CONFLICT (source, event_id) DO NOTHING"),
                        {"id": f"gap-after-{cursor}", "detail": json.dumps({"after": cursor})},
                    )
            for event in view["events"]:
                if cursor and event["id"] <= cursor:
                    continue
                with engine.begin() as connection:   # one transaction per event
                    connection.execute(
                        text("INSERT INTO audit_log (source, event_id, action, actor, detail, created_at) "
                             "VALUES ('updater', :id, :action, :actor, CAST(:detail AS json), :at) "
                             "ON CONFLICT (source, event_id) DO NOTHING"),
                        {"id": event["id"], "action": event["action"], "actor": event["actor"]["label"],
                         "detail": json.dumps(event), "at": event["at"]},
                    )
                    connection.execute(
                        text("INSERT INTO updater_journal_cursor (id, last_id) VALUES (1, :id) "
                             "ON CONFLICT (id) DO UPDATE SET last_id = :id"),
                        {"id": event["id"]},
                    )
            if len(view["events"]) < 100:
                break
        state = client.get(f"{UPDATER_URL}/v1/state", headers=headers).json()
    return "active" if state["phase"] in ("scheduled", "running") else "idle"


async def journal_loop() -> None:
    while True:
        delay = 30
        try:
            delay = 3 if await asyncio.to_thread(ingest_journal_once) == "active" else 30
        except Exception as error:  # keep the loop alive; log the reason
            print(f"journal sync: {error}")
        await asyncio.sleep(delay)
```

Start `journal_loop()` from your application's lifespan handler. The `ON CONFLICT DO
NOTHING` on the event id is a second safety net; the transaction is what makes ingestion
exactly once.

## 3. Feed settings and token storage

Your app may let an admin configure where releases come from (to show "update available"
even without a sidecar) and a token for a private repository. Rules:

- Changing the feed URL, the channel or the token requires step-up (section 1) and is
  written to your audit log.
- Store the token encrypted with your app's secret key, together with the origin it was
  entered for (`new URL(feedUrl).origin`).
- When the feed origin changes, delete the token instead of sending it to the new host.
- Never return the token in an API response; return whether one is set.
- The admin's feed URL is input for [`checkFeed`](sdk.md#feed-check), which refuses
  private and loopback addresses. Hosts that may resolve to private networks
  (`allowPrivateHosts`, for an internal Forgejo for example) are an operator setting, for
  example an environment variable, never an admin input in the UI.
- The sidecar does not use these settings. Its feed is `release.feed` in `updater.yaml`,
  written by the operator, so an app or API caller can never point an installation at
  another source.

TypeScript:

```ts
interface FeedSettings {
  type: "github" | "gitea" | "gitlab" | "static";
  url: string;
  channel: "stable" | "beta";
  tokenCiphertext: string | null;
  tokenOrigin: string | null;
}

export async function saveFeedSettings(
  session: Session,
  next: { type: FeedSettings["type"]; url: string; channel: FeedSettings["channel"]; token?: string | null },
) {
  assertUpdateAdmin(session, { stepUp: true });
  const origin = new URL(next.url).origin;
  const current = await loadFeedSettings();
  let tokenCiphertext = current?.tokenCiphertext ?? null;
  let tokenOrigin = current?.tokenOrigin ?? null;
  if (tokenOrigin !== null && tokenOrigin !== origin) {
    tokenCiphertext = null;                 // the origin changed: the token is deleted, not moved
    tokenOrigin = null;
  }
  if (next.token !== undefined) {           // undefined: keep; null or "": remove
    tokenCiphertext = next.token ? encryptSecret(next.token) : null;
    tokenOrigin = next.token ? origin : null;
  }
  await storeFeedSettings({ type: next.type, url: next.url, channel: next.channel, tokenCiphertext, tokenOrigin });
  await audit(session, "updates.feed_changed", {
    type: next.type, url: next.url, channel: next.channel, token: tokenCiphertext ? "set" : "none",
  });
  return { type: next.type, url: next.url, channel: next.channel, tokenSet: tokenCiphertext !== null };
}
```

Python apps without the SDK: when a sidecar runs, read `GET /v1/releases` (the sidecar
reads its own, operator-configured feed). If you check an admin-entered feed URL yourself,
implement the [network rules](sdk.md#network-rules) of `checkFeed`; a plain HTTP client
would let an admin probe your internal network.

## 4. Update notification

Tell admins once per version that an update exists:

- Check once a day. Retry a failed check after one hour at the earliest, and not before
  `retryAt` of a `rate_limited` error.
- Notify for the newest release that is newer than the running version.
- Write a claim (`notified_version`) in the same transaction as the notification, so
  several app instances or a restart never notify twice.
- Audit the check (result and error code, never the token).

```sql
CREATE TABLE update_check (
  id               integer PRIMARY KEY,    -- always 1
  notified_version text,
  next_check_at    timestamptz NOT NULL DEFAULT now()
);
INSERT INTO update_check (id) VALUES (1) ON CONFLICT DO NOTHING;
```

TypeScript with `checkFeed`:

```ts
import { checkFeed } from "@restow-backup/cicd-updater/feed";

const ALLOW_PRIVATE_HOSTS = (process.env.UPDATE_FEED_PRIVATE_HOSTS ?? "").split(",").filter(Boolean);

export async function dailyUpdateCheck(): Promise<void> {
  const settings = await loadFeedSettings();
  if (!settings) return;
  const result = await checkFeed({
    feed: { type: settings.type, url: settings.url },
    token: settings.tokenCiphertext ? decryptSecret(settings.tokenCiphertext) : null,
    channel: settings.channel,
    running: APP_VERSION,
    allowPrivateHosts: ALLOW_PRIVATE_HOSTS,
  });
  await auditSystem("updates.feed_checked", { ok: result.ok, error: result.ok ? null : result.error.code });

  if (!result.ok) {
    const retryAt = result.error.retryAt ? Date.parse(result.error.retryAt) : 0;
    await setNextCheck(new Date(Math.max(Date.now() + 3_600_000, retryAt)));
    return;
  }
  await setNextCheck(new Date(Date.now() + 86_400_000));

  const newest = result.releases.find((release) => !release.refusals.includes("not_newer"));
  if (!newest) return;

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const claim = await client.query(
      `UPDATE update_check SET notified_version = $1
       WHERE id = 1 AND notified_version IS DISTINCT FROM $1`,
      [newest.version],
    );
    if (claim.rowCount === 1) {
      await client.query(
        `INSERT INTO notifications (audience, kind, payload) VALUES ('installation_admins', 'update_available', $1)`,
        [JSON.stringify({
          version: newest.version,
          notesUrl: newest.notesUrl,
          next: result.nextInstallable?.version ?? null,   // install this one first if it differs
          refusals: newest.refusals,
        })],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}
```

When `newest.refusals` contains `below_minimum_version`, tell the admin to install
`nextInstallable` first. `manual_steps_required` means the operator has to update by hand
(`document.upgrade.manualSteps.url` explains it).

Python, using the sidecar's release list:

```python
import json

from sqlalchemy import text


async def daily_update_check() -> None:
    try:
        view = await sidecar("GET", "/v1/releases", timeout=120)
    except (UpdaterUnavailable, UpdaterProblem) as error:
        set_next_check(hours=1)            # retry after one hour at the earliest
        audit_system("updates.feed_checked", {"ok": False, "error": getattr(error, "code", "unavailable")})
        return
    set_next_check(hours=24)
    audit_system("updates.feed_checked", {"ok": True})
    newest = next((r for r in view["releases"] if "not_newer" not in r["refusals"]), None)
    if newest is None:
        return
    with engine.begin() as connection:     # the claim and the notification, together
        claimed = connection.execute(
            text("UPDATE update_check SET notified_version = :v "
                 "WHERE id = 1 AND notified_version IS DISTINCT FROM :v"),
            {"v": newest["version"]},
        ).rowcount
        if claimed == 1:
            connection.execute(
                text("INSERT INTO notifications (audience, kind, payload) "
                     "VALUES ('installation_admins', 'update_available', CAST(:p AS json))"),
                {"p": json.dumps({"version": newest["version"], "notesUrl": newest["notesUrl"],
                                  "next": view["nextInstallable"], "refusals": newest["refusals"]})},
            )
```

A `feed_unavailable` problem carries the feed error code in `problem["feedError"]`.

## 5. Maintenance banner endpoint

Every signed-in user should see an announced update (with a countdown), its progress, and
its result. Add an endpoint every signed-in user may read. It returns the run summary in
the shape of the [public status](http-api.md#get-publicv1status) plus the versions.

The browser polls this endpoint every 30 seconds while idle and every 2 seconds while a run
is scheduled or running. While your app is down during the update, the browser switches to
`/public/v1/status` through your edge and reloads when the new version answers. The
[React components](react.md) implement this; other frontends follow the same rules.

TypeScript:

```ts
import { maintenanceViewOf } from "@restow-backup/cicd-updater";

// GET /api/maintenance: every signed-in user; Cache-Control: no-store
export async function getMaintenance(session: Session) {
  assertSignedIn(session);
  return maintenanceViewOf(await updater.state().catch(() => null));   // idle when no sidecar
}
```

Python (the same shape as `maintenanceViewOf`):

```python
from datetime import datetime, timezone

IDLE = {"runId": None, "outcome": None, "startsAt": None, "startedAt": None, "finishedAt": None,
        "step": None, "steps": [], "progress": 0, "message": None, "failureCode": None}


def maintenance_view(state: dict | None) -> dict:
    now = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    run = state.get("run") if state else None
    if not state or not run or state["phase"] == "idle":
        return {"phase": state["phase"] if state else "idle", **IDLE, "serverTime": now}
    return {
        "phase": state["phase"],
        "runId": run["id"],
        "outcome": run["outcome"],
        "startsAt": run["startsAt"],
        "startedAt": run["startedAt"],
        "finishedAt": run["finishedAt"],
        "step": run["step"],
        "steps": [{"id": step["id"], "status": step["status"]} for step in run["steps"]],
        "progress": run["progress"],
        "message": run["message"],
        "failureCode": (run.get("failure") or {}).get("code"),
        "targetVersion": run["targetVersion"],
        "fromVersion": run["fromVersion"],
        "serverTime": now,
    }


@app.get("/api/maintenance")
async def maintenance(session=Depends(current_session)) -> JSONResponse:
    try:
        state = await sidecar("GET", "/v1/state")
    except (UpdaterUnavailable, UpdaterProblem):
        state = None
    return JSONResponse(maintenance_view(state), headers={"cache-control": "no-store"})
```

Do not pass the full `StateView` to the browser: it contains capabilities, paths, image
references and the run log, which are for admins.

The edge must forward `/public/v1/status` (and, if you use it, `/public/v1/maintenance/`)
to the sidecar and serve the maintenance page when the app answers `502`, `503` or `504`
([maintenance page](maintenance-page.md)).

## 6. Health with version for the updater only

The sidecar decides whether the new version runs by polling your health endpoint until it
is healthy **and** reports the target version. Reveal the version only to the sidecar: a
public version number tells an attacker which known vulnerability is still open.

- Always answer readiness (`200` when ready, `503` while starting).
- Add `version` (the plain version, without `v`) only when the request carries
  `Authorization: Bearer <shared token>`.
- Compare the token in constant time.
- Bake the version into the image at build time. The release side's build action passes it
  as the build argument `VERSION` and sets the OCI label `org.opencontainers.image.version`
  ([release side](release-side.md)).

TypeScript with `createTokenVerifier`:

```ts
import { createTokenVerifier } from "@restow-backup/cicd-updater/auth";

const verifier = createTokenVerifier({ tokenFile: process.env.UPDATER_TOKEN_FILE ?? "/run/cicd-updater/token" });
const APP_VERSION = (process.env.APP_VERSION ?? "0.0.0-dev").replace(/^v/, "");

// GET /healthz
export async function health(authorization: string | undefined) {
  const database = await databaseReady();
  const body: Record<string, unknown> = { status: database ? "ok" : "starting" };
  if (await verifier.isUpdater(authorization)) {
    body.version = APP_VERSION;
  }
  return { status: database ? 200 : 503, body };
}
```

Python:

```python
import hashlib
import hmac
import os

from fastapi import Request
from sqlalchemy import text

APP_VERSION = os.environ.get("APP_VERSION", "0.0.0-dev").removeprefix("v")


def is_updater(authorization: str | None) -> bool:
    token = updater_token()
    scheme, _, given = (authorization or "").partition(" ")
    # Hash both sides so the comparison takes the same time whatever was sent.
    expected = hashlib.sha256((token or "").encode()).digest()
    provided = hashlib.sha256(given.strip().encode()).digest()
    return token is not None and scheme.lower() == "bearer" and hmac.compare_digest(expected, provided)


@app.get("/health")
def health(request: Request) -> dict:
    try:
        with engine.connect() as connection:
            connection.execute(text("SELECT 1"))
        database = "ok"
    except Exception:
        database = "unavailable"
    body: dict = {"status": "ok", "database": database}
    if is_updater(request.headers.get("authorization")):
        body["version"] = APP_VERSION
    return body
```

This endpoint answers `200` even when the database is down; the Python example therefore
adds a condition in `updater.yaml`, so "healthy" means "the API answers and the database
check passed":

```yaml
hooks:
  health:
    type: http
    http:
      url: http://api:8000/health
      versionJsonPath: $.version
      conditions:
        - { path: $.database, equals: ok }
```

During an update the sidecar starts the services in groups (`startOrder`). If your health
endpoint also reports workers that start in a later group, give the sidecar a check that
covers only what the first group provides, and check the rest with a smoke check
([hooks](hooks.md)).

## 7. Demo and read-only installations

Some installations must not update themselves from the app: public demos, read-only
showcases, installations whose operator wants updates only by hand.

- Do not configure a sidecar there (do not start the `updater` profile).
- Leave `UPDATER_URL` empty. The SDK client is then disabled: `state()` resolves `null`,
  and every other method throws `UpdaterUnavailableError("disabled")`. The Python helper
  above raises `UpdaterUnavailable`.
- When the state is `null`, the UI shows the manual update steps instead of a schedule
  button. The update notification (section 4) can still run.
- If the sidecar runs but your product policy forbids scheduling from this installation,
  deny the action in your authorization (section 1). Do not rely on hiding the button.

```ts
const state = await updater.state();
if (state === null) {
  return { mode: "manual", docsUrl: "https://docs.example.com/notes/updating" };
}
```

## 8. Manual updates stay possible

The sidecar is a convenience, not a requirement. Every installation must remain updatable
by hand, and your app must not depend on the sidecar to start or to migrate:

- The app starts and works without the sidecar and without the token file
  (`isUpdater` returns `false`, the client reports no sidecar).
- Migrations run without the sidecar: at container start, or with a documented command
  (the same one `hooks.migrate` runs).
- Your update documentation keeps the manual path: back up, set the image variables in the
  env file to the new references, `docker compose pull`, `docker compose up -d`. Each
  `release.json` lists the exact image references (`repository`, `tag`, `digest`); pin
  them as `repository:tag@sha256:...`. Operators can verify the signatures with cosign as
  described in [trust modes](trust-modes.md).
- Releases that need manual steps set `upgrade.manualSteps.required` in `release.json`.
  The sidecar then refuses to install them (`manual_steps_required`), and your UI shows
  `manualSteps.summary` and `manualSteps.url`.
- Do not change the env file while a run is scheduled or running: the sidecar detects the
  change and fails the run with `start.env_changed`.

[Backups and recovery](backups-and-recovery.md) covers restoring after a manual or failed
update.

## Checklist

- [ ] The token volume is mounted read-only into the app backend only; `auth.tokenGroupId`
      matches the app's group when it runs as non-root.
- [ ] Only installation admins can schedule, reschedule, cancel and acknowledge; scheduling
      and feed changes require a strong sign-in younger than 10 minutes; impersonation never
      counts.
- [ ] Every action passes `requestedBy`; scheduling passes `expect.releaseSha256`.
- [ ] Journal events are ingested with a cursor, the audit entry and the cursor in one
      transaction; gaps are recorded.
- [ ] A feed token is stored encrypted, bound to its origin, deleted when the origin
      changes, and never returned.
- [ ] "Update available" is raised once per version with a claim in the same transaction.
- [ ] Every signed-in user sees the banner; the browser falls back to the public status
      while the app is down.
- [ ] The health endpoint reveals the version only to the sidecar's token.
- [ ] The app runs without the sidecar, and the manual update path is documented.

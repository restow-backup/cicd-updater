# Web app template

A copy-paste starter that connects an existing web application to the cicd-updater
sidecar: an admin "Updates" page, a maintenance banner for every signed-in user, the
backend endpoints behind them, the sidecar's Compose service, its configuration and the
release workflow. It is framework-agnostic: Node.js/TypeScript with the SDK (Express,
Hono or any framework with web-standard `Request`/`Response`), Python (FastAPI), and a
plain HTTP reference for every other language; React or plain JavaScript in the browser.

Plan about 30 minutes to wire it into your app, plus the first run of your release
pipeline. Every place you must adapt is marked `TODO(cicd-updater)`:

```sh
grep -rn "TODO(cicd-updater)" .
```

Documentation: [getting started](https://github.com/restow-backup/cicd-updater/blob/main/docs/getting-started.md),
[app integration](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md),
[configuration](https://github.com/restow-backup/cicd-updater/blob/main/docs/configuration.md).
Check off [INTEGRATION-CHECKLIST.md](INTEGRATION-CHECKLIST.md) as you go.

## What is in it

| File | Copy to | What it is |
| --- | --- | --- |
| [compose/docker-compose.updater.yml](compose/docker-compose.updater.yml) | your `docker-compose.yml` (pasted) or next to it | the sidecar service, the token mount for your backend, three volumes |
| [compose/docker-compose.smoke.yml](compose/docker-compose.smoke.yml) | next to `docker-compose.yml` | publishes the health endpoint for the release smoke test |
| [.env.example](.env.example) | append to your `.env.example` | `PROJECT_DIR`, `APP_IMAGE`, `CICD_UPDATER_IMAGE`, `UPDATER_URL` |
| [updater.yaml](updater.yaml) | the project directory on the host | the sidecar's configuration, every key commented |
| [release/github-release.yml](release/github-release.yml) | `.github/workflows/release.yml` | build, smoke, sign, publish |
| [release/release-policy.yaml](release/release-policy.yaml) | `.cicd-updater/release-policy.yaml` | upgrade constraints of the next release |
| [backend/node/](backend/node/) | your backend (TypeScript) | endpoints, health, journal, Express and Hono adapters |
| [backend/python/](backend/python/) | your backend (FastAPI) | endpoints and health |
| [backend/http/](backend/http/) | reference | the API calls for any other language, and a `curl` script |
| [backend/sql/migration-probe.sql](backend/sql/migration-probe.sql) | reference | the probe query of each migration tool preset |
| [frontend/react/](frontend/react/) | your React app | `UpdatesPage`, `MaintenanceNotice`, the fetch helpers |
| [frontend/vanilla/](frontend/vanilla/) | your static files | the same in one ES module, no build step |
| [frontend/updates.css](frontend/updates.css) | your styles | minimal styles for both |

The pieces and who talks to whom:

```
 browser ── /api/admin/updates ──▶ your backend ── bearer token ──▶ updater sidecar ── docker.sock
    │       /api/maintenance            (authorization, step-up,         (verify, back up,
    │                                    audit, requestedBy)               install, check)
    └────── /public/v1/status ──▶ your edge ──────────────────────────▶ (read-only, no token)
            (only while the app is down for the update)
```

## Before you start

- [ ] The app runs with Docker Compose v2, on Linux, Docker Engine 24 or newer.
- [ ] Your backend's service takes its image from a variable of `.env`
      (`image: ${APP_IMAGE:?set APP_IMAGE in .env}`). The sidecar writes only that line.
- [ ] A CI builds the image. The template's workflow is for GitHub Actions; Forgejo/Gitea and
      GitLab templates are in the cicd-updater repository under `templates/`.
- [ ] The database is in the same Compose project (for the built-in backup and probe), and
      you know your migration tool (for the probe preset).
- [ ] Your app knows its users: who is an installation admin, and when they last signed in
      with a strong method (passkey, password plus TOTP, OIDC).

## Step 1: Compose (5 minutes)

Pick one variant:

- **A, recommended:** paste the `updater` service, the `environment` and `volumes` lines
  for your backend, and the three volumes from
  [compose/docker-compose.updater.yml](compose/docker-compose.updater.yml) into your
  `docker-compose.yml`.
- **B:** copy the file next to your `docker-compose.yml` and merge it with
  `-f docker-compose.yml -f docker-compose.updater.yml` (or `COMPOSE_FILE` in `.env`).
  Then uncomment `compose.files` in `updater.yaml`, because the sidecar runs Compose itself.

Rename `api` to your backend service and `internal` to the network your backend and edge
share. Append [.env.example](.env.example) to your `.env.example`, copy
[compose/docker-compose.smoke.yml](compose/docker-compose.smoke.yml) next to your Compose
file and set your backend's port there.

If your backend runs as a non-root user, give it a fixed group id in its Dockerfile and
put that id into `auth.tokenGroupId` (step 2); otherwise it cannot read the token and
behaves as if there were no sidecar.

## Step 2: updater.yaml (5 minutes)

Copy [updater.yaml](updater.yaml) into the project directory on the host and work through
its TODOs: feed URL, trust identity, managed services, backup, migration probe preset
([backend/sql/migration-probe.sql](backend/sql/migration-probe.sql)), health URL. Check it
offline:

```sh
docker compose run --rm --no-deps updater config check
```

## Step 3: backend (10 minutes)

**Node.js / TypeScript.** Install the SDK (Node.js 22.12 or newer):

```sh
npm install https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/restow-backup-cicd-updater-1.0.0.tgz
```

Copy [backend/node/](backend/node/) into your backend (below as `src/cicd-updater/`) and
wire it:

```ts
import express from "express";
import { healthHandler, updatesMiddleware } from "./cicd-updater/adapters/express.js";
import { startJournalSync } from "./cicd-updater/journal.js";
import { updater } from "./cicd-updater/updater.js";
import { type Actor, createUpdateRoutes } from "./cicd-updater/updates.js";

const routes = createUpdateRoutes({
  updater,
  audit: (entry) => auditLog.write("updates", entry),        // your audit log
});

// Your session -> Actor. Installation admins only; impersonation never counts.
function actorOf(req: express.Request): Actor | null {
  const user = req.session?.user;
  if (!user) return null;
  return {
    id: user.id,
    label: user.email,
    isInstallationAdmin: user.roles.includes("installation_admin"),
    impersonated: Boolean(req.session.impersonatorId),
    strongAuthAt: user.strongAuthAt ?? null,                 // passkey, password + TOTP, OIDC
  };
}

app.get("/healthz", healthHandler(() => db.ping()));
app.use(updatesMiddleware(routes, actorOf));
startJournalSync(updater, journalStore);                     // see journal.ts for the SQL
```

With Hono, use [adapters/hono.ts](backend/node/adapters/hono.ts); with Next.js route
handlers, Remix, SvelteKit, Bun or Deno, call `routes.handle(request, actor)` directly.
Turn the build argument into the version in your Dockerfile:

```dockerfile
ARG VERSION=0.0.0-dev
ENV APP_VERSION=${VERSION}
```

**Python / FastAPI.** Copy [backend/python/](backend/python/), implement `current_actor`
and `audit` in `updates.py` and `ready` in `health.py`, then:

```python
from health import router as health_router
from updates import install

app.include_router(health_router)
install(app)
```

Copy the sidecar's journal into your audit log as in
[app integration, section 2](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md#2-audit-via-the-journal).

**Any other language.** Offer the same six routes; [backend/http/](backend/http/) lists
the sidecar calls behind them and your backend's jobs.

What the backend decides, whatever the language:

| Route | Who | Note |
| --- | --- | --- |
| `GET /api/maintenance` | every signed-in user | the banner; never the full state |
| `GET /api/admin/updates`, `.../releases` | installation admin | read |
| `POST /api/admin/updates` | installation admin, strong sign-in younger than 10 minutes | schedule with a lead time and the `releaseSha256` the admin saw |
| `POST /api/admin/updates/{runId}/cancel`, `.../acknowledge` | installation admin | |

Denied and refused attempts go to your `audit` hook; accepted actions reach your audit
log through the journal, exactly once, with the admin from `requestedBy`.

## Step 4: frontend (5 minutes)

**React:** copy [frontend/react/](frontend/react/) and [frontend/updates.css](frontend/updates.css).
Render `<MaintenanceNotice />` once in your signed-in layout and `<UpdatesPage />` on an
admin route:

```tsx
<MaintenanceNotice />
<UpdatesPage onStepUp={() => navigate("/reauth?next=/admin/updates")} />
```

**Without React:** copy [frontend/vanilla/updates-widget.js](frontend/vanilla/updates-widget.js)
and the CSS to your static files; [example.html](frontend/vanilla/example.html) shows the two
calls. No build step, no dependency.

Both translate codes (blockers, refusals, failures, steps) with the SDK catalogs (`en`,
`de`) where the SDK is available; the page's own sentences are English constants to
translate.

## Step 5: edge (5 minutes)

While the app is replaced, your reverse proxy forwards `/public/v1/` to the sidecar and
serves the maintenance page instead of a bare 502
([maintenance page](https://github.com/restow-backup/cicd-updater/blob/main/docs/maintenance-page.md),
also for Traefik). Caddy:

```
handle /public/v1/* {
	reverse_proxy updater:8090
}
handle_errors 502 503 504 {
	rewrite * /public/v1/maintenance/
	reverse_proxy updater:8090
}
```

nginx (lazy upstreams, so nginx starts while the app or the sidecar is down):

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;
set $updater http://updater:8090;
location /public/v1/ { proxy_pass $updater; }
location / {
    proxy_pass $app;                      # your app upstream, also in a variable
    proxy_intercept_errors on;
    error_page 502 503 504 = @maintenance;
}
location @maintenance {
    rewrite ^ /public/v1/maintenance/ break;
    proxy_pass $updater;
}
```

Forward nothing else of the sidecar.

## Step 6: release workflow (first run 15 to 30 minutes)

Copy [release/github-release.yml](release/github-release.yml) to
`.github/workflows/release.yml` and [release/release-policy.yaml](release/release-policy.yaml)
to `.cicd-updater/release-policy.yaml`, adjust the TODOs and push a tag `v1.0.0`. The
workflow builds per architecture, pushes by digest, starts the release with your
`docker-compose.yml` and `.env.example`, and only then signs and publishes it with
`release.json`. Set `APP_IMAGE` in `.env` once by hand to the reference from that
`release.json` (`<repository>:<tag>@sha256:<digest>`).

## Step 7: start and update

On the host, after verifying and pinning the sidecar image
([upgrading the updater](https://github.com/restow-backup/cicd-updater/blob/main/docs/upgrading-the-updater.md)):

```sh
docker compose --profile updater up -d
docker compose exec updater cicd-updater doctor       # fix every FAIL line
```

Push `v1.1.0`, open the admin page, pick the release and a lead time, schedule. Users see
the countdown, then the maintenance page, then the new version. If a run ends in
`needs_attention`, the page explains it; the operator follows the
[runbook](https://github.com/restow-backup/cicd-updater/blob/main/docs/backups-and-recovery.md#runbook-a-run-ended-in-needs_attention).

## What the template leaves out

- Rescheduling (`updater.reschedule(runId, { leadSeconds }, requestedBy)`, `PATCH /v1/runs/{runId}`).
- The daily "update available" notification and admin-editable feed settings
  ([app integration, sections 3 and 4](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md#3-feed-settings-and-token-storage)).
- Translations of the page's own sentences.
- Tests: the backend core takes the client as a parameter (`createUpdateRoutes({ updater })`),
  so you can pass a fake.

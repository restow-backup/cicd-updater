# Maintenance page

While the sidecar replaces the managed services, the app is down for a short time. Users
should see a page that says so, shows the progress and reloads the app when it is back,
instead of a bare `502 Bad Gateway`. cicd-updater provides two read-only, unauthenticated
pieces for that:

- the **public status**, `GET /public/v1/status`, a JSON document an anonymous visitor may
  see;
- the optional **maintenance page** under `/public/v1/maintenance/`, a static page that polls
  the public status.

The edge (your reverse proxy) forwards `/public/v1/` to the sidecar and serves the page when
the app does not answer. Nothing else of the sidecar is ever exposed. At integration levels 2
and 3 the app additionally shows a countdown banner and a progress overlay to signed-in users
(see [React](react.md) and [app integration](app-integration.md)).

## The public status

`GET /public/v1/status` (enabled by default, `publicStatus.enabled`). With
`publicStatus.enabled: false` the path answers `404` with the problem `not_found`, and the
maintenance page cannot show progress.

```json
{
  "phase": "running",
  "runId": "r-1793642651000-3fa2",
  "outcome": null,
  "startsAt": "2026-11-02T18:30:00.000Z",
  "startedAt": "2026-11-02T18:30:00.412Z",
  "finishedAt": null,
  "step": "health",
  "steps": [
    { "id": "prepare", "status": "done" },
    { "id": "fetch", "status": "done" },
    { "id": "backup", "status": "done" },
    { "id": "stop", "status": "done" },
    { "id": "migrate", "status": "done" },
    { "id": "start", "status": "done" },
    { "id": "health", "status": "running" },
    { "id": "smoke", "status": "pending" },
    { "id": "finish", "status": "pending" }
  ],
  "progress": 83,
  "message": { "code": "step.health.checking_app", "params": {} },
  "failureCode": null,
  "serverTime": "2026-11-02T18:31:12.093Z"
}
```

| Field | Content |
| --- | --- |
| `phase`, `outcome`, `step`, `steps`, `progress` | the state of the current run (see [state machine](state-machine.md)) |
| `runId` | the id of the current run |
| `startsAt`, `startedAt`, `finishedAt` | times of the run, for the countdown |
| `message` | the run's message code with its parameters, without the `version` parameter |
| `failureCode` | the failure code of a failed run, for example `health.timeout` |
| `serverTime` | the sidecar's clock, so the page can correct the browser's clock offset |
| `targetVersion`, `fromVersion` | only with `publicStatus.showVersions: true` |

What it never contains: who requested the update, image names, file names and paths, the
run log, failure details, recovery information, backups. With `showVersions: false` (the
default) it also contains no version: which release runs is information for signed-in users,
because a public version number tells an attacker which known vulnerability is still open.
The phase, the timing and the failure codes are public by design.

When nothing is announced the document is the idle document: `phase: "idle"`, every other
field `null`, empty `steps`, `progress: 0`. A finished run stays visible until it is
acknowledged. Every response carries `Cache-Control: no-store`.

## The maintenance page

```yaml
maintenancePage:
  enabled: true
  brandingFile: /opt/notes/maintenance/branding.json   # optional
  templateDir: null                                    # optional
  languages: [en, de]
```

With `enabled: true` the sidecar serves these files (and `/public/v1/maintenance` redirects
to the path with the trailing slash):

| Path | Content |
| --- | --- |
| `/public/v1/maintenance/` | `index.html` |
| `/public/v1/maintenance/maintenance.css` | the stylesheet (light and dark) |
| `/public/v1/maintenance/maintenance.js` | the script |
| `/public/v1/maintenance/logo.png` or `logo.svg` | the logo of the branding file, if any |

The page refers to its files with absolute URLs (`/public/v1/maintenance/maintenance.css`,
`/public/v1/maintenance/maintenance.js`, the logo under the same prefix) and reads the status
at `/public/v1/status`. It therefore works when an edge serves it in place of any address of
the app, as long as the edge forwards `/public/v1/` to the sidecar on the same origin.

The files are sent with a strict Content Security Policy
(`default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`),
`Referrer-Policy: no-referrer` and `Cache-Control: no-store`. The page loads nothing from
other origins.

What the page does:

- It reads the public status every 2 seconds while a run is scheduled or running, every 30
  seconds otherwise.
- It shows a title (the phase, or "Maintenance in progress" while running), a text (the
  countdown while scheduled, the run's message while running, the outcome when the run
  failed), a progress bar and the steps that are not skipped, each with its state.
- It corrects the browser's clock with `serverTime` (the largest offset of the last 8
  samples), so the countdown is right even on a wrong clock.
- When the run succeeded, or the phase is `idle` after the page has seen a run, it goes to
  the home URL (default `/`) after 2.5 seconds, at most once per minute.
- When the status cannot be read (the sidecar is not running, the edge answers 502), it keeps
  showing "This service is being updated and will be back shortly." and tries again every 2
  seconds.
- The language is the browser's language if the page has a catalog for it, otherwise English.
  The built-in catalogs are `en` and `de`.
- Without `publicStatus.showVersions` the status carries no version, so messages that would
  name one use a version-free text, for example "Waiting for the application to report the new
  version." instead of "... to report version 1.4.0.".

If the app fails outside an update, an edge that falls back to the page shows it with the
idle phase; it does not reload by itself then.

The sidecar builds the files on the first request and keeps them in memory. Restart the
sidecar after you change the branding file or the template.

### Branding

`maintenancePage.brandingFile` points to a JSON file:

```json
{
  "productName": "Notes",
  "logoFile": "logo.svg",
  "accentColor": "#0f766e",
  "supportUrl": "https://status.example.com"
}
```

| Key | Rule | Default |
| --- | --- | --- |
| `productName` | text, at most 100 characters; shown in the window title and as the logo's alternative text | none |
| `logoFile` | a file name ending in `.png` or `.svg` (`[A-Za-z0-9][A-Za-z0-9._-]*`), in the same directory as the branding file, at most 256 KiB; a larger file is ignored | no logo |
| `accentColor` | `#` and 3 to 8 hex digits | `#2563eb` |
| `supportUrl` | an `https://` URL, shown as a link in the footer | none |

A value that does not follow its rule falls back to the default. The file itself must be
valid JSON, otherwise the page cannot be built. The paths are inside the sidecar container;
the project directory is mounted at the same path, so `/opt/notes/maintenance/` works.

### Your own template

`maintenancePage.templateDir` names a directory whose `index.html` and `maintenance.css`
replace the built-in ones (each only if present). The script always stays built in. A custom
`index.html` must keep what the script uses:

- the elements with the ids `title`, `message`, `progress`, `bar`, `steps` and `hint`;
- a `<script type="application/json" id="catalogs">` element with the text catalogs, one
  object per language (`phases`, `outcomes`, `steps`, `messages`, `messagesWithoutVersion`,
  `failures`, `ui`);
- `<script src="/public/v1/maintenance/maintenance.js">` (inline scripts are blocked by the
  policy);
- optionally the attributes `data-status-url` (default `/public/v1/status`) and
  `data-home-url` (default `/`) on `<html>`.

The easiest start is the built-in page. Export it with the same absolute asset URLs the
sidecar uses, edit it, and point `templateDir` at the directory:

```sh
docker compose exec updater cicd-updater maintenance-page export \
  --out /opt/notes/maintenance/template --asset-base /public/v1/maintenance/
```

Export while `templateDir` is not set, otherwise the export copies your template. Languages
other than `en` and `de` need a template, because their catalogs live in the template's
`catalogs` element.

## Edge configuration

The edge needs two things:

1. forward `/public/v1/` (the status and the page) to `http://updater:8090`, read-only;
2. when the app answers 502, 503 or 504 (or cannot be reached), serve
   `/public/v1/maintenance/` from the sidecar instead.

The edge must be on the sidecar's internal network. If the edge is itself a managed service,
give it `stopBeforeUpdate: false`, so it keeps serving while the app is replaced, and
`stopOnAttention: false`, so it keeps showing the page when a run ends in `needs_attention`
(as `web` in the node-postgres example).

### Caddy

From [examples/node-postgres/web/Caddyfile](../examples/node-postgres/web/Caddyfile):

```
:8080 {
	encode gzip

	# The updater's public status and maintenance page (no token, no versions).
	handle /public/v1/* {
		reverse_proxy updater:8090
	}

	handle /api/* {
		reverse_proxy api:3000
	}

	handle {
		root * /srv/public
		file_server
	}

	handle_errors 502 503 504 {
		rewrite * /public/v1/maintenance/
		reverse_proxy updater:8090
	}
}
```

`handle_errors` with status codes catches the errors of the `reverse_proxy` to the app,
including "the upstream cannot be reached" while the container is stopped, rewrites the
request to the page and proxies it to the sidecar. The browser keeps the address it asked
for; the page loads its files from `/public/v1/maintenance/` and goes to the home URL (`/`)
when the update is over.

### nginx

From [examples/python-postgres/nginx/default.conf](../examples/python-postgres/nginx/default.conf):

```nginx
resolver 127.0.0.11 valid=10s ipv6=off;

server {
    listen 8080;
    server_name _;

    set $api http://api:8000;
    set $updater http://updater:8090;

    # The updater's public status and maintenance page (no token, no versions).
    location /public/v1/ {
        proxy_pass $updater;
    }

    location / {
        proxy_pass $api;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_intercept_errors on;
        error_page 502 503 504 = @maintenance;
    }

    location @maintenance {
        rewrite ^ /public/v1/maintenance/ break;
        proxy_pass $updater;
    }
}
```

- **Lazy upstreams:** nginx resolves host names in `proxy_pass` once at start and refuses to
  start when one does not resolve. With the upstream in a variable and a `resolver` (Docker's
  embedded DNS, `127.0.0.11`), it resolves per request. nginx then starts even while the app
  container is being replaced or the `updater` profile is off, and picks up new container
  addresses (`valid=10s`).
- `proxy_intercept_errors on` lets `error_page` handle error statuses that the app itself
  returns; an unreachable upstream produces a 502 that `error_page` handles as well.
- `error_page ... = @maintenance` hands the request to the named location, which rewrites it
  to the page and proxies it to the sidecar. With a variable in `proxy_pass` and no URI part,
  nginx passes the rewritten URI.

### Traefik

Not part of the examples; adapt and test it with the app stopped. Traefik's `errors`
middleware fetches the page from a service when the router's service answers with a matching
status. With the file provider:

```yaml
http:
  routers:
    app:
      rule: Host(`notes.example.com`)
      service: app
      middlewares: [maintenance]
    updater-public:
      rule: Host(`notes.example.com`) && PathPrefix(`/public/v1/`)
      service: updater
  middlewares:
    maintenance:
      errors:
        status: ["502-504"]
        service: updater
        query: /public/v1/maintenance/
  services:
    app:
      loadBalancer:
        servers:
          - url: http://api:3000
    updater:
      loadBalancer:
        servers:
          - url: http://updater:8090
```

- The longer rule of `updater-public` gives it priority over `app` for `/public/v1/`.
- Traefik must be attached to the network the app and the sidecar are on.
- Define the app's router in the file provider (or on a service that keeps running), not as
  labels on the app container: Traefik's Docker provider builds routers from running
  containers, so a router defined on the app container disappears while it is stopped, and
  the request ends in a 404 instead of the maintenance page.

### Edges that serve files themselves

`cicd-updater maintenance-page export --out <dir>` writes `index.html`, `maintenance.css`,
`maintenance.js` and the logo into a directory, for edges that should not proxy the page:

```sh
docker compose exec updater cicd-updater maintenance-page export \
  --out /opt/notes/edge/maintenance --asset-base /maintenance/
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--asset-base URL` | empty: relative URLs (`maintenance.css`), the files next to each other | prefix of the stylesheet, script and logo URLs |
| `--status-url URL` | `/public/v1/status` | where the page reads the public status |
| `--home-url URL` | `/` | where the page goes when the update is over |

When the edge serves the exported page in place of any address, set `--asset-base` to the
absolute path under which it serves the files (`/maintenance/` above, with a matching
location in the edge). Keep forwarding `/public/v1/status` to the sidecar so the page can
show progress. When the sidecar is not running, the edge may answer the status
path with the idle document (`{"phase":"idle", ...}`) or an error; the page then keeps its
default text.

### A site that is its own edge

In the [static-site](../examples/static-site/) example nginx serves the site and is the
managed service itself, so the site is briefly unavailable while nginx is replaced. When an
outer reverse proxy sits in front, let it fall back to
`http://updater:8090/public/v1/maintenance/` as above.

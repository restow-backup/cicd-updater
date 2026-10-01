# The sidecar's HTTP API, for backends in any language

Go, PHP, Java, .NET, Ruby or anything else: your backend makes the same few calls the
TypeScript and Python templates make. This page lists them with `curl`;
[updater-api.sh](updater-api.sh) runs them from inside your backend container. The full
contract is the [HTTP API reference](https://github.com/restow-backup/cicd-updater/blob/main/docs/http-api.md)
and the [OpenAPI document](https://github.com/restow-backup/cicd-updater/blob/main/openapi/updater-api.v1.yaml),
from which you can generate a client. Keep a generated client tolerant: ignore unknown
fields and unknown codes.

## Wiring

| What | Value |
| --- | --- |
| Base URL | `http://updater:8090` on the internal Compose network (`UPDATER_URL`). The sidecar has no published port. |
| Token | `/run/cicd-updater/token`, the sidecar's shared volume mounted read-only into your backend only. Trim it, read it on every call (or cache it for 30 seconds), read it again after a `401`. |
| Header | `Authorization: Bearer <token>` on everything under `/v1`. Never follow a redirect with it. |
| Timeouts | 5 seconds; 120 seconds for releases, verification and scheduling (the sidecar asks the release host, the registry and, in keyless mode, Sigstore first). |
| Errors | RFC 9457 problem documents (`application/problem+json`) with a `code`. Branch on `code`, show a translated text, never parse `detail`. |
| No sidecar | Connection refused, no token file, a `401` after a re-read, or a `502` from a proxy: the sidecar is opt-in, so treat it as "updates from the app are not available here" and show the manual steps. |

## The calls

```sh
TOKEN="$(tr -d '[:space:]' < /run/cicd-updater/token)"
AUTH="Authorization: Bearer $TOKEN"

# The admin page: phase, current run, running version, blockers, trust mode
curl -s -H "$AUTH" http://updater:8090/v1/state

# The available releases, newest first, each with refusals and releaseSha256 (slow)
curl -s -H "$AUTH" http://updater:8090/v1/releases

# Schedule: requestedBy is the acting admin; expect.releaseSha256 is the hash the admin saw
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' http://updater:8090/v1/runs \
  -d '{"version":"1.4.0","leadSeconds":900,
       "requestedBy":{"id":"42","label":"alice@example.com"},
       "expect":{"releaseSha256":"<64 hex from /v1/releases>"}}'

# Cancel a scheduled run, or abort a running one before the point of no return
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  http://updater:8090/v1/runs/<runId>/cancel -d '{"requestedBy":{"id":"42","label":"alice@example.com"}}'

# Acknowledge a finished run (the phase returns to idle)
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' \
  http://updater:8090/v1/runs/<runId>/acknowledge -d '{"requestedBy":{"id":"42","label":"alice@example.com"}}'

# The journal for your audit log, after your stored cursor
curl -s -H "$AUTH" 'http://updater:8090/v1/events?after=<last event id>&limit=100'

# The public status (no token): what your edge forwards for the maintenance page
curl -s http://updater:8090/public/v1/status
```

The command line above shows the token in the process list; in code, send it as a header
from memory. `updater-api.sh` passes it to curl on standard input.

## The endpoints your backend offers

Your frontend never talks to the sidecar. Offer these routes (the shapes of
[../node/updates.ts](../node/updates.ts), so both frontends of the template work
unchanged):

| Your route | Who | Sidecar call | Answer |
| --- | --- | --- | --- |
| `GET /api/maintenance` | every signed-in user | `GET /v1/state` | the public status shape plus `targetVersion` and `fromVersion` (`maintenanceViewOf` in the SDK, `maintenance_view` in [../python/updates.py](../python/updates.py)); idle when no sidecar answers |
| `GET /api/admin/updates` | installation admin | `GET /v1/state` | `{ state, leadTimes: [0,60,300,900,1800,3600], stepUpMaxAgeSeconds: 600 }`; `state: null` without a sidecar |
| `GET /api/admin/updates/releases` | installation admin | `GET /v1/releases` (`?refresh=true` for `?refresh=1`) | the `ReleasesView` |
| `POST /api/admin/updates` | installation admin, strong sign-in younger than 10 minutes | `POST /v1/runs` | `202` with the new `StateView` |
| `POST /api/admin/updates/{runId}/cancel` | installation admin | `POST /v1/runs/{runId}/cancel` | the `StateView` |
| `POST /api/admin/updates/{runId}/acknowledge` | installation admin | `POST /v1/runs/{runId}/acknowledge` | the `StateView` |

Errors: `{ "code": "..." }` with the status, and for sidecar problems the extensions
`blockers`, `reasons`, `errors`, `feedError` with the sidecar's status (a `409 blocked`
stays `409`). No sidecar is `503 { "code": "updater_unavailable" }`. Missing step-up is
`403 { "code": "step_up_required" }`.

Your backend's jobs, whatever the language:

1. **Authorization**: only installation admins; impersonated sessions never count.
2. **Step-up**: scheduling needs a strong sign-in (passkey, password plus TOTP, OIDC)
   younger than 10 minutes.
3. **requestedBy** on every action, **expect.releaseSha256** when scheduling.
4. **JSON only** on POST (`Content-Type: application/json`), plus your CSRF protection.
5. **Audit**: copy the journal exactly once (cursor and audit entry in one transaction,
   [app integration](https://github.com/restow-backup/cicd-updater/blob/main/docs/app-integration.md#2-audit-via-the-journal));
   record denied and refused attempts yourself.
6. **Health with version**: readiness for everyone, `version` only when the request
   carries the sidecar's token, compared in constant time.

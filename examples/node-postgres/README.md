# Example: node-postgres (integration level 3)

Notes is a small TypeScript app (an HTTP API and a background worker) with PostgreSQL,
released by GitHub Actions with keyless signing and updated by the cicd-updater sidecar
from a button in its admin page.

| | |
| --- | --- |
| App | `app/`: `src/server.ts` (API, health, admin endpoints), `src/worker.ts`, run by Node.js 24 without a build step |
| Edge | `web/`: Caddy serving the admin page (`src/web/admin.tsx`, React) and the maintenance fallback |
| Database | PostgreSQL 17, migrations with node-pg-migrate, run by `hooks.migrate` |
| Release | `.github/workflows/release.yml`: native amd64 and arm64 builds, smoke test with the upgrade from the previous release through the sidecar, keyless signing |
| Trust | `trust.keyless.github` (this repository and its release workflow) |
| Backup | `postgres` (pg_dump custom format, verified with `pg_restore --list`) |
| Rollback | `probe`, with the `node-pg-migrate` preset and the schema fingerprint |
| Health | `http://api:3000/healthz`; the version is only shown to the updater's token |

## What the app does for the updater

- `GET /healthz` always answers readiness and adds `version` only when the request carries
  the sidecar's token (`createTokenVerifier`). The sidecar compares that version with the
  release it installed.
- `GET /api/maintenance` returns the run summary to every signed-in user; the React banner
  (`useMaintenance`, `MaintenanceBanner`, `UpdateProgress`) polls it, and while the API is
  down it polls the edge's `/public/v1/status` instead and reloads when the new version answers.
- `/api/admin/updates` lets an admin schedule, cancel and acknowledge updates through the SDK
  client. The demo protects it with a bearer token; a real app allows only an installation
  admin and asks for a recent strong sign-in before scheduling (docs/app-integration.md).
- Every 30 seconds the API copies the sidecar's journal into its `audit_log` table, each event
  and the cursor in one transaction (`syncJournal`), so the audit trail is complete exactly once.

## From clone to the first update

1. **Release workflow.** Replace `acme/notes` with your repository in `updater.yaml`,
   `.github/workflows/release.yml` and the image names. Push a tag `v1.0.0`. The workflow builds,
   smoke-tests, signs and publishes the release with `release.json`.
2. **Host.** Copy this directory (without `app/` and `web/`, which are only needed to build) to
   the server, for example to `/opt/notes`. Copy `.env.example` to `.env`, set `PROJECT_DIR`,
   the passwords and the two image variables of `v1.0.0` (with their digests, as the release
   page shows them).
3. **Verify and pin the sidecar image**, then set `CICD_UPDATER_IMAGE` to `...@sha256:<digest>`:

   ```sh
   cosign verify ghcr.io/restow-backup/cicd-updater:1.0.0 \
     --certificate-identity https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v1.0.0 \
     --certificate-oidc-issuer https://token.actions.githubusercontent.com
   ```

4. **Start** the app with the sidecar and check the setup:

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   ```

5. **Release `v1.1.0`** by pushing the tag. Then update from the admin page, or on the host:

   ```sh
   docker compose exec updater cicd-updater releases
   docker compose exec updater cicd-updater schedule 1.1.0 --in 15m
   docker compose exec updater cicd-updater status
   ```

Without the `updater` profile nothing changes: the app runs as before and the admin page
shows the manual update steps (docs/getting-started.md).

## Try the mechanics locally

`make update-demo` builds 1.0.0 and 1.1.0 on your machine, pushes them to a local registry,
starts 1.0.0 with the sidecar and updates it to 1.1.0. It uses trust mode `none` with a local
file feed (`demo/updater.yaml`), because nothing is signed there: a demo of the mechanics, not
a production setup. `make demo-down` removes everything it created.

Before the first build, create the lock file once (`cd app && npm install`) and commit
`app/package-lock.json`; the Dockerfiles install with `npm ci`.

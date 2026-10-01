# Example: python-postgres (integration level 2)

FastNotes is a FastAPI app with PostgreSQL, released by Forgejo Actions with a cosign key
pair into the Forgejo container registry, and updated by the cicd-updater sidecar. The app
talks to the sidecar's HTTP API directly with `httpx` (no SDK) and copies its journal into
its audit log in SQL.

| | |
| --- | --- |
| App | `app/fastnotes/main.py` (FastAPI), Alembic migrations run at container start |
| Edge | nginx (`nginx/default.conf`), not managed by the updater, with the maintenance fallback |
| Database | PostgreSQL 17 |
| Release | `.forgejo/workflows/release.yml`: QEMU build for amd64 and arm64, smoke test, `signing: key`, Forgejo registry, `release-host: gitea` |
| Trust | `trust.key.publicKeyFiles` (the public half of the workflow's key pair) |
| Backup | `postgres`, encrypted with `age` to the recipient in `updater.yaml` |
| Rollback | `probe`, with the `alembic` preset |
| Health | `http://api:8000/health` with a condition: the database check must say `ok` |

## What the app does for the updater

- `GET /health` answers readiness (with its own database check) and adds `version` only for
  the sidecar's token, compared in constant time with the shared token file.
- `/admin/updates` reads the state and schedules, cancels or acknowledges runs through
  `GET /v1/state`, `POST /v1/runs` and `POST /v1/runs/{id}/cancel|acknowledge`. Redirects are
  not followed, so the token never leaves for another host.
- A background task copies new events from `GET /v1/events?after=<cursor>` into `audit_log`;
  each event and the cursor are written in one transaction, so every event lands exactly once.

## From clone to the first update

1. **Key pair.** `cosign generate-key-pair`; store `cosign.key` and its password as the
   repository secrets `COSIGN_KEY` and `COSIGN_PASSWORD`, plus `REGISTRY_TOKEN` (write:package)
   and `RELEASE_TOKEN` (write:repository). Copy `cosign.pub` to the server.
2. **Release workflow.** Replace `git.example.com/acme/fastnotes` in the workflow, the
   Compose file and `updater.yaml`. Push a tag `v1.0.0`.
3. **Host.** Copy this directory to `/opt/fastnotes` (without `app/`), with `cosign.pub`, a
   feed token in `feed-token` (read access, for a private repository) and `registry-auth.json`
   (a Docker `config.json` with an `auths` entry for the registry, read:package). Copy
   `.env.example` to `.env` and fill it in. Generate your own age key pair (`age-keygen`), put
   the recipient into `updater.yaml` and keep the identity off the server.
4. **Verify and pin the sidecar image** (README of the repository), then start:

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   ```

5. **Release `v1.1.0`**, then schedule it through the admin endpoint or on the host:
   `docker compose exec updater cicd-updater schedule 1.1.0 --in 15m`.

Restoring an encrypted backup needs the age identity on the operator's machine;
`cicd-updater recover show` prints the commands (docs/backups-and-recovery.md).

## Try the mechanics locally

`make update-demo` builds 1.0.0 and 1.1.0, pushes them to a local registry and updates 1.0.0
to 1.1.0 through the sidecar, with trust mode `none` and a local file feed
(`demo/updater.yaml`): a demo of the mechanics, not a production setup. `make demo-down`
removes everything it created.

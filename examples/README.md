# Examples

Three complete projects, each from "clone" to "first update". They differ in the stack, the
CI system, the trust mode and how deeply the app integrates with the updater.

| | [node-postgres](node-postgres/) | [python-postgres](python-postgres/) | [static-site](static-site/) |
| --- | --- | --- | --- |
| App | TypeScript HTTP server and worker | FastAPI | static HTML with nginx |
| Database | PostgreSQL 17 | PostgreSQL 17 | none |
| Migrations | node-pg-migrate via `hooks.migrate` | Alembic at container start | none |
| Integration level | 3: admin page with the SDK, `syncJournal`, `createTokenVerifier`, React banner | 2: HTTP API with `httpx`, journal in SQL | 1: CLI only |
| CI and signing | GitHub Actions, keyless, native arm64 runner | Forgejo Actions, cosign key pair, Forgejo registry | GitHub Actions single job (QEMU), keyless; GitLab CI alternative |
| Backup | `postgres` | `postgres`, encrypted with age | `none` |
| Rollback | `probe` | `probe` | `always` |
| Edge | Caddy with the maintenance fallback | nginx with the maintenance fallback | the site itself |

Every example has `docker-compose.yml` (the updater as an opt-in profile), `.env.example`,
`updater.yaml`, `.cicd-updater/release-policy.yaml`, its release workflow, and
`make update-demo`, which builds two versions locally and updates one to the other through
the sidecar ([update-demo.sh](update-demo.sh), trust mode `none` with a local file feed: a
demonstration of the mechanics, not a production setting).

# Example: static-site (integration level 1)

Acme Handbook is a static site served by nginx. It has no database and no app code that
knows about the updater: the operator updates it with the CLI on the host. This is the
smallest setup and shows the pieces every project needs.

| | |
| --- | --- |
| Image | `Dockerfile`: nginx (unprivileged) with `site/` and a generated `version.json` |
| Release | `.github/workflows/release.yml`: the single-job action `release` (QEMU for arm64), keyless signing; `ci-alternatives/gitlab-ci.yml` does the same on GitLab CI |
| Trust | `trust.keyless.github` |
| Backup | `none` (nothing to back up) |
| Rollback | `always` (nothing is migrated, going back is always safe) |
| Health | `http://web:8080/version.json`, `$.version` must be the new version |
| Smoke | `http://web:8080/` contains the product name |

## From clone to the first update

1. Replace `acme/handbook` in `updater.yaml` and the workflow. Push a tag `v1.0.0`; the
   workflow builds both architectures, smoke-tests, signs and publishes the release.
2. On the server, copy this directory to `/opt/handbook`, copy `.env.example` to `.env` and
   set `PROJECT_DIR` and `WEB_IMAGE` (with the digest from the release page).
3. Verify and pin the sidecar image (see the repository README), then start and check:

   ```sh
   docker compose --profile updater up -d
   docker compose exec updater cicd-updater doctor
   ```

4. After the next release:

   ```sh
   docker compose exec updater cicd-updater releases
   docker compose exec updater cicd-updater schedule 1.1.0 --in 5m
   docker compose exec updater cicd-updater status
   ```

The site itself is the edge, so it is briefly unavailable while nginx is replaced. When an
outer reverse proxy sits in front, let it fall back to the sidecar's maintenance page
(`http://updater:8090/public/v1/maintenance/`, docs/maintenance-page.md).

## Try the mechanics locally

`make update-demo` builds 1.0.0 and 1.1.0, pushes them to a local registry and updates the
site through the sidecar with trust mode `none` and a local file feed: a demo of the
mechanics, not a production setup. `make demo-down` removes everything.

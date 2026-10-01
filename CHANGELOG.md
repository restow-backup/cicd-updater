# Changelog

All notable changes to this project are documented in this file. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/) for all of its contracts
([docs/versioning.md](docs/versioning.md)).

## [Unreleased]

## [1.0.0] - YYYY-MM-DD

The first release. It establishes the 1.x contracts listed below; within 1.x they change
only in backward-compatible ways.

### Added

- Contract: `release.json` schema 1 (`schemas/release.schema.json`), signed with cosign
  `sign-blob` into `release.json.sigstore.json`, and the feed index schema 1
  (`schemas/feed-index.schema.json`) for static and file feeds.
- Contract: `updater.yaml` version 1 (`schemas/updater-config.schema.json`) with environment
  overrides `CICD_UPDATER_<SECTION>__<KEY>`.
- Contract: HTTP API `/v1` and the public status `/public/v1/status`
  (`openapi/updater-api.v1.yaml`, OpenAPI 3.1, errors as RFC 9457 problem documents).
- Contract: failure, blocker, warning, message and problem codes, outcomes and phases.
- The sidecar image `ghcr.io/restow-backup/cicd-updater` (linux/amd64, linux/arm64) with the
  `cicd-updater` CLI: `serve`, `version`, `config check`, `doctor`, `healthcheck`, `status`,
  `releases`, `verify`, `schedule`, `reschedule`, `cancel`, `ack`, `logs`, `backups`,
  `recover show`, `recover restore-env`, `maintenance-page export`, `release`.
- The update engine: verify, fetch, backup, stop, apply, start, health, smoke; the point of
  no return at the stop step; rollback only when certain (`rollback.policy` probe, always,
  never); resume after a restart; `needs_attention` with recovery commands.
- Trust modes `keyless` (GitHub Actions, GitLab CI, generic issuer with an exact identity
  template), `key` (cosign public keys, rotation) and `none` (explicitly acknowledged). The
  verifier runs cosign in an isolated sibling container.
- Backups: PostgreSQL, MySQL/MariaDB, volume archives, a custom command, or none; each
  verified, optionally encrypted with age, with retention by count and age and a protected
  backup for the newest `needs_attention` run.
- Migration probe presets for drizzle, prisma, knex, alembic, django, flyway, rails,
  golang-migrate, node-pg-migrate, typeorm and sequelize, with an optional schema fingerprint.
- Health checks over HTTP (version and conditions) or a command, crash detection, Docker
  healthchecks; smoke checks.
- Feed providers for GitHub, Forgejo/Gitea and GitLab releases, a static index and a local
  directory, behind an SSRF guard (public addresses only unless allowed, no connection
  pooling, redirects checked by hand, size caps).
- Source mode (off by default): build from the tagged source archive of an allowlisted
  repository.
- Release side: composite actions `build`, `smoke`, `publish`, `release-json` and `release`,
  workflow templates for GitHub Actions, Forgejo/Gitea Actions and GitLab CI, and the
  `release` CLI (`env-check`, `json create|validate|sign|verify`, `sign-images`, `upload`,
  `smoke`, `build`, `index`, `sbom`, `version`, `check-tag`).
- The SDK `@restow-backup/cicd-updater` with the entry points `.`, `/feed`, `/auth`,
  `/protocol`, `/semver`, `/messages` (also the texts of an admin "Updates" page in English
  and German), `/maintenance` (the banner's polling logic without React) and `/react`.
- Examples: node-postgres (level 3), python-postgres (level 2), static-site (level 1).
- `templates/web-app`: a copy-paste starter for connecting an existing web app: the sidecar
  as a Compose fragment, a commented `updater.yaml`, the release workflow and policy,
  backend endpoints with authorization, step-up and audit hooks (TypeScript with Express
  and Hono adapters, FastAPI, a plain HTTP reference), health with version, migration
  probe queries, the admin "Updates" page and the maintenance banner (React and plain
  JavaScript), and an integration checklist. Type-checked against the SDK in CI.
- `README.de.md`: the README in German.
- The end-to-end suite (`pnpm e2e`, `e2e/`): Docker-in-Docker with distribution/registry v3
  over TLS, releases built and signed with the `release` CLI, and scenarios for trust,
  failures and rollback, restarts, locks and blockers, real backups and their restores,
  the three examples and the release tools. Results in `docs/compatibility.md`.

### Fixed (found by the end-to-end run)

- Key-mode signing with cosign 3: `--tlog-upload=false` needs `--use-signing-config=false`.
- A signature by another key was reported as `fetch.signature_missing` with cosign 3; it is
  `fetch.signature_invalid`.
- Image pruning did nothing on Docker 29, which lists untagged images only with `--all`.
- `cicd-updater version` reported the Docker CLI as "not available" without a daemon.
- The release smoke's upgrade through the sidecar: its files lie in the checkout (the
  sidecar container mounts them), the sidecar gets the smoke's Compose files, and the
  teardown removes the sidecar too.
- The free-space check measures the file system of the backups directory (a separate
  volume at `/state/backups` works); the changelog check names a placeholder date.
- static-site: the image build failed (nginx-unprivileged runs as uid 101).
- node-postgres: the first install creates the schema (README, update demo); the example
  ships its lock file. The examples' `UPDATER_URL=` switches the in-app updates off.
- `templates/github/release.yml`: no version check in the token-less smoke by default.
- The React banner announces only state changes; the countdown is outside the live region.

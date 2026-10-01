# cicd-updater 1.0: design specification

| | |
| --- | --- |
| Status | Draft for implementation (1.0 contract) |
| Repository | https://github.com/restow-backup/cicd-updater |
| License | Apache-2.0, Copyright IT Systeme Flores UG (haftungsbeschränkt) |
| Audience | the implementer of 1.0, reviewers, adopters who want to know what 1.0 promises |
| Origin | extracted from the opt-in updater of Restow (Apache-2.0) and checked against operational lessons from other production deployments of the same maintainer |

This document is normative for 1.0. The key words MUST, MUST NOT, SHOULD, SHOULD NOT
and MAY are used as in RFC 2119. Where this document says "to be verified in the e2e",
the claim is not established yet; the implementation MUST add the named test and record
its result in `docs/compatibility.md` before 1.0 is tagged.

Names used throughout:

| Term | Meaning |
| --- | --- |
| app | the program that is updated (any language), run with Docker Compose |
| sidecar | the `cicd-updater` container on the host; the only component that holds the Docker socket |
| release side | the CI that builds, signs and publishes the app's images and `release.json` |
| SDK | the TypeScript package an app MAY use to talk to the sidecar and to read the release feed |
| managed service | a Compose service whose image the sidecar replaces (listed in `updater.yaml`) |
| writable key | a key in the Compose env file that the sidecar is allowed to rewrite |
| run | one update attempt, from scheduling to its end state |
| point of no return (PONR) | the start of the `stop` step; before it, nothing was stopped or replaced |
| trust mode | how image and `release.json` authenticity is established: `keyless`, `key` or `none` |

---

## 0. The decisions in one page

1. **Three sides, one contract.** The release side publishes a signed, machine-readable
   `release.json` next to signed multi-arch images; the sidecar installs only what that
   document and the signatures allow; the app only asks. `release.json` replaces digests
   parsed from release notes.
2. **Explicit trust modes, no silent downgrade.** `keyless` (Sigstore, GitHub Actions or
   GitLab CI OIDC), `key` (cosign key pair, for Forgejo/Gitea Actions and private
   infrastructure) or `none` (digests only, explicit and acknowledged, shown on every run).
   A missing or invalid signature in `keyless`/`key` mode is a hard failure; the sidecar
   never falls back to `none`.
3. **`release.json` is signed too** (cosign `sign-blob`, Sigstore bundle as a release asset),
   with the same identity as the images. That binds version, image digests, minimum
   version and manual steps together; a tampered release asset cannot swap images between
   services, lower the minimum version or hide manual steps.
4. **Exact keyless identity, composite actions instead of a reusable workflow for signing.**
   The certificate identity is the app's own workflow at the exact tag. A reusable workflow
   would put *our* workflow into the certificate and let any caller's images pass; 1.0
   therefore ships composite actions and copyable workflow templates.
5. **Pull by digest, write `repo:tag@sha256:...`.** The sidecar verifies the signature of
   `repo@digest`, pulls exactly that digest and writes a digest-pinned reference into the env
   file. There is no window in which a moved tag can change what runs.
6. **Rollback only when it is certain.** After new images were applied, the sidecar rolls
   back only if the app has no persistent schema (`rollback.policy: always`) or a migration
   probe proves the schema is unchanged after freezing the new services; otherwise it stops
   the app, keeps the backup and reports *needs attention*. It never guesses.
7. **The sidecar never updates itself and never runs what it installed.** Its own image is
   pinned by the operator; it refuses to update while its own service would follow a key it
   rewrites. Hooks (backup, probe, health, smoke) come only from `updater.yaml`, never from
   an API request.
8. **Pull model, local durable state.** The run's state is an atomically written
   `status.json` in the sidecar's volume; the app polls and ingests journal events with a
   cursor (exactly once). Nothing depends on a final report reaching the app while the app
   is being replaced.
9. **What does not start is not published.** The release actions push by digest, run a
   smoke test against those digests (with the production Compose file, `.env.example` and
   empty optional variables, optionally upgrading from the previous release with the
   sidecar itself), and only then tag, sign and publish.
10. **One npm package, optional npm.** The SDK ships as one self-contained package
    (`@restow-backup/cicd-updater`, subpath exports) installable from the GitHub release
    tarball; publishing to npm later changes nothing in the API.

---

## 1. Scope and non-goals for 1.0

### 1.1 In scope

- Apps run with **Docker Compose v2** on a single Linux host, whose service images come from
  variables in the Compose env file (default `.env`).
- **Image mode** (default): install images that a CI built, pushed to a registry and (in
  `keyless`/`key` mode) signed.
- **Source mode** (off by default): fetch the tagged source archive of an allowlisted
  repository and build the images on the host. Unsigned by nature (section 8.4).
- Pre-update **backup** (PostgreSQL, MySQL/MariaDB, volume archive, custom command, or none),
  **migration probe**, optional separate **migration** step, **health** check with version,
  **smoke** checks, **rollback** by rule, **recovery** information.
- Scheduling with a lead time or at an absolute time, rescheduling, cancelling, aborting
  before the point of no return, a public read-only status for maintenance pages.
- Release-side tooling for GitHub Actions, Forgejo/Gitea Actions and GitLab CI.
- An HTTP API (`/v1`), a CLI inside the sidecar, a TypeScript SDK and optional React
  components.

### 1.2 Non-goals for 1.0

| Not in 1.0 | Why / what instead |
| --- | --- |
| Kubernetes, Docker Swarm, Nomad, plain `docker run` scripts | different lifecycle model; Compose only |
| Podman | only through its Docker-compatible API, **untested**; no support promise |
| Multi-host apps, remote Docker hosts | the sidecar manages the Compose project it runs next to |
| Zero-downtime / blue-green switching | needs proxy-specific routing and per-migration compatibility analysis; 1.0 uses an announced maintenance window. Candidate for a later "side-by-side" strategy |
| Updating images the app's vendor does not sign or publish digests for (e.g. third-party database images) | the target group is the adopter's own programs; third-party images stay operator-managed |
| Editing Compose files, `.env` keys other than the configured writable keys, or any file outside the env file | operator-owned; a release that needs such changes sets `manualSteps.required` |
| Automatic database restore | destructive; the sidecar prints the exact commands and keeps the backup |
| Self-update of the sidecar | the container that holds the socket changes only by operator action |
| Arbitrary post-update commands that change state | hooks are read-only checks except backup and the optional migration step |
| An operator web UI with control actions inside the sidecar | 1.0 offers the CLI and the read-only public status page (open question Q4) |
| Windows/macOS hosts in production | Docker Desktop and colima work for development only |

### 1.3 Integration levels

| Level | App changes | How the operator/admin interacts | Typical user |
| --- | --- | --- | --- |
| 1. No app changes | none (the app should still expose a health endpoint) | `docker compose exec updater cicd-updater ...` (CLI); optional maintenance page served by the sidecar behind the app's edge | static sites, small tools, apps the adopter cannot change |
| 2. Any language | the app calls the sidecar's HTTP API (`/v1`, OpenAPI 3.1) from its backend | the app's own admin UI; the app does authorization, step-up and audit | Python, Go, PHP, Java apps |
| 3. TypeScript comfort | the app uses `@restow-backup/cicd-updater` (client, feed check, auth helper) and optionally its React components | same as level 2 with less code | Node/TypeScript apps |

All three levels drive the same engine; the CLI is a client of the same HTTP API inside the
container.

---

## 2. Architecture

### 2.1 Overview

```
┌──────────────────────────┐  push by digest, ┌──────────────────────────┐
│ RELEASE SIDE (CI)        │  index, sign     │ REGISTRY                 │
│ build → smoke →          │─────────────────▶│ multi-arch images and    │
│ publish → release-json   │                  │ signatures (by digest)   │
└────────────┬─────────────┘                  └─────────────▲────────────┘
             │ release.json + bundle                        │ verify signature,
             ▼                                              │ pull by digest
┌──────────────────────────┐  feed   ┌──────────────────────┴─────────────────────────────┐
│ RELEASE HOST             │◀────────│ HOST: one Compose project, internal network        │
│ GitHub / Forgejo / Gitea │ (sidecar│                                                    │
│ / GitLab releases, or a  │ and app │  ┌─────────────┐  Bearer token  ┌───────────────┐  │
│ static index             │  SDK)   │  │ app backend │ ─────────────▶ │ updater       │  │
└──────────────────────────┘         │  │ (SDK/HTTP)  │ ◀───────────── │ sidecar       │  │
                                     │  └─────────────┘ health+version │ docker.sock   │  │
                                     │  ┌─────────────┐                │ .env (keys)   │  │
                                     │  │ edge/proxy  │ ◀───────────── │ status.json   │  │
                                     │  └──────▲──────┘ public status  │ backups       │  │
                                     │         │        (read-only)    └───────────────┘  │
                                     └─────────┼──────────────────────────────────────────┘
                                               │
                                     browsers: users, maintenance page
```

Network rules:

- The sidecar listens only on an internal Compose network; it MUST NOT have published ports
  (blocker `api_exposed`, section 5.11).
- The browser never talks to the sidecar's authenticated API. The edge MAY forward exactly
  `/public/v1/status` (and the optional maintenance page assets) read-only.
- Outbound traffic of the sidecar: the release host (feed), the registries of the managed
  images, Sigstore (keyless mode: TUF root and transparency log; nothing in `key` mode with
  the transparency log off) and, in source mode, the allowlisted repository host. Nothing
  else; there is no telemetry and no update check of the sidecar itself unless enabled.

### 2.2 Release side

Composite actions under `actions/` (GitHub Actions and Forgejo/Gitea Actions, which run
composite actions) plus the same logic as a CLI (`cicd-updater release ...`, shipped in the
sidecar image) for GitLab CI and any other CI. Section 10.6 lists inputs and outputs.

```
 ┌────────────┐   ┌────────────┐   ┌──────────────┐   ┌────────────────┐   ┌──────────────┐
 │ verify tag │──▶│ build per  │──▶│ smoke        │──▶│ publish        │──▶│ release-json │
 │ (semver,   │   │ arch, push │   │ (digests,    │   │ index, tags,   │   │ create, sign │
 │ policy)    │   │ by digest  │   │ .env.example,│   │ sign images    │   │ upload, then │
 └────────────┘   │ untagged   │   │ upgrade-from)│   │ (mode)         │   │ publish rel. │
                  └────────────┘   └──────────────┘   └────────────────┘   └──────────────┘
   nothing is tagged in the registry and no release is public before the smoke passed
```

Rules the release side MUST keep:

- Images are built for `linux/amd64` and `linux/arm64` (configurable), pushed **by digest
  without tags** first; the multi-arch index is created and tagged only after the smoke
  test passed (a failed run leaves untagged digests and a draft release, nothing public).
- Every image carries the OCI labels `org.opencontainers.image.version` (the release
  version without `v`), `.revision` (commit), `.source` (repository URL), `.created`.
- The signing mode is an explicit input `signing: keyless | key | none`
  (default `keyless` on GitHub Actions and GitLab CI; there is no default on other CI, the
  input is required there):
  - `keyless`: `cosign sign` of each multi-arch **index digest** with the CI's OIDC
    identity (GitHub: `id-token: write`; GitLab: `id_tokens: SIGSTORE_ID_TOKEN` with
    `aud: sigstore`), recorded in the public transparency log.
  - `key`: `cosign sign --key` with a private key from a CI secret (or a KMS URI cosign
    supports); the transparency log upload is off unless the input
    `transparency-log: true`. Works on Forgejo/Gitea Actions and with private registries.
  - `none`: no signature; `release.json` still carries the digests and records
    `signing.mode: "none"`.
- `release.json` is generated from the actual pushed index digests (never typed by hand),
  validated against the JSON Schema and, in `keyless`/`key` mode, signed with
  `cosign sign-blob --bundle release.json.sigstore.json` by the same identity or key.
- A published release is immutable: the publish step refuses when the image tag already
  exists with another digest or the release is already published (fix = new version).
- Both cosign invocations (release side and sidecar) use the **same pinned cosign minor
  version**, recorded in `release.json` (`signing.toolVersion`).

### 2.3 Host side: the sidecar

One container image, `ghcr.io/restow-backup/cicd-updater:<version>` (multi-arch, signed
keyless by the project's own release workflow, section 10.5). It contains: the Node.js
runtime and the sidecar, the Docker CLI, the Compose and Buildx plugins and cosign, all at
pinned versions with checksums verified at image build time, plus `tar`, `gzip` and `age`.

```
                         ┌──────────────────────────── sidecar process ─────────────────────────────┐
  HTTP :8090 ──────────▶ │ server (Hono)  ── auth (bearer, constant time) ── problem+json errors    │
  (internal network)     │      │                                                                   │
  CLI (exec, localhost)─▶│      ▼                                                                   │
                         │ engine (state machine) ── store (status.json, atomic) ── journal         │
                         │      │                                                                   │
                         │      ├── preflight (blockers, warnings, 30 s cache)                      │
                         │      ├── release (feed providers, release.json, bundle) ── SSRF guard    │
                         │      ├── trust (cosign: keyless | key | none) ── verifier container      │
                         │      ├── docker ops (docker / docker compose argv, never a shell)        │
                         │      ├── env file (byte-exact edit of writable keys)                     │
                         │      ├── hooks (backup, migrationProbe, migrate, health, smoke)          │
                         │      └── redactor (known secrets + credential patterns)                  │
                         └──────────────────────────────────────────────────────────────────────────┘
   volumes:  /var/run/docker.sock   <projectDir> (same path as on the host, rw)
             /state  (status.json, backups/, releases/, src/)   /shared (token, ro for the app)
             /verify (public verification inputs, mounted read-only into the verifier)
```

Principles carried over from Restow (each is a MUST):

- The sidecar holds no application credential: no `env_file`, no database password in its
  environment. It reads the env file only to edit writable keys and to register
  credential-looking values for redaction; built-in backup commands run inside the
  database container with that container's own environment.
- Every Docker operation is an argument vector for the `docker` binary; no shell string is
  ever built from data. Values from outside (image references, service names, file names,
  build arguments) are validated against strict patterns first.
- Signature verification runs in a **short-lived sibling container** of the sidecar's own
  image (resolved by image ID from self-inspection), without the Docker socket, with a
  read-only root file system, `--cap-drop ALL`, `no-new-privileges`, user `65534:65534`,
  `/tmp` as tmpfs and only the `/verify` volume (read-only) and a per-verification registry
  credential file. `trust.verifier.isolate: false` runs cosign as a subprocess instead
  (for environments that cannot start sibling containers; documented as weaker).
- State changes are written to `status.json` (temporary file, fsync, rename, directory
  fsync) **before** the side effect that follows them.
- Every message is a code with parameters; English log lines come from one table and pass
  the redactor.

### 2.4 App side

The app (level 2 or 3) has four jobs (section 7.6 gives the patterns):

1. **Authorization and step-up**: who may schedule, reschedule, cancel; recent strong
   sign-in for scheduling (the sidecar cannot know users).
2. **Audit**: ingest the sidecar's journal events into the app's own audit log, exactly once
   (cursor).
3. **Notification**: tell users an update is available (once per version), show the
   countdown banner and the maintenance overlay to every signed-in user.
4. **Health with version**: answer the sidecar's health request, revealing the running
   version only to a caller that presents the shared token.

The SDK provides the client, the SSRF-safe feed check, the token helper for the health
endpoint, semver/channel logic, i18n catalogs and (optionally) React components.

### 2.5 Sequence of a scheduled update

```
 admin ──▶ app: POST /admin/updates {version, leadSeconds}       (authz + step-up in the app)
 app ──▶ sidecar: POST /v1/runs {version, leadSeconds, requestedBy, expect.releaseSha256}
 sidecar: fetch release.json + bundle ── verify bundle ── check refusals ── verify image
          signatures in the registry (dry run, no pull) ── persist run (phase scheduled)
 sidecar ──▶ app: 202 {run}            app: audit "update.scheduled" via journal cursor
 every signed-in user: banner with countdown (app polls sidecar state, browser polls app)
 at startsAt: prepare ─ fetch ─ backup ─ stop ─ (migrate) ─ start ─ health ─ (smoke) ─ finish
 while the app is down: edge serves the maintenance page, which polls /public/v1/status
 end: status.json says succeeded | unchanged | rolled_back | needs_attention
 app (back up, new or old version): ingests journal events, notifies admins
```

### 2.6 Compose integration (normative example)

```yaml
# docker-compose.yml of the app (excerpt)
services:
  api:
    image: ${APP_IMAGE:?set APP_IMAGE in .env}
    volumes:
      - updater-shared:/run/cicd-updater:ro      # the shared token (read-only)
    networks: [internal]
  worker:
    image: ${APP_IMAGE:?set APP_IMAGE in .env}
    networks: [internal]
  web:
    image: ${WEB_IMAGE:?set WEB_IMAGE in .env}
    networks: [internal, public]
  db:
    image: postgres:17-alpine
    networks: [internal]

  updater:
    profiles: ["updater"]                          # opt-in
    image: ghcr.io/restow-backup/cicd-updater:1.0.0@sha256:<digest>   # never from a writable key
    restart: unless-stopped
    stop_grace_period: 30s
    labels:
      io.github.restow-backup.cicd-updater.role: sidecar
    environment:
      CICD_UPDATER_CONFIG: ${PROJECT_DIR:?}/updater.yaml
      CICD_UPDATER_COMPOSE__PROJECT_DIR: ${PROJECT_DIR:?}
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
      - ${PROJECT_DIR:?}:${PROJECT_DIR:?}          # same path inside and outside
      - updater-state:/state
      - updater-shared:/shared
      - updater-verify:/verify
    networks: [internal]                           # no ports:
    security_opt: ["no-new-privileges:true"]

volumes:
  updater-state:
  updater-shared:
  updater-verify:
networks:
  internal:
  public:
```

The project directory MUST be mounted at the same absolute path, so relative paths in the
Compose files resolve as on the host. The sidecar runs as root inside its container: with
the Docker socket, a non-root user does not reduce what the process can do, and it must be
able to replace the env file with its original owner and mode.

---
## 3. `release.json`: the contract between CI and sidecar

### 3.1 Content and example

One document per release, published as a release asset named exactly `release.json`. In
`keyless` and `key` mode a Sigstore bundle named exactly `release.json.sigstore.json`
accompanies it.

```json
{
  "schemaVersion": 1,
  "project": "github.com/acme/notes",
  "version": "1.4.0",
  "tag": "v1.4.0",
  "channel": "stable",
  "commit": "4f1c0b6e2a9d8c7b6a5f4e3d2c1b0a9f8e7d6c5b",
  "createdAt": "2026-11-02T18:04:11Z",
  "notesUrl": "https://github.com/acme/notes/releases/tag/v1.4.0",
  "images": {
    "app": {
      "repository": "ghcr.io/acme/notes",
      "tag": "1.4.0",
      "digest": "sha256:0f1e2d3c4b5a69788796a5b4c3d2e1f00f1e2d3c4b5a69788796a5b4c3d2e1f0",
      "platforms": ["linux/amd64", "linux/arm64"]
    },
    "web": {
      "repository": "ghcr.io/acme/notes-web",
      "tag": "1.4.0",
      "digest": "sha256:1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d5e6f708192a3b4c5d6e7f809",
      "platforms": ["linux/amd64", "linux/arm64"]
    }
  },
  "upgrade": {
    "minimumFromVersion": "1.2.0",
    "manualSteps": {
      "required": false,
      "summary": null,
      "url": null
    }
  },
  "requires": {
    "updater": ">=1.0.0",
    "env": ["NOTES_SEARCH_URL"]
  },
  "signing": {
    "mode": "keyless",
    "tool": "cosign",
    "toolVersion": "3.1.3"
  }
}
```

Semantics:

| Field | Meaning | Who enforces |
| --- | --- | --- |
| `schemaVersion` | always `1` for this schema; readers MUST reject other values they do not know | sidecar, SDK |
| `project` | `host/owner/repo` (or `host/group/subgroup/project` on GitLab) of the source repository; informational, but the sidecar MUST compare it (case-insensitive) with the configured feed repository when the feed is a repository (`release.mismatch` otherwise) | sidecar |
| `version` | plain SemVer `MAJOR.MINOR.PATCH[-pre]`, no `v`, no build metadata | sidecar, SDK |
| `tag` | the Git tag; MUST equal `release.tagPattern` rendered with `version` (default `v{version}`) | sidecar |
| `channel` | `stable` or `beta`; `beta` if and only if `version` has a pre-release part | sidecar, SDK |
| `commit` | 40 (SHA-1) or 64 (SHA-256) lowercase hex | informational |
| `createdAt` | RFC 3339 UTC time the document was generated | informational |
| `notesUrl` | https URL of the human release notes, or `null` | SDK/UI |
| `images.<key>` | one entry per published image; `<key>` is the name `updater.yaml` maps services to | sidecar |
| `images.<key>.digest` | digest of the **multi-arch index** (or of the single manifest when one platform) | sidecar |
| `images.<key>.platforms` | platforms in the index | sidecar (host platform must be listed) |
| `upgrade.minimumFromVersion` | lowest running version this release may be installed over; `null` = any | sidecar (refusal), SDK (path) |
| `upgrade.manualSteps.required` | `true`: the operator must act by hand (e.g. Compose file changes); the sidecar refuses to install it | sidecar (refusal), UI |
| `upgrade.manualSteps.summary/url` | plain text (≤ 2000 chars) and an https link explaining the steps | UI |
| `requires.updater` | SemVer range (`>=X.Y.Z`, `^X.Y.Z` or `X.Y.Z`); the sidecar refuses when its own version does not satisfy it | sidecar |
| `requires.env` | names of env keys that MUST be present and non-empty in the env file before this version can start | sidecar (names only, values are never read out) |
| `signing` | how the release side signed; informational, MUST NOT influence the trust policy | display |

Unknown fields MUST be ignored by readers (forward compatibility within schema version 1).
New optional fields may be added in 1.x; `schemaVersion: 2` is reserved for breaking
changes, and a sidecar 1.x MUST reject it (`release.unsupported_schema`).

### 3.2 JSON Schema (normative, `schemas/release.schema.json`)

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "$id": "https://raw.githubusercontent.com/restow-backup/cicd-updater/main/schemas/release.schema.json",
  "title": "cicd-updater release document",
  "type": "object",
  "required": ["schemaVersion", "project", "version", "tag", "channel", "createdAt", "images", "upgrade", "signing"],
  "properties": {
    "schemaVersion": { "const": 1 },
    "project": {
      "type": "string",
      "maxLength": 300,
      "pattern": "^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?(:[0-9]{1,5})?(/[A-Za-z0-9_.-]{1,100}){2,6}$"
    },
    "version": {
      "type": "string",
      "maxLength": 64,
      "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
    },
    "tag": { "type": "string", "maxLength": 128, "pattern": "^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$" },
    "channel": { "enum": ["stable", "beta"] },
    "commit": { "type": ["string", "null"], "pattern": "^([0-9a-f]{40}|[0-9a-f]{64})$" },
    "createdAt": { "type": "string", "format": "date-time" },
    "notesUrl": { "type": ["string", "null"], "maxLength": 2000, "pattern": "^https://" },
    "images": {
      "type": "object",
      "minProperties": 1,
      "maxProperties": 32,
      "propertyNames": { "pattern": "^[a-z][a-z0-9-]{0,31}$" },
      "additionalProperties": { "$ref": "#/$defs/image" }
    },
    "upgrade": {
      "type": "object",
      "required": ["minimumFromVersion", "manualSteps"],
      "properties": {
        "minimumFromVersion": {
          "type": ["string", "null"],
          "pattern": "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(-[0-9A-Za-z-]+(\\.[0-9A-Za-z-]+)*)?$"
        },
        "manualSteps": {
          "type": "object",
          "required": ["required"],
          "properties": {
            "required": { "type": "boolean" },
            "summary": { "type": ["string", "null"], "maxLength": 2000 },
            "url": { "type": ["string", "null"], "maxLength": 2000, "pattern": "^https://" }
          }
        }
      }
    },
    "requires": {
      "type": "object",
      "properties": {
        "updater": { "type": "string", "maxLength": 64, "pattern": "^(>=|\\^)?[0-9]+\\.[0-9]+\\.[0-9]+$" },
        "env": {
          "type": "array",
          "maxItems": 64,
          "uniqueItems": true,
          "items": { "type": "string", "pattern": "^[A-Za-z_][A-Za-z0-9_]{0,127}$" }
        }
      }
    },
    "signing": {
      "type": "object",
      "required": ["mode"],
      "properties": {
        "mode": { "enum": ["keyless", "key", "none"] },
        "tool": { "const": "cosign" },
        "toolVersion": { "type": "string", "maxLength": 32 }
      }
    }
  },
  "$defs": {
    "image": {
      "type": "object",
      "required": ["repository", "tag", "digest", "platforms"],
      "properties": {
        "repository": {
          "type": "string",
          "maxLength": 255,
          "pattern": "^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?(/[a-z0-9]+([._-][a-z0-9]+)*)+$"
        },
        "tag": { "type": "string", "pattern": "^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$" },
        "digest": { "type": "string", "pattern": "^sha256:[0-9a-f]{64}$" },
        "platforms": {
          "type": "array",
          "minItems": 1,
          "uniqueItems": true,
          "items": { "enum": ["linux/amd64", "linux/arm64"] }
        }
      }
    }
  }
}
```

Additional rules the JSON Schema cannot express (MUST be checked by the sidecar and the
`release-json` action):

- The document is UTF-8 JSON, at most 64 KiB, without a byte order mark.
- `channel === "beta"` if and only if `version` contains `-`.
- `tag` equals `release.tagPattern` rendered with `version` (sidecar side); the action
  checks it against the Git tag it ran for.
- `images.<key>.tag` equals `version` (image tags carry the version without `v`).
- `minimumFromVersion`, when set, is strictly lower than `version`.

The JSON Schemas for `updater.yaml`, `status.json`, the public status and the static feed
index are generated from the zod definitions in `packages/protocol` and committed under
`schemas/`; CI fails when the committed files differ from the generated ones.

### 3.3 Publication and discovery

The sidecar and the SDK find releases through a **feed provider** (`release.feed.type`):

| Provider | Release list | Asset download | Notes |
| --- | --- | --- | --- |
| `github` | `GET https://api.github.com/repos/{owner}/{repo}/releases?per_page=30` | public: the asset's `browser_download_url`; private: `GET .../releases/assets/{id}` with `Accept: application/octet-stream` and the token | redirects to GitHub's asset CDN are cross-origin (section 7.3) |
| `gitea` | `GET {base}/api/v1/repos/{owner}/{repo}/releases?limit=30` | the asset's `browser_download_url`, with the token when configured | covers Forgejo and Gitea; `{base}` may contain a path prefix |
| `gitlab` | `GET {base}/api/v4/projects/{url-encoded path}/releases?per_page=30` | `assets.links[]` whose `name` is `release.json` / `release.json.sigstore.json` (typically the generic package registry) | `upcoming_release: true` entries are skipped |
| `static` | `GET {url}` returning a feed index (below) | the URLs in the index | any https host (object storage, Pages) |
| `file` | `<path>/index.json` (a feed index) in a directory mounted into the sidecar | file names relative to `<path>` | air-gapped hosts and the release smoke test; sidecar only, not the SDK |

Feed index for `static` (`schemas/feed-index.schema.json`):

```json
{
  "schemaVersion": 1,
  "releases": [
    {
      "version": "1.4.0",
      "tag": "v1.4.0",
      "prerelease": false,
      "publishedAt": "2026-11-02T18:20:00Z",
      "releaseJson": "https://downloads.example.com/notes/1.4.0/release.json",
      "bundle": "https://downloads.example.com/notes/1.4.0/release.json.sigstore.json",
      "notesUrl": "https://downloads.example.com/notes/1.4.0/NOTES.md"
    }
  ]
}
```

Rules for every provider:

- Drafts are ignored. Entries whose tag does not render from a valid version through
  `release.tagPattern` are ignored. Entries without a `release.json` asset are listed by the
  SDK as "not installable by the updater" (`refusal: no_release_document`) and never
  installed in image mode (source mode builds from the tag and does not need one, 8.4).
- The provider's pre-release flag is used only to pre-filter the list; the signed
  `release.json` (`channel`) is authoritative.
- At most the 10 newest versions of the channel newer than the running version are
  resolved further (release.json downloaded and parsed).
- Size caps: release list 8 MiB, `release.json` 64 KiB, bundle 256 KiB. Timeouts: 10 s for
  the list, 15 s per asset. Responses are read as streams and abandoned past the cap.

### 3.4 Integrity

| Trust mode | `release.json` | Images |
| --- | --- | --- |
| `keyless` | bundle MUST verify for the exact identity (section 4.6) and issuer; the certificate's ref MUST be the release tag | each `repository@digest` MUST carry a valid signature of the same identity at the same tag |
| `key` | bundle MUST verify against one of the configured public keys | each `repository@digest` MUST carry a valid signature by one of the configured keys |
| `none` | not verified (fetched over https only); recorded as `not_checked` | not verified; the pulled image MUST still have the digest from `release.json` |

The sidecar verifies `release.json` **before** it trusts any field of it, and keeps the
verified bytes (`<stateDir>/releases/<version>/release.json` and the bundle) for the run.
At the start of the run it verifies those stored bytes again (no refetch) and checks that
their SHA-256 equals the one recorded at scheduling. A schedule request MAY carry
`expect.releaseSha256` (the SHA-256 the app showed the admin); a mismatch is refused
(`release_mismatch`), so what an admin read is what gets installed.

Why sign `release.json` instead of trusting image signatures alone: with image signatures
alone, someone who can edit release assets (but not run the workflow) could swap digests
between two images of the same release (both validly signed), drop `manualSteps.required`
or lower `minimumFromVersion`. The bundle closes that. Attaching the document as an
in-toto attestation to each image was considered and rejected for 1.0: it ties the
document to one image, needs registry support for attestations and is harder to fetch
before any image is known.

Image signature storage: cosign 3 stores signatures as OCI 1.1 referring artifacts by
default and falls back to the referrers tag schema (an index under the tag
`sha256-<digest>`) on registries without the referrers API; cosign 2 used the tag
`sha256-<digest>.sig`. The sidecar does not depend on the storage layout: it calls the
pinned cosign, which looks in the places its version writes to. Which registries accept
those artifacts is section 9.3.

---

## 4. Sidecar configuration: `updater.yaml`

### 4.1 Loading, precedence, validation

- Path: `CICD_UPDATER_CONFIG` (default `/etc/cicd-updater/updater.yaml`). YAML 1.2, UTF-8,
  at most 256 KiB, one document, no anchors or aliases. Unknown keys are an
  error (typos must not silently disable a safety setting).
- Precedence: built-in defaults < file < environment overrides (4.4).
- All problems are collected and printed together (one line each, path and reason); the
  process exits with code **64** and does not start the HTTP server. Secrets are never
  printed; a token file is reported by path only.
- `cicd-updater config check [--file <path>]` validates offline (no Docker, no network) and
  prints the effective configuration (redacted) and its SHA-256 (`configHash`, the hash of
  the canonical JSON of the effective configuration). The running sidecar shows the same
  hash in `GET /v1/config` and records it in every run.
- Configuration is read once at start. Changing it requires recreating the sidecar
  (`docker compose --profile updater up -d updater`); a run never sees two configurations.

### 4.2 Complete example

```yaml
version: 1

compose:
  projectDir: /opt/notes                  # usually set via CICD_UPDATER_COMPOSE__PROJECT_DIR
  envFile: .env

release:
  feed:
    type: github
    url: https://github.com/acme/notes
  channel: stable

trust:
  mode: keyless
  keyless:
    github:
      repository: acme/notes
      workflow: .github/workflows/release.yml

services:
  - { name: api,    image: app, imageVar: APP_IMAGE, startOrder: 1 }
  - { name: worker, image: app, imageVar: APP_IMAGE, startOrder: 2 }
  - { name: web,    image: web, imageVar: WEB_IMAGE, startOrder: 3, stopBeforeUpdate: false }

hooks:
  backup:
    type: postgres
    service: db
  migrationProbe:
    type: postgres
    service: db
    preset: node-pg-migrate
  health:
    type: http
    http:
      url: http://api:3000/healthz
      versionJsonPath: $.version
  smoke:
    checks:
      - { type: http, url: http://web:8080/, expectStatus: [200] }

rollback:
  policy: probe
```

### 4.3 Reference

Types: `str`, `int`, `bool`, `path` (absolute POSIX path without `..`, NUL, newline, `:` or
`,`), `relpath` (relative path inside the project directory, no `..` segment, no leading
`/`), `url` (absolute URL without credentials and fragment), `list<T>`, `map<K,V>`.
"req" = required.

#### `version`, `server`, `auth`, `state`, `self`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `version` | int | req | MUST be `1` |
| `server.listen` | str | `0.0.0.0:8090` | `host:port`, host an IP literal, port 1–65535; inside the container |
| `server.allowPublishedPort` | bool | `false` | `false`: a published host port on the sidecar container is blocker `api_exposed` |
| `auth.tokenFile` | path \| null | `null` | operator-provided token file (e.g. a Compose secret); read-only; content trimmed MUST match `^[A-Za-z0-9._~+/=-]{32,512}$`; when `null` the sidecar generates one |
| `auth.sharedDir` | path | `/shared` | generated token is written to `<sharedDir>/token` (64 hex chars, newline) |
| `auth.tokenGroupId` | int | `0` | 0–2147483647; group of the generated token file; mode `0640`, owner `root`. Set it to the app's gid when the app runs as non-root |
| `state.dir` | path | `/state` | holds `status.json`, `backups/`, `releases/`, `src/`; MUST be a volume; created `0700` |
| `state.historyLimit` | int | `20` | 1–100 finished runs kept in `history` |
| `state.eventLimit` | int | `500` | 50–5000 journal events kept |
| `self.service` | str \| null | `null` | the sidecar's own Compose service; `null` = its container label `com.docker.compose.service` |

#### `compose`, `docker`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `compose.projectDir` | path | req | host path of the Compose project, mounted at the same path; MUST equal the label `com.docker.compose.project.working_dir` of the sidecar's own container (blocker `project_mismatch`) |
| `compose.projectName` | str \| null | `null` | `^[a-z0-9][a-z0-9_-]{0,62}$`; `null` = own label `com.docker.compose.project` |
| `compose.files` | list<relpath> | `[]` | 0–10 files passed as `-f`; empty = Compose's own discovery (incl. override file) |
| `compose.envFile` | relpath | `.env` | the interpolation env file Compose reads; passed as `--env-file` when not `.env` |
| `compose.profiles` | list<str> | `[]` | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$`; profiles passed as `--profile` to every Compose call (list the sidecar's own profile here) |
| `docker.socket` | path | `/var/run/docker.sock` | Docker Engine socket |
| `docker.registryAuthFile` | path \| null | `null` | Docker `config.json` with an `auths` object only (`credsStore`/`credHelpers` are rejected); used for pulls and, per verification, copied for the verifier |
| `docker.minFreeMb` | int | `2048` | 0–100000000; free space required on the state file system *after* the estimated backup |

#### `release`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `release.feed.type` | enum | req | `github` \| `gitea` \| `gitlab` \| `static` \| `file` |
| `release.feed.url` | url | req (not for `file`) | https only. `github`: `https://github.com/<owner>/<repo>`; `gitea`: `https://<host>[/<prefix>]/<owner>/<repo>`; `gitlab`: `https://<host>/<group>[/<subgroup>...]/<project>`; `static`: the index URL; not used with `file` |
| `release.feed.path` | path \| null | `null` | `file` only (then required): directory with `index.json`, the documents and bundles; entries in the index are plain file names |
| `release.feed.tokenFile` | path \| null | `null` | token for a private repository; sent only as `Authorization` header to the feed origin |
| `release.feed.allowPrivateNetwork` | bool | `false` | allow loopback/private addresses for the feed host (an internal Forgejo); otherwise only public addresses are contacted |
| `release.channel` | enum | `stable` | `stable` \| `beta` (beta includes pre-releases) |
| `release.tagPattern` | str | `v{version}` | contains `{version}` exactly once; other characters `[A-Za-z0-9._/-]` |
| `release.cacheSeconds` | int | `300` | 0–86400; how long the release list is reused |
| `release.checkIntervalHours` | int | `0` | 0–168; `0` = the sidecar never reads the feed on its own (only on request) |

#### `trust` (section 8.2 explains the modes)

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `trust.mode` | enum | `keyless` | `keyless` \| `key` \| `none`. There is no automatic fallback between modes |
| `trust.keyless.github.repository` | str | – | `owner/repo`; with `workflow` the shorthand for GitHub Actions |
| `trust.keyless.github.workflow` | relpath | – | `.github/workflows/<file>.yml` or `.yaml` |
| `trust.keyless.gitlab.host` | str | `gitlab.com` | host of the GitLab instance (issuer `https://<host>`) |
| `trust.keyless.gitlab.project` | str | – | `group[/subgroup...]/project` |
| `trust.keyless.gitlab.ciConfigPath` | relpath | `.gitlab-ci.yml` | path of the CI configuration in the project |
| `trust.keyless.issuer` | url | – | generic form: OIDC issuer as written into the certificate |
| `trust.keyless.identityTemplate` | str | – | generic form: exact certificate identity with `{tag}` (required) and optional `{version}`; no regular expressions |
| `trust.keyless.trustedRootFile` | path \| null | `null` | Sigstore trusted root JSON for air-gapped hosts; `null` = fetched/cached via TUF |
| `trust.key.publicKeyFiles` | list<path> | – | 1–5 PEM public keys (cosign-supported algorithms); a signature by any of them is accepted (rotation) |
| `trust.key.transparencyLog` | bool | `false` | `true`: signatures MUST also have a transparency log entry |
| `trust.none.acknowledgeUnsigned` | bool | `false` | MUST be `true` when `mode: none`; otherwise config error |
| `trust.verifier.isolate` | bool | `true` | run cosign in an isolated sibling container (2.3) |
| `trust.verifier.workDir` | path | `/verify` | volume shared read-only with the verifier |
| `trust.verifier.timeoutSeconds` | int | `300` | 10–1800 per cosign invocation |

Exactly one of `github`, `gitlab`, or (`issuer` + `identityTemplate`) MUST be set in
`keyless` mode. `key` mode requires `publicKeyFiles`. Settings of the inactive modes are a
config error (so a leftover `none` block cannot mislead a reader).

#### `images`, `services`, `env`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `images.<key>.repository` | str | – | optional mirror for the image `<key>` of `release.json`; signatures must have been copied to the mirror (`cosign copy`) |
| `services` | list | req | 1–32 entries |
| `services[].name` | str | req | Compose service, `^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$`, unique, MUST NOT be the sidecar itself |
| `services[].image` | str | req | key in `release.json` `images`, `^[a-z][a-z0-9-]{0,31}$` |
| `services[].imageVar` | str | req | env key, `^[A-Z][A-Z0-9_]{0,127}$`; several services MAY share one key only if they share `image` |
| `services[].startOrder` | int | `1` | 1–9; groups are started in ascending order, each group health-checked before the next |
| `services[].stopBeforeUpdate` | bool | `true` | stopped in the `stop` step (writers such as workers); `false` keeps serving until recreated (an edge serving the maintenance page) |
| `services[].stopOnAttention` | bool | `true` | stopped when the run ends in `needs_attention` |
| `services[].optional` | bool | `false` | `true`: a release without this image key leaves the service on its current image |
| `services[].health` | object \| null | `null` | an extra per-service check, same shape as a `hooks.smoke.checks[]` entry |
| `env.versionVar` | str \| null | `null` | an env key that receives the plain target version (and is restored on rollback); becomes a writable key |
| `env.redactKeyPattern` | str | `(PASSWORD\|PASSWD\|SECRET\|TOKEN\|KEY\|CREDENTIAL\|PRIVATE\|DSN)` | case-insensitive regex; values of matching env keys are registered for redaction |

**Writable keys** = the distinct `services[].imageVar` values plus `env.versionVar`. The
sidecar MUST refuse (in code, not only by configuration) to write any other key.

#### `hooks.backup`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `type` | enum | `none` | `none` \| `postgres` \| `mysql` \| `volume` \| `command` |
| `service` | str | – | database service (`postgres`, `mysql`) |
| `user` | str \| null | `null` | `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$`; `null` = the container's own env (`POSTGRES_USER`; MySQL: `root` with `MYSQL_ROOT_PASSWORD`/`MARIADB_ROOT_PASSWORD`) |
| `database` | str \| null | `null` | same pattern; `null` = `POSTGRES_DB` (fallback user name) / `MYSQL_DATABASE` / `MARIADB_DATABASE` |
| `flavor` | enum | `auto` | MySQL family: `auto` \| `mysql` \| `mariadb` (`auto`: `mariadb-dump` if present, else `mysqldump`) |
| `volumes` | list<str> | `[]` | `volume`: 1–16 Compose volume names (project prefix resolved) |
| `quiesce` | bool | `false` | `true`: the `stop` step runs before the backup (consistent file-level copies). Forced `true` for `volume` |
| `command.image` | str | – | `command`: image pinned by digest (`name[:tag]@sha256:...`) |
| `command.argv` | list<str> | – | 1–64 arguments, no shell |
| `command.envKeys` | list<str> | `[]` | env keys whose values from the env file are passed to the backup container (and registered for redaction) |
| `command.network` | enum | `project` | `project` (the project's default network) \| `none` |
| `command.outputFile` | str | `backup.out` | file name the container writes into `/backup` |
| `lockWaitSeconds` | int | `120` | 1–3600; PostgreSQL `--lock-wait-timeout` (MySQL dumps use `--single-transaction` and take no table locks on InnoDB; no equivalent option) |
| `encryption.ageRecipients` | list<str> | `[]` | `age1...` public keys; when set, the verified backup is encrypted with `age` and the plaintext removed |
| `retention.keep` | int | `3` | 1–50 newest backups kept |
| `retention.maxAgeDays` | int | `14` | 0–3650; older backups are deleted (0 = no age limit). A backup referenced by the newest `needs_attention` run is never deleted |
| `timeoutSeconds` | int | `7200` | 60–86400 for creating the backup |
| `verifyTimeoutSeconds` | int | `1800` | 60–86400 for verifying it |

#### `hooks.migrationProbe`, `hooks.migrate`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `migrationProbe.type` | enum | `none` | `none` \| `postgres` \| `mysql` \| `command` \| `http` |
| `migrationProbe.service` | str | – | database service (`postgres`, `mysql`) |
| `migrationProbe.user` / `database` | str \| null | `null` | as in `hooks.backup` |
| `migrationProbe.preset` | enum \| null | `null` | `drizzle` \| `prisma` \| `knex` \| `alembic` \| `django` \| `flyway` \| `rails` \| `golang-migrate` \| `node-pg-migrate` \| `typeorm` \| `sequelize` (queries in appendix C) |
| `migrationProbe.query` | str \| null | `null` | one `SELECT` returning one value; exclusive with `preset` |
| `migrationProbe.fingerprint` | bool | `true` | append a hash of the schema catalog (columns) to the value; catches DDL a failed, non-transactional migration left behind |
| `migrationProbe.command.service` / `argv` | str / list | – | `command`: run with `docker compose exec -T`; stdout is the value |
| `migrationProbe.http.url` / `jsonPath` | url / str | – | `http`: GET with the token; the JSON value at `jsonPath` is the value |
| `migrationProbe.timeoutSeconds` | int | `60` | 1–600 |
| `migrate` | object \| null | `null` | optional separate migration run before the services start |
| `migrate.service` | str | – | a managed service whose new image runs the command |
| `migrate.argv` | list<str> | – | 1–64 arguments |
| `migrate.timeoutSeconds` | int | `1800` | 10–86400 |

Probe value: exit code 0 and stdout (or the JSON value) converted to a string, trimmed,
whitespace runs collapsed to one space, at most 1024 printable ASCII characters. A non-zero
exit, a timeout, a longer or non-printable value is a **probe failure** (state unknown).
Two values are compared for exact equality.

#### `hooks.health`, `hooks.smoke`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `health.type` | enum | `none` | `none` \| `http` \| `command`; `none` gives warning `health_without_app_check` |
| `health.http.url` | url | – | http(s) on the internal network |
| `health.http.sendToken` | bool | `true` | send `Authorization: Bearer <token>` (lets the app reveal its version only to the sidecar) |
| `health.http.expectStatus` | list<int> | `[200]` | accepted statuses |
| `health.http.versionJsonPath` | str \| null | `null` | path (4.5) of the version in the JSON body; `null` = no version check |
| `health.http.conditions` | list | `[]` | `{ path, equals }` pairs that MUST hold in the body (e.g. a database check while workers are not started yet) |
| `health.http.requestTimeoutSeconds` | int | `5` | 1–60 |
| `health.command.service` / `argv` | str / list | – | `docker compose exec -T`; exit 0 = healthy |
| `health.command.versionFromStdout` | bool | `false` | first line of stdout is the version |
| `health.afterGroup` | int \| null | `null` | `startOrder` group after which the app check runs first; `null` = the lowest group |
| `health.intervalSeconds` | int | `2` | 1–60 between polls |
| `health.timeoutSeconds` | int | `600` | 10–7200 per wait |
| `health.versionMismatchLimit` | int | `3` | 1–20 consecutive healthy answers with another version before `health.version_mismatch` |
| `health.crashLimit` | int | `2` | 1–10 observations of a managed container `restarting`/`exited`/`dead` before `health.crashed` |
| `health.waitForDockerHealth` | enum | `auto` | `auto` (wait for `healthy` where a Docker healthcheck exists) \| `always` (a service without healthcheck fails) \| `never` |
| `health.servicesGraceSeconds` | int | `60` | 5–600 for all managed services to be `running` after the last group |
| `smoke.checks` | list | `[]` | 0–20: `{ type: http, url, expectStatus: [200], bodyContains: null, sendToken: false }` or `{ type: command, service, argv, expectExitCode: 0 }` |
| `smoke.retries` | int | `5` | 1–20 attempts per check |
| `smoke.intervalSeconds` | int | `3` | 1–60 |
| `smoke.timeoutSeconds` | int | `300` | 10–1800 for all checks |

#### `rollback`, `source`, `cleanup`, `schedule`, `timeouts`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `rollback.policy` | enum | `probe` if a probe is configured, else `never` | `probe` \| `always` \| `never` (5.6); `probe` requires `migrationProbe.type != none` |
| `source.allowlist` | list<str> | `[]` | `host` or `host/owner/repo` (GitLab: `host/group/.../project`), lowercase, GitHub as `github.com/...`; empty = source mode off |
| `source.tokenFile` | path \| null | `null` | token for the archive download; `null` = `release.feed.tokenFile` |
| `source.maxArchiveMb` | int | `200` | 1–2048 |
| `source.build.<imageKey>.context` | relpath | `.` | build context inside the archive |
| `source.build.<imageKey>.dockerfile` | relpath | `Dockerfile` | |
| `source.build.<imageKey>.target` | str \| null | `null` | Dockerfile target |
| `source.build.<imageKey>.buildArgs` | map<str,str> | `{}` | names `^[A-Z][A-Z0-9_]{0,63}$`, values `^[0-9A-Za-z._{}-]{0,128}$`; `{version}` is replaced |
| `cleanup.keepPreviousImages` | int | `1` | 0–10 older images per managed repository kept besides the current one (the rollback image is always kept) |
| `schedule.maxLeadSeconds` | int | `1209600` | 0–2592000; latest start a request may ask for |
| `schedule.lateStartToleranceSeconds` | int | `600` | 0–86400; a run found later than this after `startsAt` is not started (5.8) |
| `timeouts.pullSeconds` | int | `1800` | 60–14400 per image pull |
| `timeouts.stopSeconds` | int | `60` | 1–600 (`compose stop -t`) |
| `timeouts.upSeconds` | int | `900` | 30–3600 per `compose up` |
| `timeouts.composeSeconds` | int | `120` | 10–600 for `config`, `ps`, `logs`, inspect calls |

#### `publicStatus`, `maintenancePage`, `logging`, `selfCheck`

| Key | Type | Default | Validation / meaning |
| --- | --- | --- | --- |
| `publicStatus.enabled` | bool | `true` | serve `GET /public/v1/status` |
| `publicStatus.showVersions` | bool | `false` | include versions in the public status (off: which release runs is for signed-in users) |
| `maintenancePage.enabled` | bool | `false` | serve the page under `/public/v1/maintenance/` |
| `maintenancePage.brandingFile` | path \| null | `null` | JSON `{ productName, logoFile, accentColor, supportUrl }` (logo: PNG/SVG ≤ 256 KiB next to it) |
| `maintenancePage.templateDir` | path \| null | `null` | replaces the built-in `index.html`, `maintenance.css` (the script stays built-in) |
| `maintenancePage.languages` | list<str> | `["en","de"]` | built-in: `en`, `de`; others need `templateDir` catalogs |
| `logging.level` | enum | `info` | `debug` \| `info` \| `warn` \| `error` |
| `logging.format` | enum | `text` | `text` \| `json` (one object per line) |
| `logging.redactPatterns` | list<str> | `[]` | up to 32 extra regexes whose matches are replaced by `[redacted]` |
| `selfCheck.enabled` | bool | `false` | read the cicd-updater release feed daily and report a newer sidecar in `GET /v1/state` (never installs it) |

### 4.4 Environment overrides

Every scalar key and every list of strings outside `services`, `images`, `hooks.*.command`,
`hooks.*.argv`, `hooks.smoke.checks`, `hooks.health.http.conditions` and `source.build`
can be overridden by an environment variable:

- name: `CICD_UPDATER_` + the key path, each segment converted from camelCase to
  UPPER_SNAKE_CASE, segments joined by `__`.
  `compose.projectDir` → `CICD_UPDATER_COMPOSE__PROJECT_DIR`;
  `release.feed.url` → `CICD_UPDATER_RELEASE__FEED__URL`;
  `trust.key.transparencyLog` → `CICD_UPDATER_TRUST__KEY__TRANSPARENCY_LOG`.
- values: `true`/`false`; decimal integers; lists comma-separated (items trimmed); an empty
  value means `null` for nullable keys, `[]` for lists and an error for required keys.
- an override for an unknown key is an error (exit 64).
- `CICD_UPDATER_CONFIG` itself names the file.

### 4.5 Value path syntax (`versionJsonPath`, `conditions[].path`, `http.jsonPath`)

A restricted JSONPath: `$` followed by one or more `.name` (name `^[A-Za-z_][A-Za-z0-9_-]*$`)
or `[index]` (non-negative integer) segments, at most 10 segments. No wildcards, filters or
recursion. A missing path is "no value".

### 4.6 Keyless identity construction

| Form | Issuer | Certificate identity (exact) | Additional checks |
| --- | --- | --- | --- |
| `github` | `https://token.actions.githubusercontent.com` | `https://github.com/<repository>/<workflow>@refs/tags/<tag>` | GitHub workflow repository = `<repository>`, workflow ref = `refs/tags/<tag>`, trigger = `push` |
| `gitlab` | `https://<host>` | `https://<host>/<project>//<ciConfigPath>@refs/tags/<tag>` | – |
| generic | `issuer` | `identityTemplate` with `{tag}`/`{version}` replaced | – |

`<tag>` is the release tag rendered from `release.tagPattern`; it MUST equal
`release.json.tag`. The identity is computed per release and passed to cosign as an exact
identity (never as a regular expression). The cosign flags implementing the GitHub-specific
checks are fixed in code against the bundled cosign version and covered by the e2e.

---

## 5. The update state machine

The engine is driven only through interfaces (`DockerOps`, `CommandRunner`, `ReleaseSource`,
`Verifier`, `Hooks`, `Clock`, `StatusStore`, `EnvFile`, `BackupStore`, `Preflight`), so every
scenario is scriptable with fakes (as in Restow's `engine*.test.ts`).

Rules kept everywhere:

- The state is written to `status.json` before the side effect that follows it.
- A failure is never guessed: the previous version is started again only when it is certain
  that the data was not changed by the new version (5.6).
- After a restart the sidecar never starts or stops application services on its own (5.8).
- Housekeeping (pruning, cleanup) never turns a successful update into a failed one.

### 5.1 Phases

```
            schedule                 startsAt reached                 end of run
   idle ───────────────▶ scheduled ───────────────────▶ running ────────────────────▶ succeeded
    ▲                       │  ▲                          │                           failed
    │        cancel         │  │ reschedule               │ abort (before PONR)           │
    └───────────────────────┘  └─┘                        └──────▶ failed (unchanged)     │
    ▲                                                                                     │
    └───────────────────────────── acknowledge ───────────────────────────────────────────┘
```

| Phase | Meaning |
| --- | --- |
| `idle` | nothing announced; the last runs are in `history` |
| `scheduled` | announced, counting down to `startsAt`; can be rescheduled or cancelled |
| `running` | steps are executing; abort possible only before the point of no return |
| `succeeded` | finished; the new version answers |
| `failed` | finished without success; `run.outcome` says in which state the installation is |

A finished run stays the current run (`succeeded`/`failed`) until it is acknowledged, so
every admin sees the result; scheduling a new run while the phase is `succeeded` or
`failed` acknowledges the old one implicitly.

### 5.2 Steps and their order

| Step | Weight | Default order | With `backup.quiesce: true` | Skipped when |
| --- | --- | --- | --- | --- |
| `prepare` | 5 | 1 | 1 | never |
| `fetch` | 30 | 2 | 2 | never |
| `backup` | 15 | 3 | 4 | `hooks.backup.type: none` |
| `stop` | 5 | 4 | 3 | no service has `stopBeforeUpdate: true` |
| `migrate` | 10 | 5 | 5 | no `hooks.migrate` |
| `start` | 10 | 6 | 6 | never |
| `health` | 15 | 7 | 7 | never (without app check it still waits for the containers) |
| `smoke` | 5 | 8 | 8 | no `hooks.smoke.checks` |
| `finish` | 5 | 9 | 9 | never |

`run.steps` lists the steps in execution order; skipped steps have status `skipped` from the
start. Progress = sum of the weights of `done`/`skipped` steps plus half the weight of the
`running` step, rounded, never decreasing. **The point of no return is the beginning of
the `stop` step** (in quiesce order this precedes the backup).

`applyAttempted` is set and persisted immediately before the first command that could
start a new image (the `migrate` run or the first `compose up`); it decides 5.6.

### 5.3 What each step does

**prepare**
1. Deep preflight (5.11). The first blocker fails the step with `prepare.<blocker>`.
2. Read the env file; register values of keys matching `env.redactKeyPattern` with the
   redactor.
3. Load the stored, verified `release.json` of the run; in `keyless`/`key` mode verify the
   stored bundle again; its SHA-256 MUST equal `run.release.sha256`. (Source mode: if the
   release has no `release.json`, the checks of item 4 that need it are skipped and the
   image plan of item 5 uses the image keys of `source.build`.)
4. Determine the running version (5.12). Refuse when unknown (`prepare.running_version_unknown`),
   not strictly older than the target (`prepare.not_newer`), below
   `upgrade.minimumFromVersion` (`prepare.below_minimum_version`), when
   `upgrade.manualSteps.required` (`prepare.manual_steps_required`), when the sidecar's own
   version does not satisfy `requires.updater` (`prepare.updater_too_old`), or when a key of
   `requires.env` is missing or empty in the env file (`prepare.env_missing`, detail: the
   key names only).
5. Build the image plan: for each managed service the release image of `services[].image`
   (mirror override applied); a missing key fails with `prepare.image_missing` unless the
   service is `optional` (then it keeps its current image and its key is not written).
   The host platform (`docker info` architecture mapped to `linux/amd64`/`linux/arm64`)
   MUST be in `platforms` (`prepare.platform_unsupported`).
6. Compose probe: run `docker compose config --format json` with every writable key set in
   the process environment to `cicd-updater-probe.invalid/<key in lowercase>:probe`. Every
   managed service MUST resolve to the probe value of its `imageVar`
   (`prepare.compose_unsupported`, detail: the services that do not), and the sidecar's own
   service MUST NOT resolve to any probe value (`prepare.updater_image_unpinned`).
7. Capture the previous state and persist it: the resolved image reference of every
   managed service (`previousImages`) and, byte-exact, the last assignment line of every
   writable key including "absent" (`previousEnv`).

**fetch** (image mode)
1. For each distinct image key of the plan, `ref = <repository>@<digest>`.
2. `keyless`/`key`: verify the signature of `ref` (4.6, 8.2). Failure codes:
   `fetch.signature_missing`, `fetch.signature_invalid`, `fetch.registry_unauthorized`,
   `fetch.registry_unreachable`, `fetch.image_not_found`, `fetch.verifier_failed`. `none`:
   record `signature: "not_checked"` and log it.
3. `docker pull <ref>` (by digest, with `docker.registryAuthFile`). Errors are classified,
   never conflated: an access problem (`denied`, `unauthorized`, `forbidden`) is
   `fetch.registry_unauthorized` even when the registry words it as "not found" for private
   repositories it hides; a definite unknown manifest is `fetch.image_not_found`; rate
   limits `fetch.registry_rate_limited`; network/DNS/TLS `fetch.registry_unreachable`; other
   `fetch.pull_failed`.
4. The local image MUST be known by that digest (classic image store: `RepoDigests`
   contains `ref`; containerd image store: inspecting `ref` succeeds and its ID or index
   digest equals the digest) → else `fetch.digest_mismatch`.
5. If the image config carries `org.opencontainers.image.version`, it MUST equal the target
   version (`fetch.version_label_mismatch`).
6. The reference written later is `<repository>:<tag>@<digest>` (to be verified in the e2e
   on both image stores that `compose up --pull never` resolves it to the pulled image; if
   not, the implementation writes `<repository>@<digest>`; the choice is recorded in
   `docs/compatibility.md`).

**fetch** (source mode, section 8.4)
1. The feed repository MUST match `source.allowlist` (`fetch.source_not_allowed`).
2. Download the tag's archive (rules in 8.4) into `<stateDir>/src/<runId>/`
   (`fetch.download_failed`, `fetch.token_unavailable`).
3. Extract safely; build each image key with `docker build` (Buildx), tag
   `cicd-updater.local/<project>/<imageKey>:<version>`, build args with `{version}`
   (`fetch.build_failed`). The references written are those local tags.
4. The source tree is always removed afterwards (success or failure).

**backup**
1. If `rollback.policy` is `probe`: read the probe value (the **baseline**) and persist it
   (`backup.baseline_unavailable` when it fails). The baseline is read immediately before
   the backup is created, in both orders.
2. Estimate the size (PostgreSQL `pg_database_size`, MySQL sum of `data_length` and
   `index_length`, volumes from `docker system df -v`); estimate × 1.25 +
   `docker.minFreeMb` MUST fit into the free space of the state file system
   (`backup.insufficient_space`). An estimate that cannot be made is logged and only the
   minimum free space is checked.
3. Create the backup as `<name>.partial`, hashing (SHA-256) and counting bytes while
   writing; rename when complete (`backup.failed`, `backup.timeout`).
4. Verify it (`backup.verify_failed`):
   - PostgreSQL: custom format (`pg_dump -Fc`); header `PGDMP`; `pg_restore --list` (stdin
     streamed into the database container) lists at least one entry.
   - MySQL/MariaDB: `--single-transaction --routines --triggers --events`, stored gzip
     compressed; non-empty, decompresses completely, last non-empty line starts with
     `-- Dump completed`.
   - volume: `tar.gz` of the listed volumes, made by a one-off container of the sidecar
     image with the volumes mounted read-only; `tar -tzf` lists entries of every volume.
   - command: the output file exists and is non-empty.
5. Optionally encrypt with `age` (`backup.encryption.ageRecipients`), then remove the
   plaintext.
6. Write the metadata file, persist the backup name in the run context, prune (5.14).

A failed or aborted backup is deleted including `.partial` files: an unverified file must
never look like a backup. PostgreSQL dumps run with `PGAPPNAME=cicd-updater-backup-<runId>`
and `--lock-wait-timeout`; on timeout or abort the sidecar terminates exactly the backends
with that application name, so no orphaned dump holds locks that the migration would wait
behind. Commands run inside other containers are wrapped as
`sh -c 't="$1"; shift; exec timeout -s TERM "$t" "$@"' sh <seconds> <argv...>` (a constant
script, data only as positional parameters) when the container has `timeout`; killing the
client alone does not stop a process inside a container.

**stop**: `docker compose stop -t <timeouts.stopSeconds>` for services with
`stopBeforeUpdate: true`, in descending `startOrder` (`stop.failed`).

**migrate** (optional): persist `applyAttempted`, then
`docker compose run --rm --no-deps -T --name cicd-updater-migrate-<runId> <service> <argv>`
with the writable keys set to the new references **in the process environment only** (the
env file is not written yet). Non-zero exit: `migrate.failed` (detail: redacted output
tail); timeout: the container is removed, `migrate.timeout`.

**start**
1. The current lines of the writable keys MUST still equal `previousEnv`
   (`start.env_changed`: someone edited the file during the run).
2. Write the new references (and `env.versionVar`) into the env file: only these lines
   change; comments, order, quoting, line endings, `export` prefixes, a missing final
   newline and duplicate earlier assignments stay as they were; an absent key is appended.
   Atomic replace (temporary file in the same directory, fsync, rename, directory fsync)
   keeping mode and owner; when the env file is a single-file bind mount (`EBUSY`/`EXDEV`),
   rewrite in place. Values MUST match the image reference grammar (no quotes, no `$`, no
   whitespace) (`start.env_write_failed`).
3. Persist `applyAttempted` (if not yet set), then
   `docker compose up -d --no-deps --no-build --pull never <services of the lowest group>`
   (`start.failed`).

**health**
1. For the current group: every service `running` within `health.timeoutSeconds`; with
   `waitForDockerHealth` the Docker health status `healthy`; a container observed
   `restarting`/`exited`/`dead` `health.crashLimit` times fails fast (`health.crashed`,
   detail: exit code and the redacted log tail).
2. If the group is `health.afterGroup`: poll the app check every `intervalSeconds` until it
   is healthy and reports the target version (`health.timeout`; `health.version_mismatch`
   after `versionMismatchLimit` consecutive healthy answers with another version).
3. Next group: `compose up` (failure: `start.failed` in step `health`), repeat 1–2.
4. After the last group: the app check once more, every managed service `running` within
   `servicesGraceSeconds`, every `services[].health` check passes (`health.unhealthy`).

**smoke**: run every check with its retries; the first check that fails all attempts fails
the step (`smoke.failed`, detail: check index, status/exit code, redacted excerpt).

**finish**: prune backups (5.14) and old images of the managed repositories (keep the
current, the previous one used for rollback and `cleanup.keepPreviousImages` more; only
images no container uses; `docker image rm` without force; never global prunes), remove
release documents older than the last five, remove source trees, then record `succeeded`.
Errors here are logged as warnings only.

### 5.4 Failure codes

`<step>.<reason>`; the UI translates them, the sidecar never sends prose to clients.
"Before PONR" failures end `unchanged`; the others go through 5.6.

| Code | Step | Meaning | Operator remedy (docs/troubleshooting.md) |
| --- | --- | --- | --- |
| `prepare.docker_unreachable` | prepare | socket missing or daemon not answering | mount the socket, check the daemon |
| `prepare.docker_too_old` | prepare | Engine API < 1.43 | upgrade Docker Engine |
| `prepare.compose_missing` | prepare | no Compose file found | check `compose.projectDir`/`files` |
| `prepare.compose_invalid` | prepare | `docker compose config` fails | run it by hand, fix the file |
| `prepare.compose_unsupported` | prepare | a managed service does not take its image from its `imageVar` | use `image: ${VAR}` |
| `prepare.project_mismatch` | prepare | configured project dir/name differs from the container labels | fix `compose.projectDir` |
| `prepare.env_unwritable` | prepare | env file missing or not writable (or its directory) | permissions |
| `prepare.state_unwritable` | prepare | state volume not writable | volume |
| `prepare.disk_space` | prepare | below `docker.minFreeMb` | free space |
| `prepare.updater_image_unpinned` | prepare | the sidecar's image follows a writable key | pin the sidecar image |
| `prepare.multiple_updaters` | prepare | another sidecar runs for this project | remove one |
| `prepare.api_exposed` | prepare | the sidecar has a published port | remove `ports:` |
| `prepare.verifier_unavailable` | prepare | isolated verifier cannot start (own image or `/verify` volume not found) | mount `/verify` or set `isolate: false` |
| `prepare.release_signature_invalid` | prepare | stored `release.json` no longer verifies | report; re-schedule |
| `prepare.release_mismatch` | prepare | stored document differs from the scheduled one, or `project`/`tag` mismatch | report |
| `prepare.running_version_unknown` | prepare | running version cannot be determined | add version to health or OCI label |
| `prepare.not_newer` | prepare | target not newer than running | none |
| `prepare.below_minimum_version` | prepare | running < `minimumFromVersion` | install the intermediate release first |
| `prepare.manual_steps_required` | prepare | release requires manual steps | follow `manualSteps.url` |
| `prepare.updater_too_old` | prepare | sidecar does not satisfy `requires.updater` | update the sidecar image by hand |
| `prepare.env_missing` | prepare | `requires.env` keys missing/empty | add them to the env file |
| `prepare.image_missing` | prepare | release lacks an image a non-optional service needs | release defect |
| `prepare.platform_unsupported` | prepare | host platform not in the release | build for it |
| `fetch.signature_missing` | fetch | no signature found for the digest | check signing in CI; mirrors need `cosign copy` |
| `fetch.signature_invalid` | fetch | signature by another identity/key or broken | do not install; investigate |
| `fetch.verifier_failed` | fetch | cosign could not run or reach Sigstore/registry | network, `trustedRootFile` |
| `fetch.registry_unauthorized` | fetch | registry refused access | credentials and their package scopes |
| `fetch.registry_unreachable` | fetch | network, DNS, TLS | network |
| `fetch.registry_rate_limited` | fetch | registry rate limit | wait or authenticate |
| `fetch.image_not_found` | fetch | manifest for the digest does not exist (access confirmed) | release defect |
| `fetch.pull_failed` | fetch | other pull error | log tail |
| `fetch.digest_mismatch` | fetch | local image does not carry the verified digest | investigate |
| `fetch.version_label_mismatch` | fetch | OCI version label differs from the target | release defect |
| `fetch.source_not_allowed` | fetch | source mode not allowed for this repository | `source.allowlist` |
| `fetch.token_unavailable` | fetch | token file missing/unreadable | `source.tokenFile` |
| `fetch.download_failed` | fetch | archive download/extraction failed | log tail |
| `fetch.build_failed` | fetch | `docker build` failed | log tail |
| `backup.baseline_unavailable` | backup | migration probe failed before the update | fix the probe |
| `backup.insufficient_space` | backup | estimated backup does not fit | free space |
| `backup.failed` | backup | backup command failed | log tail |
| `backup.timeout` | backup | backup exceeded `timeoutSeconds` | raise the limit |
| `backup.verify_failed` | backup | backup did not verify | log tail |
| `stop.failed` | stop | `compose stop` failed | log tail |
| `migrate.failed` | migrate | migration command exited non-zero | log tail |
| `migrate.timeout` | migrate | migration exceeded its limit | raise the limit |
| `start.env_changed` | start | env file lines changed during the run | do not edit during updates |
| `start.env_write_failed` | start | env file could not be written | permissions |
| `start.failed` | start/health | `compose up` failed | log tail |
| `health.timeout` | health | app not healthy in time | app log tail in detail |
| `health.crashed` | health | a managed container keeps exiting | app log tail in detail |
| `health.version_mismatch` | health | app healthy but reports another version | image/version wiring |
| `health.unhealthy` | health | Docker health `unhealthy` or a per-service check failed | log tail |
| `smoke.failed` | smoke | a smoke check failed | detail |
| `aborted` | prepare/fetch/backup | operator aborted before PONR | none |
| `interrupted` | any | the sidecar restarted during the run | see outcome |
| `missed_start` | – | the sidecar was down past `startsAt` + tolerance | schedule again |

Adding a code is a minor change; clients MUST render unknown codes generically.

### 5.5 End states

| Outcome | Meaning | Services afterwards | Env file |
| --- | --- | --- | --- |
| `succeeded` | the new version runs and passed health (and smoke) | new images | new references |
| `unchanged` | failed or aborted before the point of no return | never stopped | untouched |
| `rolled_back` | failed after the PONR; it is certain the data was not changed by the new version; the previous images run again and passed the previous version's health check | previous images | restored byte for byte |
| `needs_attention` | failed after the PONR and a rollback was not certain to be safe (or the rollback itself failed, or the sidecar was interrupted after the PONR) | services with `stopOnAttention` stopped; the edge keeps serving the maintenance page | as the failure left it (recorded in `recovery`) |

`interrupted` is a failure code, not an outcome: an interrupted run ends `unchanged`
(PONR not reached), `succeeded` (interrupted during `finish`) or `needs_attention`.

### 5.6 The rollback rule (exact)

On a failure in step S:

```
if S is before the PONR (prepare, fetch, backup in default order):
    discard partial artefacts → outcome unchanged
elif not applyAttempted:                       # stop, or quiesced backup, failed; nothing new ran
    rollback()                                 # env not yet written; restart previous services
elif rollback.policy == "never":
    attention(schemaChanged = null)
elif rollback.policy == "always":              # app declares it has no persistent schema
    rollback()
else:  # "probe"
    freeze: docker compose stop -t <stopSeconds> every managed service running a new image
    if freeze failed:                          # a new container may still be migrating
        attention(schemaChanged = null)
    after = probe()
    if baseline unknown or probe failed:       attention(schemaChanged = null)
    elif after == baseline:                    rollback()
    else:                                      attention(schemaChanged = true)

rollback():
    restore previousEnv (byte-exact; absent keys removed again)
    docker compose up -d --no-deps --no-build --pull never <managed services, ascending groups>
    wait for the previous version: health check with expected version = run.fromVersion
    success → outcome rolled_back
    failure → attention(schemaChanged = <as known>), detail keeps both reasons (≤ 950 chars each)

attention(schemaChanged):
    docker compose stop every managed service with stopOnAttention
    record recovery {backup, fromVersion, previousImages, previousEnv, commands}
    outcome needs_attention, failure.schemaChanged = schemaChanged
```

Why "freeze, then probe": a new container that is still running could apply a migration
between the probe and the decision; only a stopped new version makes "unchanged" a fact.
A rollback never starts old code on a schema the new version changed.

### 5.7 Cancel, abort, reschedule, acknowledge

| Request | Phase / step | Effect | Error |
| --- | --- | --- | --- |
| cancel | `scheduled` | run goes to history with `cancelled: true`; phase `idle` | – |
| cancel | `running`, before PONR | `abortRequestedAt` persisted; the engine stops at the next check point (before each step, between images, every 2 s while waiting, PostgreSQL backup terminated); outcome `unchanged`, code `aborted` | – (202) |
| cancel | `running`, at/after PONR | refused | 409 `point_of_no_return` |
| reschedule | `scheduled` | new `startsAt` (validated as on scheduling), timer re-armed | 409 `not_scheduled` otherwise |
| acknowledge | `succeeded`/`failed` | phase `idle`, run stays in history | 409 `not_finished` while scheduled/running |

MySQL, volume and command backups cannot be interrupted safely mid-way; an abort during
them takes effect when the backup step ends (documented).

### 5.8 Restart and resume

Before the HTTP server accepts requests:

1. Take the state lock (5.10), load `status.json`. An unreadable or schema-invalid file is
   moved aside (`status.json.corrupt-<epoch ms>`, the newest five kept) and the sidecar
   continues `idle` without history; the running installation is not affected.
2. Remove leftovers: `*.partial` backups, verifier and helper containers carrying the
   label `io.github.restow-backup.cicd-updater.managed=true`, a leftover
   `cicd-updater-migrate-*` container, `/verify` contents, `src/`.
3. Then by phase:

| Phase found | Condition | Action |
| --- | --- | --- |
| `scheduled` | now < `startsAt` | re-arm the timer |
| `scheduled` | `startsAt` ≤ now ≤ `startsAt` + `lateStartToleranceSeconds` | start now |
| `scheduled` | later | fail with `missed_start`, outcome `unchanged` |
| `running` | PONR not reached | fail with `interrupted`, outcome `unchanged` |
| `running` | current step `finish` | outcome `succeeded` (health and smoke had passed); journal notes it |
| `running` | PONR reached otherwise | fail with `interrupted`, outcome `needs_attention`, recovery with the backup if it was verified |
| `succeeded`/`failed`/`idle` | – | nothing |

On SIGTERM/SIGINT the sidecar stops timers, refuses to begin further steps (a step that is
waiting stops at its next check), flushes the store and exits within 8 seconds; the run is
resolved by the table above at the next start. The Compose service SHOULD set
`stop_grace_period: 30s`.

### 5.9 `status.json`

Location `<stateDir>/status.json`, mode `0600`, written atomically after every change; the
JSON Schema is generated from `packages/protocol` (`schemas/status.schema.json`).

```ts
interface StatusFile {
  schemaVersion: 1;
  instanceId: string;                 // random UUID created on first start, kept
  phase: "idle" | "scheduled" | "running" | "succeeded" | "failed";
  run: Run | null;                    // the current run (phase != idle)
  runContext: RunContext | null;      // bookkeeping for rollback and resume, never sent to clients
  history: RunSummary[];              // newest first, ≤ state.historyLimit (Run without log)
  events: JournalEvent[];             // oldest first, ≤ state.eventLimit
  eventCounter: number;
}

interface Run {
  id: string;                         // "r-<epoch ms>-<4 hex>"
  mode: "image" | "source";
  fromVersion: string | null;
  targetVersion: string;
  targetTag: string;
  notesUrl: string | null;
  release: {
    sha256: string;                   // of the stored release.json bytes
    channel: "stable" | "beta";
    document: "verified" | "not_checked";       // release.json signature
  };
  trustMode: "keyless" | "key" | "none";
  verification: {
    signatures: "verified" | "failed" | "not_checked" | "not_applicable" | null; // not_applicable = source mode
    digests: "verified" | "failed" | "not_applicable" | null;
  };
  requestedBy: { id: string | null; label: string; via: "api" | "cli" };
  scheduledAt: string; startsAt: string; leadSeconds: number | null;
  startedAt: string | null; finishedAt: string | null;
  cancelled: boolean; cancelledAt: string | null; abortRequestedAt: string | null;
  outcome: "succeeded" | "unchanged" | "rolled_back" | "needs_attention" | null;
  step: StepId | null;
  steps: { id: StepId; status: "pending" | "running" | "done" | "failed" | "skipped";
           startedAt: string | null; finishedAt: string | null;
           detail: Record<string, string | number | boolean | null> }[];
  progress: number;                   // 0..100
  message: { code: string; params: Record<string, string | number> } | null;
  failure: { code: string; step: StepId | null; detail: string;  // redacted, ≤ 2000 chars
             schemaChanged: boolean | null } | null;
  recovery: Recovery | null;
  images: Record<string /* service */, string /* reference written */>;
  configHash: string;
  log: string[];                      // ≤ 200 redacted lines "<ISO time> <text>", ≤ 400 chars each
}

interface RunContext {
  previousEnv: Record<string, { present: boolean; line: string | null; value: string | null }> | null;
  previousImages: Record<string, string | null> | null;
  baseline: string | null;            // migration probe value before the update
  applyAttempted: boolean;
  backupFile: string | null;          // set once created and verified
  plan: Record<string, { imageKey: string; ref: string; optionalKept: boolean }> | null;
}

interface Recovery {
  backup: { file: string; bytes: number; sha256: string; type: string; encrypted: boolean } | null;
  fromVersion: string | null;
  previousImages: Record<string, string | null>;
  previousEnv: Record<string, { present: boolean; line: string | null }>;
  commands: string[];                 // rendered restore commands (5.14), for display
}
```

`status.json` is internal: its schema version is migrated forward automatically on start
(older schema versions are read and rewritten); a newer schema version than the sidecar
knows is moved aside like a corrupt file. Clients never read the file, only the API views.

### 5.10 Concurrency and locks

- **In process:** one engine; scheduling performs every check that awaits I/O first, then
  re-checks the phase and changes it without an intervening `await`, so two requests
  cannot both pass.
- **State directory:** `<stateDir>/.lock` created with `O_EXCL`, containing
  `{ instanceId, pid, hostname, heartbeatAt }`, heartbeat every 15 s. A lock of another
  instance with a heartbeat younger than 60 s makes the process exit with code **75**; an
  older one is taken over with a warning.
- **Project:** a running container in the same Compose project (other than itself) with the
  label `io.github.restow-backup.cicd-updater.role=sidecar` is blocker `multiple_updaters`.
  A sidecar without that label on itself gets warning `self_label_missing`.

### 5.11 Preflight: blockers and warnings

`capabilities` is computed on demand, cached for 30 s, recomputed on `refresh`, at
scheduling and (deep, including the Compose probe) at the start of a run.

| Blocker | Check |
| --- | --- |
| `docker_unreachable` | `docker version` answers |
| `docker_too_old` | Engine API ≥ 1.43 |
| `compose_missing` / `compose_invalid` | file present / `config` succeeds |
| `compose_unsupported` | Compose probe (5.3 prepare 6) |
| `project_mismatch` | own container labels vs `compose.projectDir`/`projectName` |
| `env_unwritable` | env file and its directory writable |
| `state_unwritable` | state directory writable |
| `disk_space` | free space ≥ `docker.minFreeMb` |
| `updater_image_unpinned` | Compose probe for the sidecar's own service |
| `multiple_updaters` | label scan (5.10) |
| `api_exposed` | own container has a published port and `allowPublishedPort` is false |
| `verifier_unavailable` | `keyless`/`key` with `verifier.isolate: true`: own image ID and `/verify` volume resolvable |

| Warning | Meaning |
| --- | --- |
| `trust_mode_none` | signatures are not checked |
| `updater_image_not_digest_pinned` | the sidecar's own image reference has no digest |
| `self_label_missing` | multiple-sidecar detection impossible |
| `health_without_app_check` | `hooks.health.type: none` |
| `backup_none_with_probe` | a migration probe is configured but no backup |
| `source_mode_enabled` | source mode allowlist is non-empty |

### 5.12 Running version

In this order, the first that yields a valid version wins; `GET /v1/state` reports it as
`running: { version, source }`:

1. `health` – the app check reports a version (`versionJsonPath` / `versionFromStdout`);
2. `label` – `org.opencontainers.image.version` of the image of the running container of
   the first managed service in the lowest group;
3. `state` – the last succeeded run's target, if the running containers still use the
   images that run installed;
4. `env` – the value of `env.versionVar` (lowest trust: an env value can outlive a failed
   update; reported so the UI can say so).

### 5.13 Messages and journal

`run.message` is `{ code, params }`; params are versions, failure codes and counts only
(image names, file names and paths appear only in `run.log` and run fields). The public
status removes the `version` param unless `publicStatus.showVersions`. Message codes
(1.0): `run.scheduled {version, startsAt}`, `run.rescheduled {version, startsAt}`,
`run.starting {version}`, `run.succeeded {version}`, `run.unchanged {code}`,
`run.rolled_back {code}`, `run.needs_attention {code}`, `run.interrupted`,
`run.aborting`, `step.prepare.checking`, `step.prepare.verifying_compose`,
`step.fetch.verifying_signature {index, total}`, `step.fetch.signature_not_checked`,
`step.fetch.pulling {index, total}`, `step.fetch.verifying_digests`,
`step.fetch.downloading {version}`, `step.fetch.building {index, total}`,
`step.backup.baseline`, `step.backup.creating`, `step.backup.verifying`,
`step.backup.encrypting`, `step.stop.stopping`, `step.migrate.running`,
`step.start.writing_env`, `step.start.starting {group}`, `step.health.waiting {group}`,
`step.health.checking_app {version}`, `step.health.verifying_services`,
`step.smoke.checking {index, total}`, `step.finish.cleaning`, `rollback.freezing`,
`rollback.probing`, `rollback.restoring_env`, `rollback.restarting`,
`rollback.waiting`, `rollback.done`, `rollback.failed`, `attention.stopping`,
`attention.backup_kept`. A code not in the list never reaches a client.

Journal events (for the app's audit log, read with a cursor, 6.4):

```ts
interface JournalEvent {
  id: string;            // "<epoch ms, 15 digits>-<counter, 6 digits>", sortable, unique across restarts
  at: string;
  action: "update.scheduled" | "update.rescheduled" | "update.cancelled" | "update.abort_requested"
        | "update.started" | "update.succeeded" | "update.failed" | "update.acknowledged";
  runId: string;
  actor: { id: string | null; label: string; via: "api" | "cli" | "system" };
  target: string;        // target version
  details: Record<string, unknown>;  // mode, fromVersion, outcome, failureCode, trustMode,
                                     // verification, backupFile, step durations
}
```

### 5.14 Backups: names, retention, recovery

- Directory `<stateDir>/backups/` (`0700`), files `0600`.
- Name: `<project>-<yyyymmdd>-<hhmmss>Z-<from>-to-<to>.<ext>[.age]`; `<from>`/`<to>` are
  versions with characters outside `[0-9A-Za-z._-]` replaced by `_` (`unknown` if null);
  `<ext>`: `pgdump`, `sql.gz`, `tar.gz`, `bin`. Only files matching this pattern are listed
  or deleted, so nothing else in the directory is ever touched.
- Metadata `<name>.json`: `{ type, bytes, sha256, createdAt, runId, fromVersion, toVersion,
  verified, encrypted }`.
- Retention runs after every backup, in `finish`, at sidecar start and once a day: keep the
  newest `retention.keep`, delete those older than `retention.maxAgeDays`, never delete the
  backup referenced by the newest `needs_attention` run in history (it does not count
  towards `keep`).
- `recovery.commands` are rendered for the backup type, e.g. for PostgreSQL:

```sh
docker compose -p notes stop api worker
docker compose -p notes --profile updater exec -T updater cicd-updater backups cat <file> \
  | docker compose -p notes exec -T db sh -c 'pg_restore -U "$POSTGRES_USER" -d "$POSTGRES_DB" --clean --if-exists'
docker compose -p notes --profile updater exec updater cicd-updater recover restore-env <runId>
docker compose -p notes up -d
```

`cicd-updater backups cat` streams a backup (decryption is the operator's job: the private
age key is never on the host). `cicd-updater recover restore-env <runId>` writes the
captured previous lines of the writable keys back (byte-exact) and is available only in the
CLI, i.e. to someone with shell access to the host. Database restores are never automatic.

---

## 6. HTTP API of the sidecar (`/v1`)

### 6.1 Conventions

- JSON (`application/json; charset=utf-8`) in and out; request bodies at most 64 KiB, other
  content types are refused (415). Every response has `Cache-Control: no-store` and
  `X-Content-Type-Options: nosniff`.
- Times are RFC 3339 with offset (the sidecar answers in UTC); every state-bearing response
  carries `serverTime` so clients can compute a clock offset for countdowns.
- **Authentication:** everything under `/v1` requires `Authorization: Bearer <token>`. The
  comparison hashes both sides (SHA-256) and compares in constant time. A missing or wrong
  token is `401` with `WWW-Authenticate: Bearer`. The token never appears in any response
  or log. Unauthenticated: `GET /healthz`, `GET /public/v1/status`, the maintenance page
  assets.
- The CLI inside the container uses the same API on `127.0.0.1` with the same token.
- **Errors:** RFC 9457 `application/problem+json`:

```json
{
  "type": "urn:cicd-updater:problem:blocked",
  "title": "The updater cannot start an update now",
  "status": 409,
  "detail": "Docker is not reachable.",
  "code": "blocked",
  "blockers": [{ "code": "docker_unreachable", "detail": "connect ENOENT /var/run/docker.sock" }]
}
```

| `code` (type `urn:cicd-updater:problem:<code>`) | Status | When |
| --- | --- | --- |
| `unauthorized` | 401 | missing/wrong bearer token |
| `not_found` | 404 | unknown route or run id |
| `unsupported_media_type` | 415 | body not JSON |
| `payload_too_large` | 413 | body > 64 KiB |
| `invalid_request` | 422 | body/params fail validation (`errors`: list of `{path, message}`, at most 10) |
| `release_not_found` | 404 | version not in the feed, or no `release.json` for it |
| `release_unverifiable` | 422 | `release.json` or an image signature/digest does not verify (`checks` extension, 6.3) |
| `release_refused` | 409 | refusals (`reasons`: `not_newer`, `below_minimum_version`, `manual_steps_required`, `updater_too_old`, `env_missing`, `platform_unsupported`, `image_missing`, `running_version_unknown`) |
| `release_mismatch` | 409 | `expect.releaseSha256` differs |
| `source_not_allowed` | 409 | source mode requested but not enabled/allowlisted |
| `busy` | 409 | a run is scheduled or running |
| `blocked` | 409 | preflight blockers (`blockers` extension) |
| `not_scheduled` | 409 | reschedule without a scheduled run |
| `point_of_no_return` | 409 | cancel after the run passed the PONR |
| `not_finished` | 409 | acknowledge while scheduled/running |
| `feed_unavailable` | 502 | release host error (`feedError`: the code of 7.4) |
| `internal` | 500 | unexpected (details only in the sidecar log) |

### 6.2 Endpoints

| Method and path | Auth | Purpose |
| --- | --- | --- |
| `GET /healthz` | – | liveness `{ "status": "ok" }` (container healthcheck) |
| `GET /public/v1/status` | – | public status for the maintenance page (6.5) |
| `GET /public/v1/maintenance/` (+ assets) | – | optional maintenance page (`maintenancePage.enabled`) |
| `GET /v1/state` | ✓ | everything a UI needs: phase, run, history, running version, capabilities, trust summary |
| `GET /v1/capabilities?refresh=true` | ✓ | preflight result only |
| `GET /v1/releases?refresh=true` | ✓ | newer releases from the configured feed with refusals (unverified metadata) |
| `POST /v1/releases/{version}/verification` | ✓ | dry run: fetch + verify `release.json`, verify image signatures/existence, no pull |
| `POST /v1/runs` | ✓ | schedule a run |
| `GET /v1/runs?limit=20` | ✓ | history (summaries) |
| `GET /v1/runs/{runId}` | ✓ | one run including its log |
| `PATCH /v1/runs/{runId}` | ✓ | reschedule |
| `POST /v1/runs/{runId}/cancel` | ✓ | cancel (scheduled) or abort (running, before PONR) |
| `POST /v1/runs/{runId}/acknowledge` | ✓ | clear a finished run |
| `GET /v1/events?after=<id>&limit=100` | ✓ | journal events for the app's audit log |
| `GET /v1/backups` | ✓ | backups with metadata and protection flag |
| `GET /v1/config` | ✓ | effective configuration (redacted) and `configHash` |
| `GET /v1/openapi.json` | ✓ | the OpenAPI document of this build |

### 6.3 Request and response shapes

```ts
// POST /v1/runs
interface ScheduleRequest {
  version: string;                       // plain SemVer, as in release.json
  mode?: "image" | "source";             // default "image"
  leadSeconds?: number;                  // 0..schedule.maxLeadSeconds; exclusive with startsAt
  startsAt?: string;                     // RFC 3339 with offset, now..now+maxLeadSeconds
  requestedBy: { id?: string | null; label: string };   // label ≤ 200 chars, shown in UI and journal
  expect?: { releaseSha256?: string };   // 64 lowercase hex
}
// 202 Accepted → StateView (phase "scheduled" or "running" when leadSeconds = 0)
// Before accepting, the sidecar performs the full verification (as /verification): nothing
// unverifiable is ever announced.

// PATCH /v1/runs/{runId}
interface RescheduleRequest { leadSeconds?: number; startsAt?: string }  // exactly one

// POST /v1/runs/{runId}/cancel → 200 StateView (cancelled) | 202 StateView (abort requested)

// POST /v1/releases/{version}/verification → 200
interface VerificationResult {
  version: string;
  release: { sha256: string; document: "verified" | "not_checked"; channel: string;
             notesUrl: string | null; manualSteps: { required: boolean; summary: string | null; url: string | null };
             minimumFromVersion: string | null };
  refusals: string[];                    // as release_refused reasons; empty = installable
  images: { key: string; ref: string;
            signature: "verified" | "failed" | "not_checked";
            exists: boolean | null;      // null = unknown (registry unreachable/unauthorized)
            error: string | null }[];    // a fetch.* failure code
  checkedAt: string;                     // cached for 10 minutes per version
}

// GET /v1/state → 200
interface StateView {
  api: { version: "1.0"; features: string[] };          // feature flags for clients
  updater: { version: string; configHash: string; latestAvailable: string | null };
  phase: Phase;
  run: Run | null;                       // without runContext
  history: RunSummary[];
  running: { version: string | null; source: "health" | "label" | "state" | "env" | null };
  trust: { mode: "keyless" | "key" | "none"; identity: string | null; keys: number | null };
  sourceMode: { enabled: boolean; allowlist: string[] };
  capabilities: Capabilities;
  serverTime: string;
}

interface Capabilities {
  ready: boolean;                        // no blockers
  blockers: { code: string; detail: string | null }[];
  warnings: { code: string; detail: string | null }[];
  docker: { serverVersion: string | null; apiVersion: string | null;
            architecture: "linux/amd64" | "linux/arm64" | null; imageStore: "classic" | "containerd" | null };
  compose: { projectName: string; projectDir: string; files: string[]; envFile: string };
  backups: BackupInfo[];
  checkedAt: string;
}

// GET /v1/releases → 200
interface ReleasesView {
  channel: "stable" | "beta";
  running: string | null;
  releases: { version: string; tag: string; channel: string; publishedAt: string | null;
              notesUrl: string | null; releaseSha256: string | null;
              minimumFromVersion: string | null; manualStepsRequired: boolean;
              refusals: string[]; verified: false }[];   // newest first, ≤ 10
  nextInstallable: string | null;        // newest release without refusals
  checkedAt: string;
}

// GET /v1/events?after=<id>&limit=<1..500>
interface EventsView { events: JournalEvent[]; next: string | null; gap: boolean }
// gap = true when `after` is older than the oldest retained event (events were lost)
```

### 6.4 Journal ingestion (exactly once)

The app stores the id of the last event it wrote (`cursor`). Periodically (every 30 s idle,
every 3 s while a run is scheduled or running) it calls `GET /v1/events?after=<cursor>`,
writes each event into its audit log **and** advances the cursor in the same database
transaction, in id order. Event ids are sortable and unique across sidecar restarts (a clock
that steps back never reorders them). This works across the app's own restart in the middle
of an update: events the sidecar recorded while the app was down are ingested afterwards.

### 6.5 Public status (`GET /public/v1/status`)

What an anonymous visitor may see; no user, no image, no log, no path, no versions unless
`publicStatus.showVersions`.

```ts
interface PublicStatus {
  phase: Phase;
  runId: string | null;
  outcome: Outcome | null;
  startsAt: string | null; startedAt: string | null; finishedAt: string | null;
  step: StepId | null;
  steps: { id: StepId; status: StepStatus }[];
  progress: number;
  message: { code: string; params: Record<string, string | number> } | null;
  failureCode: string | null;
  targetVersion?: string; fromVersion?: string;   // only with showVersions
  serverTime: string;
}
```

When the sidecar is not running, an edge SHOULD answer this path with the idle document
(`phase: "idle"`) or a 502 that the page treats as idle.

### 6.6 API versioning

- The path prefix is the major version. 1.x only adds: new endpoints, new optional request
  fields, new response fields, new enum values for codes (clients MUST tolerate unknown
  fields and render unknown codes generically).
- `StateView.api.features` lists optional capabilities (`abort`, `reschedule`,
  `verification`, `source_mode`, `encryption`, ...) so an SDK can adapt to an older sidecar.
- A breaking change gets `/v2`; a sidecar 2.x serves `/v1` for at least one major version.
- An SDK that receives a `StateView` it cannot parse reports `incompatible` (the sidecar
  speaks another major version) and tells the operator to align versions.

### 6.7 OpenAPI 3.1 outline (`openapi/updater-api.v1.yaml`, generated and committed)

```yaml
openapi: 3.1.0
info:
  title: cicd-updater sidecar API
  version: "1.0"
  license: { name: Apache-2.0, identifier: Apache-2.0 }
servers: [{ url: "http://updater:8090" }]
security: [{ bearerToken: [] }]
paths:
  /healthz:                  { get: { operationId: getHealth, security: [] } }
  /public/v1/status:         { get: { operationId: getPublicStatus, security: [] } }
  /v1/state:                 { get: { operationId: getState } }
  /v1/capabilities:          { get: { operationId: getCapabilities, parameters: [refresh] } }
  /v1/releases:              { get: { operationId: listReleases, parameters: [refresh] } }
  /v1/releases/{version}/verification: { post: { operationId: verifyRelease } }
  /v1/runs:                  { get: { operationId: listRuns }, post: { operationId: scheduleRun } }
  /v1/runs/{runId}:          { get: { operationId: getRun }, patch: { operationId: rescheduleRun } }
  /v1/runs/{runId}/cancel:   { post: { operationId: cancelRun } }
  /v1/runs/{runId}/acknowledge: { post: { operationId: acknowledgeRun } }
  /v1/events:                { get: { operationId: listEvents, parameters: [after, limit] } }
  /v1/backups:               { get: { operationId: listBackups } }
  /v1/config:                { get: { operationId: getConfig } }
  /v1/openapi.json:          { get: { operationId: getOpenApi } }
components:
  securitySchemes:
    bearerToken: { type: http, scheme: bearer }
  schemas:
    Phase, StepId, StepStatus, Outcome, Message, Step, Failure, Recovery, Run, RunSummary,
    Capabilities, Blocker, Warning, BackupInfo, StateView, PublicStatus, ScheduleRequest,
    RescheduleRequest, VerificationResult, ReleasesView, JournalEvent, EventsView,
    ConfigView, Problem
  responses:
    Problem: { content: { application/problem+json: { schema: { $ref: "#/components/schemas/Problem" } } } }
```

The document is generated from the zod schemas of `packages/protocol` (single source of
truth); CI fails when the committed file differs.

---

## 7. SDK (TypeScript): `@restow-backup/cicd-updater`

### 7.1 Package shape

One package, ESM only, TypeScript declarations included, no runtime dependency on other
packages of this repository (everything bundled), Node.js ≥ 22 for server-side parts.

| Import | Runtime | Content |
| --- | --- | --- |
| `@restow-backup/cicd-updater` | Node ≥ 22 (server side of the app) | `createUpdaterClient`, errors, types |
| `@restow-backup/cicd-updater/feed` | Node ≥ 22 | `checkFeed` with the SSRF guard |
| `@restow-backup/cicd-updater/auth` | Node ≥ 22 | `createTokenVerifier` for the app's health endpoint |
| `@restow-backup/cicd-updater/protocol` | any | zod schemas and types of every document, codes, `progressOf` |
| `@restow-backup/cicd-updater/semver` | any | `parseVersion`, `compareVersions`, `isNewer`, `channelAllows`, `satisfiesRange` |
| `@restow-backup/cicd-updater/messages` | any | `en` and `de` catalogs for step, message, failure and blocker codes |
| `@restow-backup/cicd-updater/react` | browser (React ≥ 18, optional peer) | components and hooks (7.7) |

The browser parts never talk to the sidecar; they talk to the app's own endpoints (and, for
the maintenance page, to the public status through the edge).

### 7.2 Client

```ts
export interface UpdaterClientOptions {
  url: string;                              // e.g. "http://updater:8090"; no trailing slash needed
  token?: string;                           // or tokenFile
  tokenFile?: string;                       // re-read after 30 s and after every 401 (new token after a volume reset)
  timeoutMs?: number;                       // default 5000 (verification/schedule: 120000)
  stateTtlMs?: number;                      // default 2000: concurrent state() calls share one request
  unavailableTtlMs?: number;                // default 8000: "nothing answers" is remembered this long
  fetch?: typeof fetch;                     // for tests
}

export interface UpdaterClient {
  state(options?: { fresh?: boolean; refreshCapabilities?: boolean }): Promise<StateView | null>; // null: no sidecar
  capabilities(options?: { refresh?: boolean }): Promise<Capabilities>;
  releases(options?: { refresh?: boolean }): Promise<ReleasesView>;
  verifyRelease(version: string): Promise<VerificationResult>;
  schedule(request: ScheduleRequest): Promise<StateView>;
  reschedule(runId: string, when: { leadSeconds: number } | { startsAt: string | Date }): Promise<StateView>;
  cancel(runId: string): Promise<StateView>;           // cancel or abort, see run.abortRequestedAt
  acknowledge(runId: string): Promise<StateView>;
  run(runId: string): Promise<Run>;
  history(limit?: number): Promise<RunSummary[]>;
  events(after: string | null, limit?: number): Promise<EventsView>;
  backups(): Promise<BackupInfo[]>;
  publicStatus(): Promise<PublicStatus>;
}

export function createUpdaterClient(options: UpdaterClientOptions): UpdaterClient;

/** Exactly-once journal ingestion (6.4). */
export function syncJournal(options: {
  client: UpdaterClient;
  loadCursor(): Promise<string | null>;
  /** Write the event to the audit log AND store event.id as the cursor, in one transaction. */
  ingest(event: JournalEvent): Promise<void>;
  onGap?(info: { after: string | null }): Promise<void>;
}): Promise<{ ingested: number; gap: boolean }>;

export const DEFAULT_LEAD_TIMES: readonly number[]; // [0, 60, 300, 900, 1800, 3600] seconds
```

Behaviour carried over from Restow's client: the secret never follows a redirect
(`redirect: "error"`), a 401 re-reads the token file once, an unparseable state answer is
`UpdaterUnavailableError("incompatible")`, "no sidecar" is a normal result (`state()`
resolves `null`) because the sidecar is opt-in.

### 7.3 Feed check with SSRF protection (`/feed`)

The app may check for updates even when no sidecar runs (to notify admins). The feed URL
may come from an admin, so the check MUST NOT become a tool to probe the internal network.

```ts
export interface FeedCheckOptions {
  feed: { type: "github" | "gitea" | "gitlab" | "static"; url: string };
  token?: string | null;                    // sent as "Authorization: token|Bearer <t>" to the feed origin only
  channel: "stable" | "beta";
  running: string | null;                   // the app's own version
  tagPattern?: string;                      // default "v{version}"
  allowPrivateHosts?: string[];             // operator decision: hosts allowed on private/loopback networks
  resolveDocuments?: number;                // release.json documents fetched for the newest N (default 10, max 10)
  timeoutMs?: number;                       // list default 10000; assets 15000
  now?: () => Date;
}

export type FeedCheckResult =
  | { ok: true; checkedAt: string; releases: FeedRelease[]; latest: FeedRelease | null;
      updateAvailable: boolean | null; nextInstallable: FeedRelease | null }
  | { ok: false; checkedAt: string; error: FeedError };

export interface FeedRelease {
  version: string; tag: string; channel: "stable" | "beta"; publishedAt: string | null;
  notesUrl: string | null;
  document: ReleaseDocument | null;         // parsed release.json, NOT signature-verified (the sidecar verifies)
  documentSha256: string | null;            // pass as expect.releaseSha256 when scheduling
  refusals: Array<"no_release_document" | "below_minimum_version" | "manual_steps_required" | "not_newer">;
}

export function checkFeed(options: FeedCheckOptions): Promise<FeedCheckResult>;
```

Network rules (all MUST, tested with a fake DNS and fake servers):

1. https only; no credentials in URLs; the token travels only as a header.
2. Every connection resolves the host inside the socket's own lookup and refuses unless
   **every** resolved address is public. Refused: `0.0.0.0/8`, `10/8`, `100.64/10`,
   `127/8`, `169.254/16` (cloud metadata), `172.16/12`, `192.0.0/24`, `192.0.2/24`,
   `192.168/16`, `198.18/15`, `198.51.100/24`, `203.0.113/24`, `224/4`, `240/4`,
   `255.255.255.255`, `::`, `::1`, `::ffff:0:0/96` (checked as the embedded IPv4),
   `64:ff9b::/96` and `2002::/16` (embedded IPv4 checked), `2001::/32`, `2001:db8::/32`,
   `fc00::/7`, `fe80::/10`, `ff00::/8`. Hosts in `allowPrivateHosts` (exact, lowercase)
   may resolve to private ranges (never to link-local metadata addresses). No connection
   pooling (each connection runs the guarded lookup; this defeats DNS rebinding).
3. Redirects are followed by hand, at most 3, https only. For the **release list** only
   redirects within the same origin are followed (`redirect` error otherwise). For **asset
   downloads** a redirect to another origin is followed (GitHub serves assets from a CDN)
   but the `Authorization` header is dropped at the first origin change and never re-added;
   the new host passes rule 2.
4. Bodies are read as streams and abandoned past the caps (8 MiB list, 64 KiB
   `release.json`); declared `Content-Length` above the cap is refused at once.
5. A refused address, a DNS failure and a failed connection all yield `network` without
   detail (the result must not tell what exists behind a name); only TLS errors of a host
   that was allowed and answered are named (`CERT_HAS_EXPIRED`, ...).
6. The check sends nothing about the installation (no version in the URL, a fixed
   `User-Agent: cicd-updater-feed/1`).

### 7.4 Channels, SemVer, errors

- SemVer 2.0.0 precedence (pre-release ordering per spec item 11); `v` prefix accepted on
  input, build metadata ignored for comparison and refused in targets.
- `stable` offers only versions without pre-release; `beta` offers both. Within a channel:
  newest first, duplicates removed, at most 10.
- `nextInstallable`: the newest release whose `minimumFromVersion` ≤ running, without
  `manual_steps_required`; if the newest is below its minimum, the UI shows the path
  (install `nextInstallable` first).
- Feed error codes (`FeedError.code`): `rate_limited` (with `retryAt` from `Retry-After` or
  `X-RateLimit-Reset`), `unauthorized` (401), `forbidden` (403), `not_found` (404; for a
  private repository this usually means "token without access", the UI says so),
  `server_error` (5xx), `network`, `timeout`, `invalid_response` (`detail`: `not_json`,
  `too_large`, `schema`), `no_release`, `redirect`.
- Typed errors of the client:

```ts
export class UpdaterUnavailableError extends Error {
  reason: "disabled" | "no_token" | "unreachable" | "timeout" | "incompatible";
}
export class UpdaterProblemError extends Error {          // the sidecar answered with problem+json
  status: number; code: string; problem: Problem;        // e.g. code "blocked", problem.blockers
}
export class FeedError extends Error {
  code: FeedErrorCode; status: number | null; retryAt: string | null; detail: string | null;
}
```

### 7.5 Token verifier for the app's health endpoint (`/auth`)

```ts
export function createTokenVerifier(options: { tokenFile: string; ttlMs?: number }): {
  /** Constant-time check of "Authorization: Bearer <token>" against the shared token file. */
  isUpdater(authorizationHeader: string | null | undefined): Promise<boolean>;
};
```

Pattern: the app's health endpoint always answers readiness; it adds `version` (and other
details) only when `isUpdater(...)` is true. A public version number tells an attacker which
known vulnerability is still open.

### 7.6 What stays the app's job (and recommended patterns)

| Job | Why the app | Recommended pattern |
| --- | --- | --- |
| Authorization | only the app knows users and roles | only an installation-level admin role may schedule, reschedule, cancel, acknowledge; reading the update state may be broader |
| Step-up | scheduling decides what code runs next to the Docker socket | require a sign-in younger than 10 minutes with a strong method (passkey, password + TOTP, OIDC) for scheduling and for changing the feed or its token; answer older sessions with a problem the UI turns into a "confirm it is you" dialog; impersonated sessions never count |
| Audit log | the sidecar has no database | ingest the journal with `syncJournal`; audit the feed check and settings changes yourself |
| Feed settings and token storage | secrets belong in the app's secret store | store a private feed token encrypted, bound to the origin it was issued for; changing the feed origin deletes the token instead of sending it elsewhere; never return it in an API response |
| "Update available" notification | user-facing | check once a day (retry failures after one hour at the earliest, respect `retryAt`); raise the notification once per version with a claim (`notifiedVersion`) written in the same transaction as the notification |
| Maintenance banner/overlay | user-facing | an app endpoint that every signed-in user may read returns the run summary (with versions); the browser polls it every 30 s idle, every 2 s while scheduled/running; on 502/503/504 or network errors during a run it switches to the edge's public status and reloads when the new version answers |
| Health with version | only the app knows its version | 7.5 |
| Demo or read-only installations | product policy | do not configure a sidecar; the UI shows manual update steps |

Manual updating MUST stay documented and possible for every adopter: the sidecar is a
convenience, not a requirement.

### 7.7 React components (`/react`)

Headless-first components with `className`/`data-state` hooks and CSS variables, styled in
the examples with Tailwind classes compatible with shadcn/ui; no dependency on shadcn.

```ts
export function useMaintenance(options: {
  fetchMaintenance: () => Promise<MaintenanceView>;      // the app's own endpoint
  fetchPublicStatus?: () => Promise<PublicStatus | null>;// via the edge, used while the app is down
  idlePollMs?: number;                                   // 30000
  activePollMs?: number;                                 // 2000
  onReload?: () => void;                                 // default: location.reload()
}): MaintenanceSnapshot;   // { view, apiReachable, offsetMs, phase, countdownSeconds }

export function useCountdown(startsAt: string | null, offsetMs: number): number | null;
export function MaintenanceBanner(props: { snapshot: MaintenanceSnapshot; messages?: Messages; className?: string }): JSX.Element | null;
export function UpdateProgress(props: { snapshot: MaintenanceSnapshot; messages?: Messages; className?: string }): JSX.Element | null;
```

Behaviour (from Restow's maintenance shell): clock offset from `serverTime` (largest of the
last 8 samples), reload 2.5 s after `succeeded` so the result is seen, never two reloads
within 60 s, a failed run older than 24 h is not announced to a page that did not see it.

---

## 8. Security model and threat model

### 8.1 The premise: the Docker socket is root

Whoever controls the sidecar controls the host: with the Docker socket it can start any
container with any mount. Everything in this design follows from that:

- **Opt-in.** The sidecar is a Compose profile that does nothing until the operator starts
  it. Manual updates remain fully supported.
- **Smallest surface.** The API offers scheduling of *signed releases from the configured
  feed* and nothing else: no endpoint runs a command, chooses an image, a repository, a hook
  or a file. Hooks come only from `updater.yaml`, which only the host operator writes.
- **No application credentials** in the sidecar (2.3); built-in database commands run inside
  the database container with its own environment.
- **Internal network only**, no published port (blocker), bearer token from a volume.
- **Pinned and never self-updated.** The sidecar's own image is pinned by the operator
  (digest recommended); a run refuses to start while the sidecar's image would follow a key
  it rewrites, so the container holding the socket never runs an image the sidecar
  installed.
- **Verification isolated.** cosign parses registry and transparency-log responses in a
  container without the socket and without capabilities.
- **Least privilege does not mean non-root here.** Running the sidecar as a non-root user
  with the socket's group gives the same power; the docs say so instead of pretending.

### 8.2 Trust modes

Configured on both sides, independently, and never changed implicitly.

| | `keyless` | `key` | `none` |
| --- | --- | --- | --- |
| Release side input | `signing: keyless` (default on GitHub Actions and GitLab CI) | `signing: key` + `cosign-key` secret (+ password), or a KMS URI | `signing: none` |
| Works on | GitHub Actions, GitLab CI (incl. self-managed GitLab with its own issuer, if the Sigstore instance accepts it) | any CI: Forgejo/Gitea Actions, Woodpecker, Jenkins, laptops; private registries | any |
| Trust anchor | the CI's OIDC identity of the release workflow at the release tag, Sigstore root, transparency log | possession of the private key | TLS of the release host and registry only |
| Sidecar config | `trust.keyless.*` (4.6) | `trust.key.publicKeyFiles` | `trust.none.acknowledgeUnsigned: true` |
| `release.json` | Sigstore bundle verified (identity, issuer, tag) | bundle verified against the keys | not verified (`document: not_checked`) |
| Images | `cosign verify` of `repo@digest` for the exact identity | `cosign verify --key` | not verified; digest still required and compared after the pull |
| Transparency log | always (public Rekor) | off by default (`transparencyLog`); then nothing about the release is published | – |
| Network needs | Sigstore TUF CDN (or `trustedRootFile`), registry | registry only | registry only |

Rules (MUST):

- **Default requires a signature.** Without a `trust` section the mode is `keyless`; an
  incomplete `keyless` or `key` configuration is a config error and the sidecar does not
  start (exit 64) with a message naming the missing keys and pointing to
  `docs/trust-modes.md`.
- **`none` is deliberate.** It requires `mode: none` **and**
  `none.acknowledgeUnsigned: true`. It adds warning `trust_mode_none` to the capabilities;
  `GET /v1/state` exposes `trust.mode`; every run records `trustMode: "none"`,
  `verification.signatures: "not_checked"` and logs "signature not checked (trust mode
  none)"; the journal events carry it; the SDK messages and the React components display
  it. Digests remain mandatory: a release without a digest for every needed image is never
  installed.
- **No fallback.** In `keyless`/`key` mode a missing, invalid or unverifiable signature
  (including "Sigstore unreachable") fails the run before the PONR with outcome
  `unchanged`. The sidecar never retries in a weaker mode; switching modes requires
  changing `updater.yaml` and recreating the sidecar.
- Key rotation in `key` mode: list old and new public key, sign new releases with the new
  key, remove the old key later. Revocation = removing a key from the list.

Risk of `none` (stated in `docs/trust-modes.md`): anyone who can change the release
document (release host account, a compromised CI token, a man in the middle where TLS is
broken) can make the host run an image of their choice with the app's data and next to a
root-equivalent socket. Use it only for test installations or fully private networks where
the operator controls build, registry and host; prefer `key` mode, which costs one secret.

### 8.3 What is verified and what is not

| Verified (image mode, `keyless`/`key`) | Not verified |
| --- | --- |
| `release.json` was signed by the release identity/key; version, tag, channel, digests, minimum version, manual steps, requirements as signed | that the code in the release is free of bugs or malicious changes made through the legitimate workflow |
| each image digest carries a signature of the same identity at the same tag (keyless) or by the key | who wrote the commits, signed Git tags, reviews |
| the pulled image has exactly the verified digest | the base images and dependencies inside the image (SBOM attestations are produced but not evaluated) |
| the target is strictly newer than the running version; not below its minimum | freshness: a feed that withholds new releases (freeze attack) is not detected |
| the running version reported by the app after the update | that the app's health endpoint tells the truth |

### 8.4 Source mode (unsigned by nature)

Building from a repository archive on the host means: whoever controls that repository's
tag controls the code that runs with the app's data. Therefore:

- off by default; on only when `source.allowlist` is non-empty **and** the configured feed
  repository matches an entry (`host/owner/repo` recommended; a bare host allows every
  repository on it, and `github.com` alone allows all of GitHub: the docs say not to);
- the request only selects `mode: "source"`; the repository always comes from
  `updater.yaml` (an app or API caller can never point the build elsewhere);
- the archive is fetched over https only; the token travels as a header to the archive's
  origin only and is dropped on a redirect to another origin; at most 3 redirects; size cap
  `source.maxArchiveMb`; extraction refuses absolute paths, `..`, links pointing outside
  the tree and device files; a `Dockerfile` must exist for each built image key;
- runs record `verification.signatures: "not_applicable"` and `mode: "source"`; the
  capabilities carry warning `source_mode_enabled`;
- `release.json`, when the release has one, is still honoured for `upgrade` and `requires`
  (unsigned in this mode).

Builds on the production host also compete with the running app for CPU and memory; the
recommended way is image mode with builds in CI or on a separate build node.

### 8.5 Threat model

Assets: the host (root through the socket), the app's data and database, backups (plaintext
copies of all data unless encrypted), secrets in the env file, the shared token, the signing
key (`key` mode), the release pipeline.

| # | Adversary / event | Mitigation | Residual risk |
| --- | --- | --- | --- |
| T1 | Network attacker between host and registry/feed/Sigstore | TLS; signatures and digests; `release.json` signed | `none` mode relies on TLS only |
| T2 | Compromised or malicious registry/mirror | images verified by digest and signature; pull by digest | denial of service |
| T3 | Someone who can edit releases/assets but not run the workflow | signed `release.json` binds digests, minimum version, manual steps | denial of service (delete assets) |
| T4 | Compromised app (RCE in the app container), holding the token | API allows only signed, newer releases from the configured feed; no command, image or source choice; no downgrade | forced update to a legitimate newer release, cancelling, reading update state and backup metadata (not contents) |
| T5 | Other container on the internal network | token required; token file mounted only into the app | if the operator mounts the token elsewhere |
| T6 | Compromised CI or release workflow (trust anchor) | out of the sidecar's reach; repository protections (8.6) | full: a signed malicious release is installed |
| T7 | Leaked signing key (`key` mode) | key rotation/revocation via config; optional transparency log for detection | releases signed with the stolen key until removed |
| T8 | Replay / downgrade with an old signed release | strictly-newer check, signed version/tag in `release.json` | – |
| T9 | Freeze (feed hides new releases) | none in 1.0 | stale installations |
| T10 | Huge or slow responses (DoS) | size caps, timeouts, streaming | – |
| T11 | Information leak through the public status | no versions, no images, no paths, no logs | phase and timing are public by design |
| T12 | Local host user reading backups | volume `0700`/files `0600`, optional `age` encryption, retention by count and age | root on the host can read plaintext backups |
| T13 | SSRF through an admin-entered feed URL in the app | SDK guard (7.3) | operator-allowed private hosts |
| T14 | Secrets in logs, status, problem details, process lists | redactor (known values + patterns), no secrets in argv or child environments, registry credentials as per-verification files | patterns can miss unknown token formats (`logging.redactPatterns`) |
| T15 | Env file injection | only writable keys; values must match the image reference grammar | – |
| T16 | TOCTOU between verification and pull | pull by digest, write digest-pinned references | – |
| T17 | Two sidecars on one project | state lock, label scan | unlabelled sidecars on other volumes |
| T18 | Malicious hook configuration | only the operator writes `updater.yaml`; the app has no write access to the project directory (documented requirement) | an operator mistake |

### 8.6 Supply-chain assumptions and recommended protections

The release workflow is the trust anchor in `keyless` mode, the key and its CI secret in
`key` mode. Recommended for adopters on GitHub (and the cicd-updater project itself):

- Tag protection ruleset for `v*`: only maintainers create them, no update, no deletion;
  release tags made from the default branch only (the template checks it); annotated tags
  (signed tags recommended).
- Branch protection on the default branch: pull requests with review, required status
  checks, no force push.
- The publishing job runs in an environment with required reviewers (optional but
  recommended for public projects); `permissions: {}` at workflow level, `id-token: write`,
  `packages: write`, `contents: write` only in the job that needs them.
- Third-party actions pinned to full commit SHAs (with the version in a comment), updated by
  Dependabot/Renovate; the cicd-updater actions are referenced by SHA too.
- No personal access tokens in the release workflow; `GITHUB_TOKEN` only.
- GHCR package visibility and access tied to the repository.
- Never move or reuse a tag: an image is immutable, a tag is not; a correction gets a new
  version number.
- GitLab: protected tags, `id_tokens` only in the signing job. Forgejo/Gitea: the cosign
  private key as an Actions secret scoped to the repository, protected tags.

### 8.7 Secrets handling

| Secret | Where | Rules |
| --- | --- | --- |
| Shared token | generated in `/shared/token` (or operator file) | `0640 root:<tokenGroupId>`; mounted read-only into the app only; never logged or returned |
| Feed/source token | `release.feed.tokenFile` / `source.tokenFile` | read when needed; header to the issuing origin only; registered with the redactor |
| Registry credentials | `docker.registryAuthFile` | `auths` only; for the verifier a per-verification file with the one needed entry, deleted after use |
| Env file values | project `.env` | read for editing; credential-looking values registered with the redactor; never copied elsewhere |
| Backup encryption | `age` public recipients only | the private key never on the host |
| Signing key (release side) | CI secret or KMS | never in the repository; password as separate secret |

No secret is ever placed in a command-line argument (visible in process lists) or in the
environment of a child process, except the per-container `MYSQL_PWD` set *inside* the
database container's own shell from that container's own environment.

### 8.8 `SECURITY.md` (content to ship)

1. **Supported versions:** the latest minor of the current major receives fixes; the
   previous minor for 3 months after a new minor.
2. **Reporting:** GitHub private vulnerability reporting of the repository (preferred) or
   the security contact address the maintainer publishes there; no public issues for
   vulnerabilities. Include version, configuration (redacted), steps.
3. **Response:** acknowledgement within 5 business days, assessment within 14 days,
   coordinated disclosure, default embargo up to 90 days, credit if wanted.
4. **Scope:** the sidecar image, the release actions/CLI, the SDK, the JSON schemas and the
   OpenAPI contract. Out of scope: the fact that the sidecar holds the Docker socket (by
   design, documented), installations in `trust.mode: none`, vulnerabilities of adopters'
   apps.
5. **Verifying our releases:** the exact `cosign verify` command for the sidecar image with
   the identity `https://github.com/restow-backup/cicd-updater/.github/workflows/release.yml@refs/tags/v<version>`
   and issuer `https://token.actions.githubusercontent.com`, and `cosign verify-blob` for
   `SHA256SUMS`.
6. **Hardening guide** link (`docs/security.md`).

---

## 9. Compatibility matrix

Legend: **Tested** = covered by the project's CI; **Expected** = documented to work by the
upstream project, not in our CI; **To verify** = MUST be tested in the e2e before 1.0 and
the result recorded in `docs/compatibility.md`; **Unsupported**.

### 9.1 Host

| Item | Status | Notes |
| --- | --- | --- |
| Linux host, Docker Engine ≥ 24 (API ≥ 1.43) | Tested (current Engine in CI) | older Engines: blocker `docker_too_old` |
| Docker Compose | n/a on the host | the sidecar ships its own Compose plugin (pinned); the host's Compose version does not matter for the sidecar |
| Classic image store | Tested | |
| containerd image store | To verify | digest check (5.3 fetch 4) and `repo:tag@digest` resolution |
| Rootless Docker | To verify | `docker.socket` path; same-path bind mount |
| SELinux enforcing | Expected | bind mounts may need `:z`; documented |
| Docker Desktop, colima (macOS/Windows) | development only | same-path mount must be shared with the VM |
| Podman (Docker-compatible API) | Unsupported (untested) | may work; no promise |
| Kubernetes, Swarm | Unsupported | non-goal |
| Architectures | Tested: `linux/amd64`, `linux/arm64` | sidecar image and release actions; no 32-bit ARM |

### 9.2 Apps and stacks

| Prerequisite | Requirement |
| --- | --- |
| Compose | v2 file format; managed services take `image:` from a variable in the env file |
| Images | built by a CI (or source mode); OCI labels set by the build action |
| Health | an HTTP endpoint (ideally revealing the version to the token) or a command; without it only container state is checked |
| Database | in the same Compose project for built-in backup/probe; migrations idempotent at start or via `hooks.migrate` |
| Rollback | needs a migration probe, or `rollback.policy: always` for stateless apps |

| Language / framework | Integration | Status |
| --- | --- | --- |
| Node.js / TypeScript | level 3 (SDK, React) | Tested (example) |
| Python | level 2 (HTTP API) | Tested (example) |
| Static sites (nginx, Caddy) | level 1 (CLI) | Tested (example) |
| Go, PHP, Java, .NET, Ruby | level 2 | Expected (OpenAPI) |

| Built-in backup / probe | Versions | Status |
| --- | --- | --- |
| PostgreSQL (`pg_dump -Fc` in the DB container) | 13–17 | Tested: 16, 17; Expected: 13–15 |
| MySQL (`mysqldump`) | 8.0, 8.4 | Tested: 8.4 |
| MariaDB (`mariadb-dump`) | 10.6–11.x | Tested: 11 LTS |
| SQLite, file data | via `volume` (quiesced) | Tested |
| MongoDB, Redis, others | via `command` | Expected |

### 9.3 CI systems and registries (trust modes)

| CI | `keyless` | `key` | `none` |
| --- | --- | --- | --- |
| GitHub Actions | Tested (positive path signed by the CI's own OIDC on pushes to the main repository) | Tested | Tested |
| GitLab CI (gitlab.com) | Expected (`SIGSTORE_ID_TOKEN`, documented template) | Expected | Expected |
| GitLab self-managed | Expected only if the Sigstore instance trusts its issuer; otherwise use `key` | Expected | Expected |
| Forgejo / Gitea Actions | Unsupported (no OIDC identity accepted by public Sigstore) | To verify (composite actions on the Forgejo runner) | To verify |
| Other CI (Woodpecker, Jenkins, ...) | Unsupported | Expected (`cicd-updater release ...` CLI) | Expected |

Signature storage depends on cosign (3.4): cosign 3 writes signatures and bundles as
OCI 1.1 referring artifacts and falls back to the referrers tag schema (`sha256-<digest>`
index) where the registry has no referrers API; cosign 2 wrote `sha256-<digest>.sig` tags.
Key-based and keyless signatures use the same storage, so the registry question is the same
for both modes.

| Registry | Pull by digest | cosign 3 signatures (referrers or fallback tag) | Status |
| --- | --- | --- | --- |
| GHCR | yes | yes | Tested |
| Docker Hub | yes | yes (listed by Sigstore) | Expected |
| GitLab container registry | yes | yes (listed by Sigstore) | Expected |
| distribution/registry (v2, v3) | yes | fallback tag schema | Tested (the e2e registry) |
| Harbor (≥ 2.5) | yes | yes (listed by Sigstore; referrers in newer versions) | Expected |
| Forgejo / Gitea built-in registry | yes | unknown: neither the Forgejo nor the Gitea documentation mentions OCI referrers, image indexes as artifacts or cosign | **To verify** (e2e job with a Forgejo container: push, sign `key` mode, verify; also check the token scopes needed to read) |
| Quay, ECR, ACR, Artifactory | yes | yes (listed by Sigstore) | Expected |
| Any registry without signatures | yes | – | `none` mode only |

If the Forgejo/Gitea e2e fails for the cosign 3 default storage, the options are open
question Q5. Known self-hosted quirks the docs cover: a successful `docker login` proves the
account, not the right to read a package; some registries need broader token scopes even
for pulls; private registries may answer 404 instead of 401/403 (the sidecar classifies by
message and never reports "not found" when access was not confirmed).

### 9.4 Release hosts (feed)

| Provider | Status |
| --- | --- |
| GitHub releases (public and private) | Tested (fake server) + Tested (real, the project's own releases) |
| Forgejo / Gitea releases API (with path prefix) | Tested (fake server); To verify (real Forgejo in the e2e) |
| GitLab releases (asset links) | Tested (fake server) |
| Static index (any https host) | Tested |
| File feed (mounted directory) | Tested (release smoke, air-gapped scenario) |

### 9.5 SDK runtimes

| Runtime | Status |
| --- | --- |
| Node.js 22, 24 | Tested |
| Bun, Deno | Expected for `/protocol`, `/semver`, `/messages`; `/feed` requires Node's `net` lookup hook: Unsupported elsewhere |
| Browsers | `/react`, `/protocol`, `/semver`, `/messages` only |

---

## 10. Repository, packages, versioning, release process, CI

### 10.1 Layout

```
cicd-updater/
├── packages/
│   ├── protocol/        zod schemas + types of release.json, updater.yaml, status, API views,
│   │                    codes, semver, progress; generators for JSON Schema and OpenAPI   (private)
│   ├── engine/          state machine, steps, rollback rule, ports/interfaces, fakes      (private)
│   ├── sidecar/         config loader, HTTP server, CLI, docker ops, runner, env file,
│   │                    hooks, backups, feed providers, verifier, redactor, maintenance page (private)
│   ├── release-tools/   release.json create/validate/sign/verify/upload, env-example check,
│   │                    smoke runner (used by actions/ and the `release` CLI)              (private)
│   └── sdk/             the published package @restow-backup/cicd-updater (client, feed,
│                        auth, protocol, semver, messages, react), bundles protocol         (published)
├── actions/
│   ├── build/           composite: buildx, push by digest, OCI labels
│   ├── smoke/           composite: compose + digests + .env.example checks (+ upgrade-from)
│   ├── publish/         composite: index, tags, sign (keyless | key | none), optional SBOM
│   ├── release-json/    composite: create, validate, sign, upload, publish the release
│   └── release/         composite: all of the above in one job (QEMU multi-arch), for simple projects
├── templates/           copyable workflows: github/release.yml, forgejo/release.yml, gitlab/.gitlab-ci.yml
├── schemas/             generated JSON Schemas (release, feed-index, updater-config, status, public-status)
├── openapi/             generated updater-api.v1.yaml
├── docker/              Dockerfile of the sidecar image (pinned docker CLI, compose, buildx, cosign, age)
├── e2e/                 harness, stub app images, scenarios (10.7)
├── examples/            node-postgres/, python-postgres/, static-site/
├── docs/                (section 12)
├── .github/workflows/   ci.yml, e2e.yml, release.yml, scheduled.yml (weekly e2e + dependency checks)
├── README.md CHANGELOG.md CONTRIBUTING.md SECURITY.md CODE_OF_CONDUCT.md LICENSE NOTICE
└── package.json pnpm-workspace.yaml tsconfig.base.json biome.json
```

Tooling: pnpm workspaces, TypeScript (strict, `noUncheckedIndexedAccess`), Biome (lint and
format), Vitest, zod, Hono, tsup for the SDK bundle. Runtime of the sidecar image: Node.js
24 LTS on Alpine. A boundary test forbids `packages/engine` and `packages/sidecar` from
importing anything that is not in the repository or in an allowlist of dependencies.

### 10.2 Published artefacts and names

| Artefact | Name | Where |
| --- | --- | --- |
| Sidecar image (also contains the `release` CLI) | `ghcr.io/restow-backup/cicd-updater:<X.Y.Z>` | GHCR, multi-arch, signed keyless, SBOM attestation; only immutable `X.Y.Z` tags |
| SDK | `@restow-backup/cicd-updater` | GitHub release asset `restow-backup-cicd-updater-<X.Y.Z>.tgz` (always); npm (when trusted publishing is set up) |
| Actions | `restow-backup/cicd-updater/actions/<name>@v<X.Y.Z>` | the repository; `v1` moving major tag for convenience, pinning by SHA recommended |
| Schemas, OpenAPI | `schemas/*.json`, `openapi/*.yaml` | repository at the tag and release assets |
| Checksums | `SHA256SUMS` + `SHA256SUMS.sigstore.json` | release assets (covers tarball, schemas, OpenAPI) |
| Own `release.json` | `release.json` + bundle | release assets (dogfooding; image key `updater`) |

npm without npm: 1.0 MUST be installable as
`npm install https://github.com/restow-backup/cicd-updater/releases/download/v1.0.0/restow-backup-cicd-updater-1.0.0.tgz`.
The package name inside the tarball is the npm name, it bundles all internal code (only
`zod` as a regular dependency, `react` as an optional peer), so switching to
`npm install @restow-backup/cicd-updater@1.0.0` later is a change of the install source,
not of any import. When the maintainer sets up npm trusted publishing (OIDC, no
long-lived token) for this repository and package, the release workflow publishes with
provenance; until then the publish job is skipped with a notice.

### 10.3 Versioning policy

SemVer for the whole repository (one version for image, SDK, actions, schemas).

Covered by the 1.x stability promise (breaking changes only in 2.0):

| Contract | Promise |
| --- | --- |
| `release.json` schema 1 | readers accept every valid 1.x document; new optional fields only |
| Feed index schema 1 | same |
| `updater.yaml` `version: 1` | keys keep their meaning and defaults; new optional keys only; a default that weakens security never changes |
| Env overrides (`CICD_UPDATER_*`) | as the keys |
| HTTP API `/v1` and the public status | additive only (6.6) |
| Failure, message, blocker, warning and problem codes | never removed or renamed in 1.x; new codes are minor |
| Outcomes and phases | fixed for 1.x |
| SDK public exports (7.1–7.7) | SemVer |
| CLI commands, flags and exit codes (appendix A) | SemVer |
| Action inputs and outputs (10.6) | SemVer |
| Labels `io.github.restow-backup.cicd-updater.*` | fixed |

Not covered: `status.json` (internal, migrated forward), log texts, the maintenance page's
HTML/CSS, internal packages, timing of polls, the exact cosign/Docker CLI versions in the
image (updated in patch or minor releases).

Compatibility across components: a sidecar 1.x accepts `release.json` documents produced by
any 1.x action; an SDK 1.x talks to any sidecar 1.x (feature detection via `api.features`).

### 10.4 Branches and changelog

`main` is always releasable; releases are annotated tags `vX.Y.Z` on `main`. `CHANGELOG.md`
follows Keep a Changelog; the release workflow refuses a tag without a dated section for its
version, and refuses when `package.json` versions differ from the tag.

### 10.5 Release process of the project itself (dogfooding)

`.github/workflows/release.yml`, on `push` of `v*` tags:

```
verify ──▶ ci (reusable: lint, typecheck, unit, schema drift) ──┐
  tag annotated, on main, CHANGELOG, versions                   │
                                                                 ▼
build (amd64 and arm64 on native runners, uses ./actions/build, push by digest, untagged)
                                                                 ▼
e2e-smoke (the e2e core scenarios against the built digests, both architectures)
                                                                 ▼
publish (uses ./actions/publish: index, tag X.Y.Z, cosign keyless, SBOM attestation)
                                                                 ▼
release-json (uses ./actions/release-json: release.json with image "updater", bundle,
              SDK tarball, schemas, OpenAPI, SHA256SUMS + bundle; publishes the draft release)
                                                                 ▼
npm (optional: trusted publishing with provenance, skipped when not configured)
                                                                 ▼
verify-release (fresh runner: cosign verify of the image with the exact identity,
                verify-blob of SHA256SUMS and release.json, `docker run <image> version`,
                `cicd-updater release verify` of its own release.json)
```

The cicd-updater project uses its own actions from the same commit (`uses: ./actions/...`),
so a release cannot ship actions that fail on themselves. The sidecar never updates
itself; adopters update it by hand after verifying it (`docs/upgrading-the-updater.md`).

### 10.6 Release actions: inputs and outputs

All actions are composite actions with steps pinned by SHA; `cosign-version` defaults to the
version pinned in the sidecar image of the same release.

| Action | Inputs (default) | Outputs |
| --- | --- | --- |
| `build` | `image` (req, repository), `context` (`.`), `file` (`Dockerfile`), `target`, `platforms` (`linux/amd64,linux/arm64`), `build-args`, `version` (from the tag via `tag-pattern`), `tag-pattern` (`v{version}`), `registry`, `username`, `password` | `digest` (per platform build: the manifest digest), `metadata` |
| `smoke` | `compose-files` (req), `env-example` (`.env.example`), `images` (req, JSON `{key: {repository, digest}}`), `image-vars` (req, JSON `{key: VAR}`), `health-url` (req), `health-version-path`, `expect-version`, `upgrade-from` (`previous` \| `none` \| a version; `previous` = newest earlier release), `updater-config` (path, enables the upgrade test with the sidecar), `timeout-seconds` (`600`) | `report` (Markdown path) |
| `publish` | `images` (req, JSON `{key: {repository, digests: [per-platform digests]}}`), `version` (req), `extra-tags` (none), `signing` (`keyless` on GitHub/GitLab, else req), `cosign-key`, `cosign-password`, `transparency-log` (`false` for `key`), `sbom` (`true`), `refuse-existing` (`true`) | `images` (JSON `{key: {repository, tag, digest, platforms}}` with index digests) |
| `release-json` | `images` (req, output of `publish`), `version`, `tag`, `policy-file` (`.cicd-updater/release-policy.yaml`), `notes-url`, `signing`, `cosign-key`, `cosign-password`, `transparency-log`, `release-host` (`github` \| `gitea` \| `gitlab` \| `none`), `api-url` (Forgejo/Gitea/GitLab base), `token`, `publish-release` (`true`) | `path`, `sha256` |
| `release` | union of the above for a single-job QEMU build | `images`, `sha256` |

`smoke` performs, in order: (1) every `${VAR}` referenced in the Compose files appears in
`env-example` (commented lines count); (2) starts the project from the Compose files with an
env file derived from `env-example` **as written** (empty optional values stay empty,
because that is what production gets) plus the image variables, with a scratch database,
without restart policies so a crash stays visible; (3) waits for `health-url` (and the
version); (4) with `upgrade-from`, starts the previous release first, then updates it to
the new digests (with `updater-config`: through the sidecar itself, in `none` mode with
`acknowledgeUnsigned`, reading a generated `release.json` from a `file` feed, because the
images are signed only after the smoke passed); (5) tears everything down, also on failure. Nothing is pushed,
tagged or published when it fails.

`release-policy.yaml` (committed in the app repository, part of the tagged source, so it is
reviewed with the code):

```yaml
minimumFromVersion: 1.2.0      # or null
requiresUpdater: ">=1.0.0"
requiresEnv: [NOTES_SEARCH_URL]
manualSteps:
  required: false
  summary: null
  url: null
```

The `release` CLI (`docker run ghcr.io/restow-backup/cicd-updater:<v> release <command>`)
offers the same functions for GitLab CI and others: `release env-check`,
`release json create|validate|sign|verify`, `release sign-images`, `release upload`,
`release smoke`.

### 10.7 CI of the project

| Job | Content | When |
| --- | --- | --- |
| `lint` | Biome check, actionlint on workflows, shellcheck on scripts | every push/PR |
| `typecheck` | `tsc -b` for all packages | every push/PR |
| `unit` | Vitest; engine scenarios with fakes (all failure codes, rollback table 5.6, resume table 5.8, lock), env file byte-exactness (property tests), redactor, SSRF guard (fake DNS), feed providers (fake servers), config validation, CLI; coverage gate 90 % lines for `engine` and `protocol` | every push/PR |
| `schemas` | regenerate JSON Schemas and OpenAPI; fail on drift; validate examples and fixtures against them | every push/PR |
| `image` | build the sidecar image for both platforms; verify pinned tool checksums; image smoke (`version`, `config check` of the examples) | every push/PR |
| `e2e` | real Docker: local distribution registry, stub app (versions that migrate, never become ready, crash, report a wrong version, lack an image), Postgres/MySQL/volume backups, the sidecar container; scenarios below | every push/PR (core), nightly (full matrix) |
| `e2e-keyless` | sign stub images keyless with the workflow's own OIDC identity, configure the sidecar with that identity, positive path and wrong-identity rejection | pushes to `main` and tags (not PRs from forks) |
| `e2e-forgejo` | Forgejo container: built-in registry (push, `key` signing, verification, required token scope), releases API feed | nightly; result recorded in `docs/compatibility.md` |
| `e2e-containerd` | Docker with the containerd image store | nightly |
| `examples` | each example: build v1 and v2 locally, update v1 → v2 through the sidecar, check the outcome | every push/PR |
| `codeql` / dependency review | static analysis, dependency diff | PRs |

E2E scenarios (each asserts state, env file bytes, container IDs, database content and that
no response contains the token): authentication and public status; unsigned release refused
in `keyless` and `key` mode (`fetch.signature_missing`, `unchanged`); tampered `release.json`
refused; service-swap attempt (digests exchanged in an unsigned copy) refused; `key` mode
positive path; `none` mode recorded and shown; success with PostgreSQL backup restored into a
scratch database; digest mismatch; pull failure with auth vs not-found classification;
health failure before migrations → `rolled_back`, env file byte-identical; crash loop fails
fast; failure after migrations → `needs_attention` with recovery commands that work when
executed; separate `migrate` hook failing; quiesced volume backup; MySQL backup; optional
image missing from release keeps the service; below minimum version, manual steps,
`requires.env` and `requires.updater` refusals; abort during backup; cancel and reschedule;
sidecar killed during health → `interrupted`/`needs_attention`; killed during fetch →
`unchanged`; missed start; multiple sidecars blocker; published port blocker; updater image
following a writable key blocker; image pruning keeps the rollback image; backup retention by
count and age with the protected backup.

---

## 11. Examples to ship

Each example is a complete, runnable project directory with a README that walks from
"clone" to "first update", and is exercised by the `examples` CI job.

| | `node-postgres` | `python-postgres` | `static-site` |
| --- | --- | --- | --- |
| App | TypeScript HTTP server + background worker | FastAPI | static HTML served by nginx |
| Database | PostgreSQL 17 | PostgreSQL 17 | none |
| Migrations | node-pg-migrate, run by `hooks.migrate` | Alembic, at container start | – |
| Integration level | 3: admin page using the SDK client, `syncJournal`, `createTokenVerifier`, React banner and progress | 2: admin endpoint calling the HTTP API with `httpx`; journal ingestion in SQL | 1: CLI only; maintenance page served by the sidecar |
| Release workflow | GitHub Actions, `signing: keyless`, native arm64 runner, smoke with `upgrade-from: previous` through the sidecar | Forgejo Actions, `signing: key` (cosign key pair as Actions secrets), Forgejo container registry, `release-host: gitea` | GitHub Actions, single-job `actions/release` (QEMU), `signing: keyless`; plus `ci-alternatives/gitlab-ci.yml` (keyless with `SIGSTORE_ID_TOKEN`) |
| Trust config | `keyless.github` | `key.publicKeyFiles` | `keyless.github` |
| Backup | `postgres` | `postgres` with `encryption.ageRecipients` | `none` |
| Migration probe | `postgres`, preset `node-pg-migrate`, fingerprint on | `postgres`, preset `alembic` | – |
| Rollback | `probe` | `probe` | `always` |
| Health | `http://api:3000/healthz`, version for the token only | `http://api:8000/health` with a `conditions` entry | `http://web:8080/version.json`, `$.version` |
| Smoke | `http://web:8080/` and `http://web:8080/api/ping` | `http://api:8000/docs` status 200 | `http://web:8080/` contains the product name |
| Edge | Caddy with the maintenance fallback | nginx with the maintenance fallback | nginx (the site itself) |

Every example contains: `docker-compose.yml` (with the opt-in `updater` profile as in 2.6),
`.env.example` (every variable the Compose files reference, optional ones commented),
`updater.yaml`, `.cicd-updater/release-policy.yaml`, the release workflow, the edge
configuration for the maintenance page (Caddy `handle_errors`, nginx `error_page` with an
internal location, Traefik `errors` middleware snippet in the docs), and a `Makefile`/script
target `update-demo` that builds two versions locally and runs an update in `none` mode
against a local registry (clearly marked as a demo of the mechanics, not a production
setting).

---

## 12. Documentation plan

### 12.1 README.md

1. One-paragraph description: signed, self-service updates for apps run with Docker Compose,
   from a button in the app or a command on the host.
2. Why: manual updates are error-prone; ad-hoc update scripts guess; this kit verifies what
   it installs, backs up first, rolls back only when it is certain, and tells you exactly
   what to do when it is not.
3. How it works: the three sides with the diagram from 2.1 (short form).
4. Quick start (10 minutes): add the release workflow, add the `updater` service and
   `updater.yaml`, verify the sidecar image with cosign, `docker compose --profile updater
   up -d`, `docker compose exec updater cicd-updater doctor`, schedule an update with the
   CLI.
5. Compatibility summary (link to `docs/compatibility.md`).
6. Security note, prominent: the sidecar holds the Docker socket, which is root on the
   host; it is opt-in, internal-only, pinned, and installs only signed releases (link to
   `docs/security.md`, `docs/trust-modes.md`).
7. Links: docs, examples, API reference, SDK reference, SECURITY.md, CONTRIBUTING.md,
   license (Apache-2.0, Copyright IT Systeme Flores UG (haftungsbeschränkt)).

### 12.2 `docs/`

| Page | Content |
| --- | --- |
| `index.md` | map of the documentation |
| `getting-started.md` | the quick start in detail, for each integration level |
| `concepts.md` | sides, release document, trust modes, runs, phases, outcomes, PONR, in plain words |
| `architecture.md` | components, data flow, volumes, networks (from section 2) |
| `design.md` | this specification |
| `release-side.md` | the actions, the workflow templates, release policy file, smoke test, immutability |
| `release-json.md` | schema reference with examples and validation rules |
| `feeds.md` | GitHub, Forgejo/Gitea, GitLab, static index; private repositories and tokens |
| `configuration.md` | full `updater.yaml` reference and env overrides |
| `trust-modes.md` | keyless/key/none on both sides, identities for GitHub/GitLab/generic, key rotation, risks of `none` |
| `hooks.md` | backup types, migration probe presets and fingerprint, separate migrations, health, smoke |
| `state-machine.md` | steps, failure codes, rollback rule, resume, with diagrams |
| `http-api.md` | rendered OpenAPI with examples, problem types, journal ingestion |
| `sdk.md` | client, feed check, token verifier, semver, messages, error handling |
| `react.md` | components and hooks, styling, i18n |
| `cli.md` | every command, flags, exit codes |
| `maintenance-page.md` | public status, edge configuration for Caddy/nginx/Traefik, branding |
| `security.md` | security model, hardening checklist, secrets, what is verified |
| `threat-model.md` | section 8.5 in full |
| `compatibility.md` | the matrix, with the recorded e2e results and dates |
| `registries.md` | registry specifics: auth files, mirrors and `cosign copy`, self-hosted quirks |
| `ci/github.md`, `ci/gitlab.md`, `ci/forgejo.md` | step-by-step per CI, repository protections |
| `backups-and-recovery.md` | retention, encryption, restoring each backup type, the `needs_attention` runbook |
| `troubleshooting.md` | every failure code and blocker with cause and remedy; registry auth vs not found; `doctor` output |
| `upgrading-the-updater.md` | verifying and pinning a new sidecar image, compatibility between versions |
| `app-integration.md` | the app's jobs (7.6) with code for TypeScript and Python |
| `versioning.md` | the stability promise (10.3) |
| `faq.md` | why not Watchtower-style auto-updates, why no Kubernetes, why the socket, why not self-update |
| `adr/` | decision records: one per decision of section 0 |

### 12.3 Repository files

- `CHANGELOG.md`: Keep a Changelog, sections per version, `Unreleased` on top; every
  contract change (10.3) named explicitly.
- `CONTRIBUTING.md`: development setup (Node 24, pnpm, Docker for e2e), test commands,
  coding rules (no shell strings, codes not prose, state before side effect), how to add a
  failure code or config key (protocol first, schemas regenerated, docs updated), commit
  sign-off/contribution terms (Q8), security issues not as public issues.
- `SECURITY.md`: section 8.8.
- `CODE_OF_CONDUCT.md`: Contributor Covenant 2.1 (optional; recommended for a public project).
- `LICENSE`: Apache License 2.0 text.
- `NOTICE`:

```
cicd-updater
Copyright 2026 IT Systeme Flores UG (haftungsbeschränkt)

This product includes software developed by IT Systeme Flores UG (haftungsbeschränkt),
in part derived from Restow (https://github.com/restow-backup/restow), Apache License 2.0.

The container image bundles third-party software under their own licenses
(Docker CLI, Docker Compose, Docker Buildx, cosign, age, Node.js, Alpine Linux packages);
see /usr/share/doc/cicd-updater/THIRD_PARTY_NOTICES in the image.
```

---

## 13. Migration path for Restow

Restow's updater (0.1.x) is the origin of this design; 1.0 keeps its behaviour wherever it
is generic. Restow adopts the library in later versions with identical behaviour, proven by
porting Restow's engine scenario tests to a Restow-shaped configuration fixture and by
running Restow's genuine-image e2e against the cicd-updater sidecar.

### 13.1 Mapping

| Restow 0.1 | cicd-updater 1.0 |
| --- | --- |
| `ROLE=updater` inside the Restow image, profile `updater` | service `updater` with image `ghcr.io/restow-backup/cicd-updater:<v>@sha256:...`, profile `updater` kept |
| `RESTOW_UPDATER_IMAGE` (own pinned image) | the `updater` service's `image:` (digest-pinned) |
| `RESTOW_PROJECT_DIR` / `RESTOW_UPDATER_PROJECT_DIR` | `CICD_UPDATER_COMPOSE__PROJECT_DIR` (`compose.projectDir`) |
| `RESTOW_UPDATER_PROJECT_NAME`, `RESTOW_UPDATER_COMPOSE_FILE` | `compose.projectName`, `compose.files` |
| `RESTOW_UPDATER_PORT`, `_STATE_DIR`, `_SHARED_DIR`, `_DOCKER_SOCKET` | `server.listen`, `state.dir`, `auth.sharedDir`, `docker.socket` |
| shared secret `/updater-shared/secret` (`0600`, api runs as root) | `/shared/token` (`0640`, `auth.tokenGroupId` for a non-root api); api reads it with the SDK |
| `RESTOW_IMAGE`, `RESTOW_WEB_IMAGE` (the only writable keys) | `services[].imageVar` with the same key names |
| api, worker, scheduler, caddy; stop worker+scheduler; up api; wait; up workers; up caddy last | `api` (order 1, `stopBeforeUpdate: false`), `worker`, `scheduler` (order 2, `stopBeforeUpdate: true`), `caddy` (order 3, `stopBeforeUpdate: false`, `stopOnAttention: false`) |
| digest lines in release notes (`restow: sha256:...`, `restow-web`, `-community` variants) | `release.json` images `restow`, `restow-web`, `restow-community`, `restow-web-community`; `updater.yaml` of a Community installation maps services to the `-community` keys |
| `RESTOW_IMAGE_VARIANT` (full/community) | which image keys `updater.yaml` maps (generated per variant by Restow's docs/templates) |
| `RESTOW_UPDATER_IMAGE_REPOSITORY`, `_WEB_IMAGE_REPOSITORY` | `images.<key>.repository` |
| keyless identity `restow-backup/restow` `release.yml@refs/tags/v<version>` | `trust.keyless.github: { repository: restow-backup/restow, workflow: .github/workflows/release.yml }` |
| `RESTOW_UPDATER_VERIFY_SIGNATURES=false` | `trust.mode: none` + `none.acknowledgeUnsigned: true` |
| `RESTOW_UPDATER_COSIGN_IMAGE`, `RESTOW_UPDATER_CLI_IMAGE`, helper containers | bundled in the sidecar image; no runtime pulls from Docker Hub |
| `pg_dump -Fc` via `compose exec postgres`, three dumps kept | `hooks.backup: { type: postgres, service: postgres }`, `retention: { keep: 3, maxAgeDays: 0 }` (or adopt the new age limit) |
| Drizzle migration count before/after, api frozen first | `hooks.migrationProbe: { type: postgres, service: postgres, preset: drizzle }` (+ fingerprint), `rollback.policy: probe` |
| `/readyz` with version for the secret; 503 with only worker/scheduler missing counts as "api up" | `hooks.health.http`: an api-only readiness answer (small Restow change: a query flag or path that ignores worker/scheduler) with `versionJsonPath: $.version`, `sendToken: true`; full `/readyz` 200 as a smoke check after all groups |
| `RESTOW_UPDATER_HEALTH_TIMEOUT_SECONDS`, `_MIN_FREE_MB` | `hooks.health.timeoutSeconds` (600), `docker.minFreeMb` (Restow sets 1024) |
| `RESTOW_UPDATER_SOURCE_HOSTS`, source repository chosen in the web UI, token fetched from the api (`/internal/updater/source-token`) | `source.allowlist`; the build source is the configured feed repository; `source.tokenFile` (operator file); the internal token endpoint is removed. Behaviour change: the admin can still choose the *check* source in the UI, but which repository the host builds from is operator configuration |
| `POST /v1/schedule`, `/v1/cancel`, `/v1/acknowledge`, `GET /v1/state` | `POST /v1/runs`, `POST /v1/runs/{id}/cancel`, `/acknowledge`, `GET /v1/state` (client: SDK) |
| `{ code, message }` errors | `application/problem+json` |
| `GET /public/status` (Caddy `/_maintenance/status`) | `GET /public/v1/status` (Caddy route updated) |
| journal `update.started/succeeded/failed`; the api audits schedule/cancel itself | the sidecar journals all actions; Restow ingests all and stops writing its own schedule/cancel audit entries |
| lead time presets 0, 1, 5, 15, 30, 60 min | `DEFAULT_LEAD_TIMES` (same) |
| redaction of `rset_`, `rsea_`, `rsk_` tokens | `logging.redactPatterns` in Restow's `updater.yaml` |
| feed check (`features/updates/feed.ts`), settings, token storage, notifications, step-up, audit | stay in Restow; `feed.ts` is replaced by the SDK's `checkFeed`, digest-line parsing removed |
| maintenance page in Restow's design (built into the edge image) | stays in Restow; reads the public status |
| `status.json` schema 1 of Restow | not migrated: the new sidecar starts with empty history in a new volume; the old volume (with old dumps) stays until the operator removes it |

### 13.2 Order

1. A Restow release N publishes `release.json` and its bundle (cicd-updater actions) **in
   addition** to the digest lines, so in-image updaters of 0.1.x keep working.
2. Release N ships the Compose file with the cicd-updater-based `updater` service and an
   `updater.yaml` per build variant; switching is an operator step documented in N's notes
   (`manualSteps.required: false`; the old role keeps working for one release).
3. Release N+1 removes `apps/api/src/updater` and the in-image role; the api uses the SDK.
   Digest lines stay in the notes until N+2, so a late operator can still reach N+1 with the
   old updater.

---

## 14. Open questions for the maintainer

| # | Question | Recommendation |
| --- | --- | --- |
| Q1 | Final name and namespaces: `cicd-updater`, npm `@restow-backup/cicd-updater`, image `ghcr.io/restow-backup/cicd-updater`? | Keep them; check trademark and npm availability before the first tag. Use a neutral npm scope only if third-party adoption matters more than consistency with the GitHub organisation. |
| Q2 | npm at 1.0 or later? | Ship 1.0 with the release tarball (designed for it); set up npm trusted publishing (OIDC, no `NPM_TOKEN`) for this repository and publish 1.0.x as soon as it exists. |
| Q3 | Backup defaults: plaintext allowed by default, `keep: 3`, `maxAgeDays: 14`, `age` encryption optional? | Yes as specified. Stricter alternative: require either `encryption.ageRecipients` or an explicit `plaintext: accepted` when a database backup is configured; more friction, better for apps holding personal data. |
| Q4 | Level 1: CLI only, or an operator web UI in the sidecar? | CLI only in 1.0 (no extra authenticated surface next to the socket); a loopback-only web UI with its own login can follow in 1.x on demand. |
| Q5 | If the Forgejo/Gitea registry e2e fails with cosign 3's signature storage: block 1.0, add a legacy storage option, or document it as unsupported? | Do not block 1.0: document "images on Forgejo/Gitea registry: `none` or a different registry for signed images"; add a legacy storage option in 1.x only if the pinned cosign can still write and read it. |
| Q6 | GitLab (feed provider, CI template, keyless identity) in 1.0 although our CI cannot run GitLab? | Include, marked "Expected" in the matrix; the cost is small and the feed is tested with a fake server. |
| Q7 | When does Restow switch? | After 1.0: Restow publishes `release.json` in the next minor, switches the updater one minor later (13.2). |
| Q8 | Contribution terms: CLA (as Restow) or DCO? | DCO sign-off (lower barrier for an Apache-2.0 library) unless the UG wants the option to relicense cicd-updater; then reuse the Restow CLA. |

---

## Appendix A: CLI (inside the sidecar image)

`cicd-updater <command> [flags]`; commands that talk to the running sidecar use
`http://127.0.0.1:<port>` and the token file. `--json` prints machine-readable output.
Exit codes: `0` success, `1` refused or failed, `2` usage error, `3` sidecar unreachable or
unauthorized, `64` invalid configuration, `75` state directory locked.

| Command | Purpose |
| --- | --- |
| `serve` (default entrypoint) | run the sidecar |
| `version` | sidecar, API, bundled tool versions |
| `config check [--file F]` | validate offline, print effective config (redacted) and hash |
| `doctor` | check every prerequisite separately and read-only, naming file and key for each: Docker socket and Engine version, Compose project and files, env file writability, state volume, own labels and image pinning, published ports, feed reachability and token (read probe), registry credentials per managed repository (manifest read, not just login), Sigstore reachability (keyless), public keys (key), disk space. Exit `0` all good, `1` something failed, `2` nothing checkable |
| `status` | phase, run, progress, outcome, running version |
| `releases [--refresh]` | newer releases with refusals |
| `verify <version>` | dry-run verification |
| `schedule <version> [--in 15m \| --at <RFC3339>] [--source] [--yes]` | schedule (asks for confirmation unless `--yes`) |
| `reschedule [--in \| --at]`, `cancel`, `ack` | act on the current run |
| `logs [<runId>]` | redacted run log |
| `backups list`, `backups cat <file>` | list, stream one backup to stdout |
| `recover show [<runId>]` | recovery facts and commands of a `needs_attention` run |
| `recover restore-env <runId>` | write the captured previous lines of the writable keys back |
| `maintenance-page export --out <dir>` | static maintenance page for edges that serve files themselves |
| `release <subcommand>` | release-side functions for any CI (10.6) |

## Appendix B: constant scripts for commands in other containers

Data is always passed as positional parameters; the script text is constant.

```sh
# PostgreSQL dump (args: user or "", database or "", lock wait seconds, application name)
u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"
PGAPPNAME="$4" exec pg_dump -U "$u" -d "$d" -Fc --lock-wait-timeout="${3}s"

# PostgreSQL query for the probe (args: user or "", database or "", sql)
u="${1:-${POSTGRES_USER:-postgres}}"; d="${2:-${POSTGRES_DB:-$u}}"
exec psql -X -A -t -q -v ON_ERROR_STOP=1 -U "$u" -d "$d" -c "$3"

# MySQL/MariaDB dump (args: user or "", database or "", lock wait seconds, tool)
if [ -n "$1" ]; then u="$1"; p="${MYSQL_PASSWORD:-${MARIADB_PASSWORD:-}}";
else u=root; p="${MYSQL_ROOT_PASSWORD:-${MARIADB_ROOT_PASSWORD:-}}"; fi
d="${2:-${MYSQL_DATABASE:-${MARIADB_DATABASE:-}}}"
MYSQL_PWD="$p" exec "$4" -u "$u" --single-transaction --routines --triggers --events "$d"
# ($3, the lock wait, is unused for MySQL; MYSQL_PWD is deprecated upstream but still read
#  by both clients; if a future client drops it, the implementation switches to a
#  temporary option file inside the database container, mode 0600, removed after the dump.)
```

The sidecar validates user, database and tool name against strict patterns before passing
them, and wraps each script with `timeout` when the container provides it.

## Appendix C: migration probe presets

PostgreSQL / MySQL queries; the value is compared as text. With `fingerprint: true` the
value becomes `<preset value>#<fingerprint>`.

| Preset | PostgreSQL | MySQL/MariaDB |
| --- | --- | --- |
| `drizzle` | `SELECT count(*) FROM drizzle.__drizzle_migrations` | `SELECT count(*) FROM __drizzle_migrations` |
| `prisma` | `SELECT count(*) FROM _prisma_migrations` | same |
| `knex` | `SELECT count(*) FROM knex_migrations` | same |
| `alembic` | `SELECT coalesce(string_agg(version_num, ',' ORDER BY version_num), '') FROM alembic_version` | `SELECT coalesce(group_concat(version_num ORDER BY version_num), '') FROM alembic_version` |
| `django` | `SELECT count(*) FROM django_migrations` | same |
| `flyway` | `SELECT count(*) FROM flyway_schema_history` | same |
| `rails` | `SELECT count(*) FROM schema_migrations` | same |
| `golang-migrate` | `SELECT version::text || ':' || dirty::text FROM schema_migrations` | `SELECT concat(version, ':', dirty) FROM schema_migrations` |
| `node-pg-migrate` | `SELECT count(*) FROM pgmigrations` | – |
| `typeorm` | `SELECT count(*) FROM migrations` | same |
| `sequelize` | `SELECT count(*) FROM "SequelizeMeta"` | ``SELECT count(*) FROM `SequelizeMeta` `` |

Fingerprint: MD5 of the ordered list of `schema.table.column:type:nullable:default` from
`information_schema.columns` (PostgreSQL: all schemas except `pg_catalog` and
`information_schema`; MySQL: `table_schema = DATABASE()`). It detects column-level DDL that
a failed migration left behind without recording itself (relevant for MySQL/MariaDB, whose
DDL is not transactional). It does not see indexes, constraints, policies or data-only
changes; the documentation says so. A probe is exactly as good as its query: with
PostgreSQL's transactional DDL and a migration tool that commits its bookkeeping row in the
same transaction, the count presets are exact.

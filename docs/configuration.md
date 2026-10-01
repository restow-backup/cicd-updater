# Configuration

The sidecar is configured by one file, `updater.yaml`, and optionally by environment
variables that override single keys. This page explains how the file is loaded and
validated, which rules connect keys to each other, and how paths and keyless identities are
written. The [key reference](#key-reference) at the end lists every key with its type,
default and environment variable; it is generated from the schema in
`packages/protocol/src/config.ts`.

## Loading

| Aspect | Rule |
| --- | --- |
| File | the path in `CICD_UPDATER_CONFIG`; default `/etc/cicd-updater/updater.yaml`. The examples keep it in the project directory: `CICD_UPDATER_CONFIG: ${PROJECT_DIR}/updater.yaml`. |
| Format | YAML 1.2, UTF-8 (a leading byte order mark is ignored), at most 256 KiB, exactly one YAML document. |
| Not allowed | anchors and aliases, duplicate keys, unknown keys anywhere in the document. A typo must not silently disable a safety setting. |
| When | once, at the start of the process. A run never sees two configurations. |

## Precedence and environment overrides

The effective configuration is built in this order; a later source wins:

1. built-in defaults,
2. `updater.yaml`,
3. environment variables of the sidecar container.

The variable name is `CICD_UPDATER_` followed by the key path, each segment converted from
camelCase to UPPER_SNAKE_CASE, segments joined by a double underscore:

| Key | Variable |
| --- | --- |
| `compose.projectDir` | `CICD_UPDATER_COMPOSE__PROJECT_DIR` |
| `release.feed.url` | `CICD_UPDATER_RELEASE__FEED__URL` |
| `trust.key.transparencyLog` | `CICD_UPDATER_TRUST__KEY__TRANSPARENCY_LOG` |
| `hooks.backup.retention.maxAgeDays` | `CICD_UPDATER_HOOKS__BACKUP__RETENTION__MAX_AGE_DAYS` |

Every key with a name in the "Environment override" column of the reference can be set this
way: the scalar keys and the lists of strings. These cannot: `version`, `services`, `images`,
`hooks.smoke.checks`, `hooks.health.http.conditions`, `source.build`, every `argv`, every
`hooks.<name>.command` block, and lists of numbers such as `expectStatus`.

| Value | How it is written |
| --- | --- |
| boolean | `true` or `false`, nothing else |
| integer | decimal digits, optionally with a leading `-` |
| string | as is; leading and trailing white space is removed |
| list of strings | comma-separated; items are trimmed and empty items dropped (`en, de`) |
| empty value | `null` for keys that may be null, `[]` for lists, an error for every other key |

Rules:

- A variable with the prefix `CICD_UPDATER_` that does not name an overridable key is an
  error (exit code 64). The only exception is `CICD_UPDATER_CONFIG`, which names the file.
  Do not pass other variables with this prefix into the sidecar's environment. (A variable
  such as `CICD_UPDATER_IMAGE` in the examples' `.env` is fine: Compose reads it for
  interpolation, it is not part of the container's environment.)
- An override is validated like a value in the file, together with the rest of the
  configuration.
- `cicd-updater config check` names the overrides it applied, and the start log line lists
  them.

The usual override is `CICD_UPDATER_COMPOSE__PROJECT_DIR`, so that `updater.yaml` can stay
the same on every host.

## Validation

All problems are collected and printed together, one line each with the key path and the
reason. Secrets are never printed; a token file is named by its path only.

```
cicd-updater: invalid configuration in /opt/notes/updater.yaml:
  trust.keyless: keyless mode needs exactly one of github, gitlab or issuer + identityTemplate (docs/trust-modes.md)
  services.2.imageVar: WEB_IMAGE is shared with a service of image app; services share a key only with the same image
  hooks.backup: unknown key: retension
```

The sidecar then exits with code **64** and does not start its HTTP server.

Validate offline before you start or restart the sidecar:

```sh
# the file the service is configured with
docker compose run --rm --no-deps updater config check
# another file, for example a draft
docker compose run --rm --no-deps updater config check --file /opt/notes/updater.next.yaml
```

`config check` needs no Docker and no network. On success (exit code 0) it prints
`<file>: valid`, the line `configHash <sha256>`, the applied environment overrides and the
effective configuration with all defaults filled in. With `--json` it prints one object
`{ ok, file, configHash, overrides, config }`. On failure it prints the problems and exits
with **64**.

`configHash` is the SHA-256 of the canonical JSON (keys sorted) of the effective
configuration, after defaults and overrides. The same hash appears in the start log line, in
`GET /v1/config`, in every run (`run.configHash`) and in the journal event `update.started`,
so you can tell which configuration a run used.

`config check` validates the document only. It does not open the files the configuration
points to (token files, public keys, the registry auth file, the branding file) and does not
talk to Docker, the feed or a registry. `cicd-updater doctor` checks those.

## Applying changes

The configuration is read once. To apply a change, restart the sidecar when no run is in the
`running` phase (`cicd-updater status`):

| You changed | Command |
| --- | --- |
| `updater.yaml` | `docker compose --profile updater restart updater` |
| the `updater` service in the Compose file (image, environment, volumes) | `docker compose --profile updater up -d updater` |

A restart during a run interrupts it: before the point of no return the run ends
`unchanged`, after it `needs_attention` (see [restart and resume](state-machine.md#restart-and-resume)).
A scheduled run survives a restart; it starts with the configuration of the process that
executes it and records that configuration's hash.

## Writable keys

The writable keys are the distinct `services[].imageVar` values plus `env.versionVar` when it
is set. They are the only keys the sidecar ever writes, and only in the env file
`compose.envFile` (relative to `compose.projectDir`, default `.env`). The code refuses to
write any other key, independent of the configuration.

| Key | Value the sidecar writes |
| --- | --- |
| every `imageVar` | `repository:tag@sha256:<digest>` in image mode (the repository of `images.<key>.repository` when you configured a mirror), `cicd-updater.local/<project>/<imageKey>:<version>` in source mode |
| `env.versionVar` | the plain target version, for example `1.4.0` |

Only the last assignment line of each key changes. Comments, order, quoting, line endings,
`export` prefixes, a missing final newline and earlier duplicate assignments stay as they
were; a key that is absent is appended. On a rollback the captured lines are restored byte
for byte, and a key that was absent before is removed again.

The sidecar's own service must not take its image from a writable key (blocker
`updater_image_unpinned`), and a service must take its image from its `imageVar` (blocker
`compose_unsupported`). Both are checked with a Compose probe: the sidecar runs
`docker compose config` with every writable key set to
`cicd-updater-probe.invalid/<key>:probe` in the process environment and compares the
resolved images.

When `compose.envFile` is not `.env`, the sidecar passes it to Compose as `--env-file`.
List the sidecar's own Compose profile in `compose.profiles`; the profiles are passed as
`--profile` to every Compose call and appear in the recovery commands.

## Rules between keys

Besides the type of each key, these rules connect keys. Every violation is a validation
problem (exit code 64).

### Release feed

| Rule | Problem path |
| --- | --- |
| `type: file` needs `release.feed.path` and must not set `url` | `release.feed.path`, `release.feed.url` |
| every other type needs `url` and must not set `path` | `release.feed.url`, `release.feed.path` |
| `github`: `url` is exactly `https://github.com/<owner>/<repo>` | `release.feed.url` |
| `gitea`: `https://<host>[/<prefix>]/<owner>/<repo>` (at least two path segments) | `release.feed.url` |
| `gitlab`: `https://<host>/<group>[/<subgroup>...]/<project>` (two to eight path segments) | `release.feed.url` |
| no query string, except for `static` | `release.feed.url` |

Feed URLs are https only and carry no credentials or fragment. A private repository's token
goes into `release.feed.tokenFile`. See [feeds](feeds.md).

### Trust mode blocks

| Mode | Required | Not allowed |
| --- | --- | --- |
| `keyless` | exactly one identity form: `keyless.github`, `keyless.gitlab`, or `keyless.issuer` together with `keyless.identityTemplate` | `trust.key`, `trust.none` |
| `key` | `trust.key.publicKeyFiles` (1 to 5 files) | `trust.keyless`, `trust.none` |
| `none` | `trust.none.acknowledgeUnsigned: true` | `trust.keyless`, `trust.key` |

A block for an inactive mode is an error, so a leftover block cannot mislead a reader. There
is no fallback between modes; without a `trust` section the mode is `keyless`, which then
needs an identity. See [trust modes](trust-modes.md).

### Services

| Rule | Problem path |
| --- | --- |
| service names are unique | `services.<i>.name` |
| the sidecar's own service (`self.service`, when set) is not listed | `services.<i>.name` |
| services share an `imageVar` only when they share `image` | `services.<i>.imageVar` |
| `env.versionVar` differs from every `imageVar` | `env.versionVar` |

### Backup

| Rule | Problem path |
| --- | --- |
| `postgres` and `mysql` need `service` | `hooks.backup.service` |
| other types must not set `service`, `user` or `database` | `hooks.backup.service`, `hooks.backup` |
| `flavor` other than `auto` only with `mysql` | `hooks.backup.flavor` |
| `volume` needs 1 to 16 `volumes`; other types must not set `volumes` | `hooks.backup.volumes` |
| `command` needs the `command` block; other types must not set it | `hooks.backup.command` |
| `encryption.ageRecipients` only with a backup (type other than `none`) | `hooks.backup.encryption` |

### Migration probe and migrate

| Rule | Problem path |
| --- | --- |
| `postgres` and `mysql` need `service` and exactly one of `preset` or `query` | `hooks.migrationProbe.service`, `hooks.migrationProbe` |
| `query` is one `SELECT` statement (no `;` inside) | `hooks.migrationProbe.query` |
| preset `node-pg-migrate` has no MySQL query | `hooks.migrationProbe.preset` |
| types `none`, `command`, `http` must not set `service`, `preset`, `query`, `user` or `database` | `hooks.migrationProbe.service`, `hooks.migrationProbe` |
| `command` needs the `command` block, `http` the `http` block; no other type may set them | `hooks.migrationProbe.command`, `hooks.migrationProbe.http` |
| `hooks.migrate.service` is one of the managed services | `hooks.migrate.service` |

### Health, rollback, source, maintenance page

| Rule | Problem path |
| --- | --- |
| `health.type: http` needs `health.http`, `command` needs `health.command`; no other type may set them | `hooks.health.http`, `hooks.health.command` |
| `health.afterGroup` is the `startOrder` of a managed service | `hooks.health.afterGroup` |
| `rollback.policy: probe` needs a migration probe (`migrationProbe.type` other than `none`) | `rollback.policy` |
| every key of `source.build` is the `image` of a managed service | `source.build.<key>` |
| `maintenancePage.languages` other than `en` and `de` need `maintenancePage.templateDir` | `maintenancePage.languages` |

### Derived defaults

| Key | Effective value |
| --- | --- |
| `rollback.policy` not set (`null`) | `probe` when `hooks.migrationProbe.type` is not `none`, otherwise `never` |
| `hooks.backup.quiesce` with `type: volume` | always `true` (file-level copies need stopped writers) |

`config check` shows the effective values.

## Value types

The reference shows paths and URLs as `str`. They follow these rules:

| Type | Rule |
| --- | --- |
| path | absolute POSIX path (inside the sidecar container), at most 1024 characters, without `..` segments, NUL, line breaks, `:` or `,` |
| relpath | relative path inside the project directory, without `..` segments and without a leading `/` |
| url | absolute URL without user name, password or fragment. `release.feed.url` and `trust.keyless.issuer`: https only. Health, smoke and probe URLs: http or https, on the internal network |
| `server.listen` | `<IPv4>:<port>` or `[<IPv6>]:<port>`, port 1 to 65535 |
| service names | `^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$` |
| image keys (`services[].image`, `images.<key>`, `source.build.<key>`) | `^[a-z][a-z0-9-]{0,31}$` |
| env keys (`imageVar`, `versionVar`) | `^[A-Z][A-Z0-9_]{0,127}$` |
| `compose.projectName` | `^[a-z0-9][a-z0-9_-]{0,62}$` |
| database `user`, `database` | `^[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$` |
| `release.tagPattern` | contains `{version}` exactly once; other characters `[A-Za-z0-9._/-]` |
| `hooks.backup.command.image` | pinned by digest: `name[:tag]@sha256:<64 hex>` |
| `hooks.backup.encryption.ageRecipients` | `age1` followed by 58 bech32 characters (the output of `age-keygen -y`) |
| `env.redactKeyPattern`, `logging.redactPatterns` | valid regular expressions (matched case-insensitively for env keys) |
| `source.allowlist` | `host` or `host/owner/repo` (GitLab: `host/group/.../project`), lowercase |

## Value path syntax

`hooks.health.http.versionJsonPath`, `hooks.health.http.conditions[].path` and
`hooks.migrationProbe.http.jsonPath` use a restricted JSONPath:

- `$` followed by 1 to 10 segments;
- a segment is `.name` (name `^[A-Za-z_][A-Za-z0-9_-]*$`) or `[index]` (a non-negative
  integer);
- no wildcards, filters, recursion or quoting.

| Path | Body | Value |
| --- | --- | --- |
| `$.version` | `{"version": "1.4.0"}` | `1.4.0` |
| `$.checks.database` | `{"checks": {"database": "ok"}}` | `ok` |
| `$.components[0].version` | `{"components": [{"version": "2"}]}` | `2` |
| `$.version` | `{"status": "ok"}` | no value |

A missing path is "no value": a version check then counts as another version, a condition
fails, a probe fails. A version or probe value must be a string, number or boolean;
`conditions[].equals` is compared strictly (`equals: 1` does not match `"1"`).

## Keyless identity construction

In `keyless` mode the sidecar computes, per release, the exact certificate identity that must
have signed `release.json` and every image, and passes it to cosign as an exact identity
(never as a regular expression).

| Form | Settings | Issuer | Certificate identity |
| --- | --- | --- | --- |
| GitHub Actions | `keyless.github.repository`, `keyless.github.workflow` | `https://token.actions.githubusercontent.com` | `https://github.com/<repository>/<workflow>@refs/tags/<tag>` |
| GitLab CI | `keyless.gitlab.host` (default `gitlab.com`), `keyless.gitlab.project`, `keyless.gitlab.ciConfigPath` (default `.gitlab-ci.yml`) | `https://<host>` | `https://<host>/<project>//<ciConfigPath>@refs/tags/<tag>` |
| generic | `keyless.issuer`, `keyless.identityTemplate` | `issuer` | `identityTemplate` with `{tag}` and `{version}` replaced |

`<tag>` is `release.tagPattern` rendered with the target version (default `v{version}`); it
must equal the `tag` field of `release.json`. For the GitHub form the sidecar also checks the
certificate's workflow repository (`<repository>`), workflow ref (`refs/tags/<tag>`) and
trigger (`push`).

Examples for version `1.4.0` with the default tag pattern:

| Settings | Identity |
| --- | --- |
| `github: { repository: acme/notes, workflow: .github/workflows/release.yml }` | `https://github.com/acme/notes/.github/workflows/release.yml@refs/tags/v1.4.0` |
| `gitlab: { project: acme/platform/notes }` | `https://gitlab.com/acme/platform/notes//.gitlab-ci.yml@refs/tags/v1.4.0` (issuer `https://gitlab.com`) |
| `issuer: https://ci.example.com`, `identityTemplate: https://ci.example.com/acme/notes/release@{tag}` | `https://ci.example.com/acme/notes/release@v1.4.0` |

The identity template must contain `{tag}`, may contain `{version}`, and must render to
printable ASCII without spaces (at most 1024 characters). `GET /v1/state` shows the
configured identity with `<version>` in place of the version (`trust.identity`). See
[trust modes](trust-modes.md) for the release side of each form.

## Complete example

An app with an API, a worker, an edge and PostgreSQL, released by GitHub Actions. Keys that
keep their default are left out unless they are worth seeing.

```yaml
version: 1

server:
  listen: 0.0.0.0:8090              # inside the container; never publish it

auth:
  sharedDir: /shared                # the generated token: /shared/token
  tokenGroupId: 1000                # the app runs as a non-root user of group 1000

compose:
  projectDir: /opt/notes            # usually set with CICD_UPDATER_COMPOSE__PROJECT_DIR
  envFile: .env
  profiles: [updater]               # the sidecar's own profile

docker:
  registryAuthFile: /opt/notes/registry-auth.json   # an "auths" object only
  minFreeMb: 2048

release:
  feed:
    type: github
    url: https://github.com/acme/notes
  channel: stable
  tagPattern: v{version}

trust:
  mode: keyless
  keyless:
    github:
      repository: acme/notes
      workflow: .github/workflows/release.yml

services:
  - { name: api,    image: app, imageVar: APP_IMAGE, startOrder: 1 }
  - { name: worker, image: app, imageVar: APP_IMAGE, startOrder: 2 }
  - { name: web,    image: web, imageVar: WEB_IMAGE, startOrder: 3, stopBeforeUpdate: false, stopOnAttention: false }

env:
  versionVar: APP_VERSION           # receives the plain version; also a writable key

hooks:
  backup:
    type: postgres
    service: db
    retention:
      keep: 3
      maxAgeDays: 14
    # encryption:
    #   ageRecipients: [<your age1... recipient>]
  migrationProbe:
    type: postgres
    service: db
    preset: node-pg-migrate
  migrate:
    service: api
    argv: ["npm", "run", "migrate"]
  health:
    type: http
    http:
      url: http://api:3000/healthz
      versionJsonPath: $.version
      conditions:
        - { path: $.database, equals: ok }
  smoke:
    checks:
      - { type: http, url: http://web:8080/, expectStatus: [200] }
      - { type: http, url: http://web:8080/api/ping, expectStatus: [200], bodyContains: pong }

rollback:
  policy: probe

schedule:
  maxLeadSeconds: 1209600           # 14 days
  lateStartToleranceSeconds: 600

publicStatus:
  enabled: true
  showVersions: false

maintenancePage:
  enabled: true
  brandingFile: /opt/notes/maintenance/branding.json

logging:
  level: info
  format: text
```

Smaller, complete files are in the examples:
[static-site](../examples/static-site/updater.yaml) (level 1, no database),
[python-postgres](../examples/python-postgres/updater.yaml) (`key` mode, encrypted backups),
[node-postgres](../examples/node-postgres/updater.yaml) (keyless, separate migrations).

## Key reference

The tables below are generated from the schema; `pnpm generate` rewrites them and CI fails
when they drift. "required" means the key must be set (in the file or the environment);
an empty default column means the key is optional and has no default.

<!-- BEGIN GENERATED: configuration reference -->

### `version`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `version` | `1` | required |  | Must be 1. |

### `server`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `server` | object | `{}` |  |  |
| `server.listen` | str | `"0.0.0.0:8090"` | `CICD_UPDATER_SERVER__LISTEN` | Address the HTTP API listens on inside the container. |
| `server.allowPublishedPort` | bool | `false` | `CICD_UPDATER_SERVER__ALLOW_PUBLISHED_PORT` | false: a published host port on the sidecar container is the blocker api_exposed. |

### `auth`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `auth` | object | `{}` |  |  |
| `auth.tokenFile` | str \| null | `null` | `CICD_UPDATER_AUTH__TOKEN_FILE` | Operator-provided token file (for example a Compose secret); null: the sidecar generates the token. |
| `auth.sharedDir` | str | `"/shared"` | `CICD_UPDATER_AUTH__SHARED_DIR` | A generated token is written to <sharedDir>/token. |
| `auth.tokenGroupId` | int 0–2147483647 | `0` | `CICD_UPDATER_AUTH__TOKEN_GROUP_ID` | Group of the generated token file (mode 0640, owner root). |

### `state`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `state` | object | `{}` |  |  |
| `state.dir` | str | `"/state"` | `CICD_UPDATER_STATE__DIR` | Holds status.json, backups/, releases/ and src/. Must be a volume. |
| `state.historyLimit` | int 1–100 | `20` | `CICD_UPDATER_STATE__HISTORY_LIMIT` | Finished runs kept in history. |
| `state.eventLimit` | int 50–5000 | `500` | `CICD_UPDATER_STATE__EVENT_LIMIT` | Journal events kept. |

### `self`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `self` | object | `{}` |  |  |
| `self.service` | str \| null | `null` | `CICD_UPDATER_SELF__SERVICE` | The sidecar's own Compose service; null: its container label com.docker.compose.service. |

### `compose`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `compose` | object | required |  |  |
| `compose.projectDir` | str | required | `CICD_UPDATER_COMPOSE__PROJECT_DIR` | Host path of the Compose project, mounted at the same path inside the container. Required. |
| `compose.projectName` | str \| null | `null` | `CICD_UPDATER_COMPOSE__PROJECT_NAME` | null: the sidecar's own label com.docker.compose.project. |
| `compose.files` | list<str> | `[]` | `CICD_UPDATER_COMPOSE__FILES` | Files passed as -f; empty: Compose's own discovery. |
| `compose.envFile` | str | `".env"` | `CICD_UPDATER_COMPOSE__ENV_FILE` | The interpolation env file Compose reads (the only file written). |
| `compose.profiles` | list<str> | `[]` | `CICD_UPDATER_COMPOSE__PROFILES` | Profiles passed as --profile to every Compose call. |

### `docker`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `docker` | object | `{}` |  |  |
| `docker.socket` | str | `"/var/run/docker.sock"` | `CICD_UPDATER_DOCKER__SOCKET` | Docker Engine socket. |
| `docker.registryAuthFile` | str \| null | `null` | `CICD_UPDATER_DOCKER__REGISTRY_AUTH_FILE` | Docker config.json with an auths object only, used for pulls and verification. |
| `docker.minFreeMb` | int 0–100000000 | `2048` | `CICD_UPDATER_DOCKER__MIN_FREE_MB` | Free space required after the backup on the file system of the backups directory (state.dir/backups: the state volume, or a separate volume mounted there). |

### `release`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `release` | object | required |  |  |
| `release.feed` | object | required |  |  |
| `release.feed.type` | `github` \| `gitea` \| `gitlab` \| `static` \| `file` | required | `CICD_UPDATER_RELEASE__FEED__TYPE` | Feed provider. |
| `release.feed.url` | str \| null | `null` | `CICD_UPDATER_RELEASE__FEED__URL` | Repository URL, or the index URL for static; not used with file. |
| `release.feed.path` | str \| null | `null` | `CICD_UPDATER_RELEASE__FEED__PATH` | file only: directory with index.json, documents and bundles. |
| `release.feed.tokenFile` | str \| null | `null` | `CICD_UPDATER_RELEASE__FEED__TOKEN_FILE` | Token for a private repository, sent only to the feed origin. |
| `release.feed.allowPrivateNetwork` | bool | `false` | `CICD_UPDATER_RELEASE__FEED__ALLOW_PRIVATE_NETWORK` | Allow loopback/private addresses for the feed host. |
| `release.channel` | `stable` \| `beta` | `"stable"` | `CICD_UPDATER_RELEASE__CHANNEL` | stable or beta. |
| `release.tagPattern` | str | `"v{version}"` | `CICD_UPDATER_RELEASE__TAG_PATTERN` | How a version maps to the Git tag. |
| `release.cacheSeconds` | int 0–86400 | `300` | `CICD_UPDATER_RELEASE__CACHE_SECONDS` | Reuse of the release list. |
| `release.checkIntervalHours` | int 0–168 | `0` | `CICD_UPDATER_RELEASE__CHECK_INTERVAL_HOURS` | 0: the sidecar reads the feed only on request. |

### `trust`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `trust` | object | `{}` |  |  |
| `trust.mode` | `keyless` \| `key` \| `none` | `"keyless"` | `CICD_UPDATER_TRUST__MODE` | keyless, key or none; never a fallback between them. |
| `trust.keyless` | object |  |  |  |
| `trust.keyless.github` | object |  |  |  |
| `trust.keyless.github.repository` | str | required | `CICD_UPDATER_TRUST__KEYLESS__GITHUB__REPOSITORY` | owner/repo of the release workflow. |
| `trust.keyless.github.workflow` | str | required | `CICD_UPDATER_TRUST__KEYLESS__GITHUB__WORKFLOW` | .github/workflows/<file>.yml |
| `trust.keyless.gitlab` | object |  |  |  |
| `trust.keyless.gitlab.host` | str | `"gitlab.com"` | `CICD_UPDATER_TRUST__KEYLESS__GITLAB__HOST` | GitLab instance host (issuer https://<host>). |
| `trust.keyless.gitlab.project` | str | required | `CICD_UPDATER_TRUST__KEYLESS__GITLAB__PROJECT` | group[/subgroup...]/project |
| `trust.keyless.gitlab.ciConfigPath` | str | `".gitlab-ci.yml"` | `CICD_UPDATER_TRUST__KEYLESS__GITLAB__CI_CONFIG_PATH` | Path of the CI configuration in the project. |
| `trust.keyless.issuer` | str |  | `CICD_UPDATER_TRUST__KEYLESS__ISSUER` | Generic form: OIDC issuer. |
| `trust.keyless.identityTemplate` | str |  | `CICD_UPDATER_TRUST__KEYLESS__IDENTITY_TEMPLATE` | Generic form: exact identity with {tag} and optional {version}. |
| `trust.keyless.trustedRootFile` | str \| null | `null` | `CICD_UPDATER_TRUST__KEYLESS__TRUSTED_ROOT_FILE` | Sigstore trusted root JSON for air-gapped hosts. |
| `trust.key` | object |  |  |  |
| `trust.key.publicKeyFiles` | list<str> | required | `CICD_UPDATER_TRUST__KEY__PUBLIC_KEY_FILES` | PEM public keys; a signature by any of them is accepted. |
| `trust.key.transparencyLog` | bool | `false` | `CICD_UPDATER_TRUST__KEY__TRANSPARENCY_LOG` | true: signatures must also have a transparency log entry. |
| `trust.none` | object |  |  |  |
| `trust.none.acknowledgeUnsigned` | bool | `false` | `CICD_UPDATER_TRUST__NONE__ACKNOWLEDGE_UNSIGNED` | Must be true with mode none. |
| `trust.verifier` | object | `{}` |  |  |
| `trust.verifier.isolate` | bool | `true` | `CICD_UPDATER_TRUST__VERIFIER__ISOLATE` | Run cosign in an isolated sibling container. |
| `trust.verifier.workDir` | str | `"/verify"` | `CICD_UPDATER_TRUST__VERIFIER__WORK_DIR` | Volume shared read-only with the verifier. |
| `trust.verifier.timeoutSeconds` | int 10–1800 | `300` | `CICD_UPDATER_TRUST__VERIFIER__TIMEOUT_SECONDS` | Per cosign call. |

### `images`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `images` | map | `{}` |  | Optional mirror per image key of release.json. |
| `images.<key>.repository` | str | required |  | Mirror repository; signatures must have been copied (cosign copy). |

### `services`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `services` | list<object> | required |  | The managed Compose services. |
| `services[].name` | str | required |  | Compose service name. |
| `services[].image` | str | required |  | Key in release.json images. |
| `services[].imageVar` | str | required |  | Env key the service takes its image from (a writable key). |
| `services[].startOrder` | int 1–9 | `1` |  | Start group, ascending. |
| `services[].stopBeforeUpdate` | bool | `true` |  | Stopped in the stop step (writers such as workers). |
| `services[].stopOnAttention` | bool | `true` |  | Stopped when the run ends in needs_attention. |
| `services[].optional` | bool | `false` |  | A release without this image key leaves the service as it is. |
| `services[].health` | object \| object \| null | `null` |  | Extra per-service check. |

### `env`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `env` | object | `{}` |  |  |
| `env.versionVar` | str \| null | `null` | `CICD_UPDATER_ENV__VERSION_VAR` | Env key that receives the plain target version (a writable key). |
| `env.redactKeyPattern` | str | `"(PASSWORD|PASSWD|SECRET|TOKEN|KEY|CREDENTIAL|PRIVATE|DSN)"` | `CICD_UPDATER_ENV__REDACT_KEY_PATTERN` | Values of matching env keys are registered for redaction. |

### `hooks`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `hooks` | object | `{}` |  |  |
| `hooks.backup` | object | `{}` |  |  |
| `hooks.backup.type` | `none` \| `postgres` \| `mysql` \| `volume` \| `command` | `"none"` | `CICD_UPDATER_HOOKS__BACKUP__TYPE` | Backup taken before the update. |
| `hooks.backup.service` | str |  | `CICD_UPDATER_HOOKS__BACKUP__SERVICE` | Database service (postgres, mysql). |
| `hooks.backup.user` | str \| null | `null` | `CICD_UPDATER_HOOKS__BACKUP__USER` | null: the container's own env (POSTGRES_USER; MySQL: root). |
| `hooks.backup.database` | str \| null | `null` | `CICD_UPDATER_HOOKS__BACKUP__DATABASE` | null: POSTGRES_DB / MYSQL_DATABASE / MARIADB_DATABASE. |
| `hooks.backup.flavor` | `auto` \| `mysql` \| `mariadb` | `"auto"` | `CICD_UPDATER_HOOKS__BACKUP__FLAVOR` | MySQL family; auto: mariadb-dump if present, else mysqldump. |
| `hooks.backup.volumes` | list<str> | `[]` | `CICD_UPDATER_HOOKS__BACKUP__VOLUMES` | volume: Compose volume names (project prefix resolved). |
| `hooks.backup.quiesce` | bool | `false` | `CICD_UPDATER_HOOKS__BACKUP__QUIESCE` | Stop before the backup (forced true for volume). |
| `hooks.backup.command` | object |  |  |  |
| `hooks.backup.command.image` | str | required |  | Image pinned by digest. |
| `hooks.backup.command.argv` | list<str> | required |  | 1 to 64 arguments, no shell. |
| `hooks.backup.command.envKeys` | list<str> | `[]` |  | Env keys whose values are passed to the backup container. |
| `hooks.backup.command.network` | str | `"project"` |  | project: the project's default network; none; or the key of a network in the Compose file (where the database is). |
| `hooks.backup.command.outputFile` | str | `"backup.out"` |  | File the container writes into /backup. |
| `hooks.backup.lockWaitSeconds` | int 1–3600 | `120` | `CICD_UPDATER_HOOKS__BACKUP__LOCK_WAIT_SECONDS` | PostgreSQL --lock-wait-timeout. |
| `hooks.backup.encryption` | object | `{}` |  |  |
| `hooks.backup.encryption.ageRecipients` | list<str> | `[]` | `CICD_UPDATER_HOOKS__BACKUP__ENCRYPTION__AGE_RECIPIENTS` | age1... public keys; the verified backup is encrypted. |
| `hooks.backup.retention` | object | `{}` |  |  |
| `hooks.backup.retention.keep` | int 1–50 | `3` | `CICD_UPDATER_HOOKS__BACKUP__RETENTION__KEEP` | Newest backups kept. |
| `hooks.backup.retention.maxAgeDays` | int 0–3650 | `14` | `CICD_UPDATER_HOOKS__BACKUP__RETENTION__MAX_AGE_DAYS` | Older backups are deleted; 0: no age limit. |
| `hooks.backup.timeoutSeconds` | int 60–86400 | `7200` | `CICD_UPDATER_HOOKS__BACKUP__TIMEOUT_SECONDS` | For creating the backup. |
| `hooks.backup.verifyTimeoutSeconds` | int 60–86400 | `1800` | `CICD_UPDATER_HOOKS__BACKUP__VERIFY_TIMEOUT_SECONDS` | For verifying the backup. |
| `hooks.migrationProbe` | object | `{}` |  |  |
| `hooks.migrationProbe.type` | `none` \| `postgres` \| `mysql` \| `command` \| `http` | `"none"` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__TYPE` | How the schema state is read before and after the update. |
| `hooks.migrationProbe.service` | str |  | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__SERVICE` | Database service (postgres, mysql). |
| `hooks.migrationProbe.user` | str \| null | `null` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__USER` | As in hooks.backup. |
| `hooks.migrationProbe.database` | str \| null | `null` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__DATABASE` | As in hooks.backup. |
| `hooks.migrationProbe.preset` | `drizzle` \| `prisma` \| `knex` \| `alembic` \| `django` \| `flyway` \| `rails` \| `golang-migrate` \| `node-pg-migrate` \| `typeorm` \| `sequelize` \| null | `null` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__PRESET` | Query of a migration tool (docs/hooks.md); exclusive with query. |
| `hooks.migrationProbe.query` | str \| null | `null` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__QUERY` | One SELECT returning one value; exclusive with preset. |
| `hooks.migrationProbe.fingerprint` | bool | `true` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__FINGERPRINT` | Append a hash of the schema catalog (columns) to the value. |
| `hooks.migrationProbe.command` | object |  |  |  |
| `hooks.migrationProbe.command.service` | str | required |  | Runs with docker compose exec -T. |
| `hooks.migrationProbe.command.argv` | list<str> | required |  | 1 to 64 arguments, no shell. |
| `hooks.migrationProbe.http` | object |  |  |  |
| `hooks.migrationProbe.http.url` | str | required | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__HTTP__URL` | GET with the token. |
| `hooks.migrationProbe.http.jsonPath` | str | required | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__HTTP__JSON_PATH` | Path of the value in the JSON body. |
| `hooks.migrationProbe.timeoutSeconds` | int 1–600 | `60` | `CICD_UPDATER_HOOKS__MIGRATION_PROBE__TIMEOUT_SECONDS` | Per probe. |
| `hooks.migrate` | object \| null | `null` |  | Optional separate migration run before the services start. |
| `hooks.migrate.service` | str | required | `CICD_UPDATER_HOOKS__MIGRATE__SERVICE` | A managed service whose new image runs the command. |
| `hooks.migrate.argv` | list<str> | required |  | 1 to 64 arguments, no shell. |
| `hooks.migrate.timeoutSeconds` | int 10–86400 | `1800` | `CICD_UPDATER_HOOKS__MIGRATE__TIMEOUT_SECONDS` | For the migration run. |
| `hooks.health` | object | `{}` |  |  |
| `hooks.health.type` | `none` \| `http` \| `command` | `"none"` | `CICD_UPDATER_HOOKS__HEALTH__TYPE` | The app check; none gives the warning health_without_app_check. |
| `hooks.health.http` | object |  |  |  |
| `hooks.health.http.url` | str | required | `CICD_UPDATER_HOOKS__HEALTH__HTTP__URL` | http(s) URL on the internal network. |
| `hooks.health.http.sendToken` | bool | `true` | `CICD_UPDATER_HOOKS__HEALTH__HTTP__SEND_TOKEN` | Send Authorization: Bearer <token> (the app may reveal its version). |
| `hooks.health.http.expectStatus` | list<int 100–599> | `[200]` |  | Accepted statuses. |
| `hooks.health.http.versionJsonPath` | str \| null | `null` | `CICD_UPDATER_HOOKS__HEALTH__HTTP__VERSION_JSON_PATH` | Path of the version in the JSON body; null: no version check. |
| `hooks.health.http.conditions` | list<object> | `[]` |  | { path, equals } pairs that must hold in the body. |
| `hooks.health.http.conditions[].path` | str | required |  | Path in the JSON body. |
| `hooks.health.http.conditions[].equals` | str \| number \| bool \| null | required |  | Value the path must hold. |
| `hooks.health.http.requestTimeoutSeconds` | int 1–60 | `5` | `CICD_UPDATER_HOOKS__HEALTH__HTTP__REQUEST_TIMEOUT_SECONDS` | Per request. |
| `hooks.health.command` | object |  |  |  |
| `hooks.health.command.service` | str | required |  | Runs with docker compose exec -T; exit 0 is healthy. |
| `hooks.health.command.argv` | list<str> | required |  | 1 to 64 arguments, no shell. |
| `hooks.health.command.versionFromStdout` | bool | `false` |  | The first line of stdout is the version. |
| `hooks.health.afterGroup` | int 1–9 \| null | `null` | `CICD_UPDATER_HOOKS__HEALTH__AFTER_GROUP` | Start group after which the app check runs first; null: the lowest. |
| `hooks.health.intervalSeconds` | int 1–60 | `2` | `CICD_UPDATER_HOOKS__HEALTH__INTERVAL_SECONDS` | Between polls. |
| `hooks.health.timeoutSeconds` | int 10–7200 | `600` | `CICD_UPDATER_HOOKS__HEALTH__TIMEOUT_SECONDS` | Per wait. |
| `hooks.health.versionMismatchLimit` | int 1–20 | `3` | `CICD_UPDATER_HOOKS__HEALTH__VERSION_MISMATCH_LIMIT` | Healthy answers with another version before health.version_mismatch. |
| `hooks.health.crashLimit` | int 1–10 | `2` | `CICD_UPDATER_HOOKS__HEALTH__CRASH_LIMIT` | Restarting/exited observations before health.crashed. |
| `hooks.health.waitForDockerHealth` | `auto` \| `always` \| `never` | `"auto"` | `CICD_UPDATER_HOOKS__HEALTH__WAIT_FOR_DOCKER_HEALTH` | auto: wait for healthy where a Docker healthcheck exists. |
| `hooks.health.servicesGraceSeconds` | int 5–600 | `60` | `CICD_UPDATER_HOOKS__HEALTH__SERVICES_GRACE_SECONDS` | For all managed services to be running after the last group. |
| `hooks.smoke` | object | `{}` |  |  |
| `hooks.smoke.checks` | list<object \| object> | `[]` |  | http or command checks after the app is healthy. |
| `hooks.smoke.checks[type=http].type` | `"http"` | required |  | An HTTP GET. |
| `hooks.smoke.checks[type=http].url` | str | required |  | http(s) URL on the internal network. |
| `hooks.smoke.checks[type=http].expectStatus` | list<int 100–599> | `[200]` |  | Accepted statuses. |
| `hooks.smoke.checks[type=http].bodyContains` | str \| null | `null` |  | Text the body must contain. |
| `hooks.smoke.checks[type=http].sendToken` | bool | `false` |  | Send Authorization: Bearer <token>. |
| `hooks.smoke.checks[type=command].type` | `"command"` | required |  | A command in a service container. |
| `hooks.smoke.checks[type=command].service` | str | required |  | Runs with docker compose exec -T in this service. |
| `hooks.smoke.checks[type=command].argv` | list<str> | required |  | 1 to 64 arguments, no shell. |
| `hooks.smoke.checks[type=command].expectExitCode` | int 0–255 | `0` |  | Expected exit code. |
| `hooks.smoke.retries` | int 1–20 | `5` | `CICD_UPDATER_HOOKS__SMOKE__RETRIES` | Attempts per check. |
| `hooks.smoke.intervalSeconds` | int 1–60 | `3` | `CICD_UPDATER_HOOKS__SMOKE__INTERVAL_SECONDS` | Between attempts. |
| `hooks.smoke.timeoutSeconds` | int 10–1800 | `300` | `CICD_UPDATER_HOOKS__SMOKE__TIMEOUT_SECONDS` | For all checks. |

### `rollback`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `rollback` | object | `{}` |  |  |
| `rollback.policy` | `probe` \| `always` \| `never` \| null | `null` | `CICD_UPDATER_ROLLBACK__POLICY` | null: probe when a migration probe is configured, else never. |

### `source`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `source` | object | `{}` |  |  |
| `source.allowlist` | list<str> | `[]` | `CICD_UPDATER_SOURCE__ALLOWLIST` | host or host/owner/repo, lowercase; empty: source mode off. |
| `source.tokenFile` | str \| null | `null` | `CICD_UPDATER_SOURCE__TOKEN_FILE` | Token for the archive download; null: release.feed.tokenFile. |
| `source.maxArchiveMb` | int 1–2048 | `200` | `CICD_UPDATER_SOURCE__MAX_ARCHIVE_MB` | Largest source archive. |
| `source.build` | map | `{}` |  | How each image key is built in source mode. |
| `source.build.<key>.context` | str | `"."` |  | Build context inside the archive. |
| `source.build.<key>.dockerfile` | str | `"Dockerfile"` |  | Dockerfile path. |
| `source.build.<key>.target` | str \| null | `null` |  | Dockerfile target. |
| `source.build.<key>.buildArgs` | map | `{}` |  | Build arguments; {version} is replaced. |

### `cleanup`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `cleanup` | object | `{}` |  |  |
| `cleanup.keepPreviousImages` | int 0–10 | `1` | `CICD_UPDATER_CLEANUP__KEEP_PREVIOUS_IMAGES` | Older images per repository kept besides the current and rollback image. |

### `schedule`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `schedule` | object | `{}` |  |  |
| `schedule.maxLeadSeconds` | int 0–2592000 | `1209600` | `CICD_UPDATER_SCHEDULE__MAX_LEAD_SECONDS` | Latest start a request may ask for. |
| `schedule.lateStartToleranceSeconds` | int 0–86400 | `600` | `CICD_UPDATER_SCHEDULE__LATE_START_TOLERANCE_SECONDS` | A run found later than this after startsAt is not started. |

### `timeouts`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `timeouts` | object | `{}` |  |  |
| `timeouts.pullSeconds` | int 60–14400 | `1800` | `CICD_UPDATER_TIMEOUTS__PULL_SECONDS` | Per image pull. |
| `timeouts.stopSeconds` | int 1–600 | `60` | `CICD_UPDATER_TIMEOUTS__STOP_SECONDS` | compose stop -t. |
| `timeouts.upSeconds` | int 30–3600 | `900` | `CICD_UPDATER_TIMEOUTS__UP_SECONDS` | Per compose up. |
| `timeouts.composeSeconds` | int 10–600 | `120` | `CICD_UPDATER_TIMEOUTS__COMPOSE_SECONDS` | For config, ps, logs and inspect calls. |

### `publicStatus`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `publicStatus` | object | `{}` |  |  |
| `publicStatus.enabled` | bool | `true` | `CICD_UPDATER_PUBLIC_STATUS__ENABLED` | Serve GET /public/v1/status. |
| `publicStatus.showVersions` | bool | `false` | `CICD_UPDATER_PUBLIC_STATUS__SHOW_VERSIONS` | Include versions in the public status. |

### `maintenancePage`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `maintenancePage` | object | `{}` |  |  |
| `maintenancePage.enabled` | bool | `false` | `CICD_UPDATER_MAINTENANCE_PAGE__ENABLED` | Serve the page under /public/v1/maintenance/. |
| `maintenancePage.brandingFile` | str \| null | `null` | `CICD_UPDATER_MAINTENANCE_PAGE__BRANDING_FILE` | JSON { productName, logoFile, accentColor, supportUrl }. |
| `maintenancePage.templateDir` | str \| null | `null` | `CICD_UPDATER_MAINTENANCE_PAGE__TEMPLATE_DIR` | Replaces the built-in index.html and maintenance.css. |
| `maintenancePage.languages` | list<str> | `["en","de"]` | `CICD_UPDATER_MAINTENANCE_PAGE__LANGUAGES` | Built-in: en, de; others need templateDir catalogs. |

### `logging`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `logging` | object | `{}` |  |  |
| `logging.level` | `debug` \| `info` \| `warn` \| `error` | `"info"` | `CICD_UPDATER_LOGGING__LEVEL` | Log level. |
| `logging.format` | `text` \| `json` | `"text"` | `CICD_UPDATER_LOGGING__FORMAT` | json: one object per line. |
| `logging.redactPatterns` | list<str> | `[]` | `CICD_UPDATER_LOGGING__REDACT_PATTERNS` | Extra regular expressions whose matches are replaced by [redacted]. |

### `selfCheck`

| Key | Type | Default | Environment override | Meaning |
| --- | --- | --- | --- | --- |
| `selfCheck` | object | `{}` |  |  |
| `selfCheck.enabled` | bool | `false` | `CICD_UPDATER_SELF_CHECK__ENABLED` | Report a newer sidecar release in GET /v1/state (never installs it). |

<!-- END GENERATED: configuration reference -->

## See also

- [Hooks](hooks.md): what the backup, probe, migrate, health and smoke settings run
- [Trust modes](trust-modes.md) and [feeds](feeds.md)
- [State machine](state-machine.md): how `services`, `hooks` and `rollback` shape a run
- [Troubleshooting](troubleshooting.md): blockers, warnings and failure codes

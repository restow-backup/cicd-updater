# Configuration

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
| `docker.minFreeMb` | int 0–100000000 | `2048` | `CICD_UPDATER_DOCKER__MIN_FREE_MB` | Free space required on the state file system after the backup. |

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
| `hooks.backup.command.network` | `project` \| `none` | `"project"` |  | project: the project's default network. |
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
